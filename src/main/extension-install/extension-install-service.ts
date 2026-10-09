import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import * as yauzl from 'yauzl'
import type { InstalledExtensionEntry } from '../../shared/extension-registry/types'
import { ExtensionInstallError, InvalidExtensionInstallRequestError } from './errors'

/**
 * Main-owned extension installer (download + validate + store only).
 *
 * The renderer supplies normalized identity (namespace/name/version);
 * everything else — download URL, destination paths, temp names,
 * hashes — is derived here. Exactly one metadata request plus one
 * package download per install, both single-attempt and bounded.
 * Archives extract through the vetted yauzl reader with per-entry
 * validation and hard caps; manifests are parsed as data only and
 * must match the requested identity. Installed packages are inert
 * files: nothing here loads, spawns, imports, or executes them.
 */

/** Single-attempt network bound per request (metadata + package). */
export const EXTENSION_INSTALL_TIMEOUT_MS = 30_000

/** Maximum compressed VSIX bytes accepted. */
export const EXTENSION_INSTALL_MAX_VSIX_BYTES = 50 * 1024 * 1024

/** Maximum total extracted bytes accepted. */
export const EXTENSION_INSTALL_MAX_EXTRACTED_BYTES = 200 * 1024 * 1024

/** Maximum archive entries inspected. */
export const EXTENSION_INSTALL_MAX_ENTRIES = 10_000

/** Maximum single extracted file bytes. */
export const EXTENSION_INSTALL_MAX_ENTRY_BYTES = 50 * 1024 * 1024

/** Maximum archive entry path length (code units). */
export const EXTENSION_INSTALL_MAX_PATH_LENGTH = 512

/** Maximum identity part length (namespace / name). */
export const EXTENSION_INSTALL_MAX_ID_LENGTH = 128

/** Maximum version string length. */
export const EXTENSION_INSTALL_MAX_VERSION_LENGTH = 64

/** Maximum manifest bytes parsed as JSON. */
export const EXTENSION_INSTALL_MAX_MANIFEST_BYTES = 1024 * 1024

/** Maximum installed entries surfaced by listInstalled. */
export const EXTENSION_INSTALL_MAX_LISTED = 512

/** Maximum stale staging/temp entries removed per startup pass. */
export const EXTENSION_INSTALL_MAX_CLEANUP = 32

/** Store layout knobs (all under the main-owned install root). */
export const EXTENSION_INSTALL_DIR_NAME = 'extensions'
export const EXTENSION_INSTALL_STAGING_DIR = '.staging'
export const EXTENSION_INSTALL_TMP_DIR = '.tmp'
export const EXTENSION_INSTALL_STAGING_PREFIX = '.stark-ext-staging-'
export const EXTENSION_INSTALL_TMP_PREFIX = '.stark-ext-'
export const EXTENSION_INSTALL_MANIFEST_NAME = 'stark-install.json'

const IDENTITY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const VERSION_PART = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/
const STAGING_NAME = /^\.stark-ext-staging-[0-9a-f]{32}$/
const TMP_NAME = /^\.stark-ext-[0-9a-f]{32}\.vsix$/

export interface ValidatedInstallIdentity {
  readonly namespace: string
  readonly name: string
  readonly version: string
}

/**
 * Strict identity validation (pure, testable). ASCII registry-safe
 * identifiers only, bounded length, no traversal, no separators, no
 * NUL/control characters.
 */
export function validatedInstallIdentity(value: unknown): ValidatedInstallIdentity {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidExtensionInstallRequestError()
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 3) {
    throw new InvalidExtensionInstallRequestError()
  }
  const namespace = record['namespace']
  const name = record['name']
  const version = record['version']
  if (
    typeof namespace !== 'string' ||
    typeof name !== 'string' ||
    typeof version !== 'string' ||
    namespace.length < 1 ||
    namespace.length > EXTENSION_INSTALL_MAX_ID_LENGTH ||
    name.length < 1 ||
    name.length > EXTENSION_INSTALL_MAX_ID_LENGTH ||
    version.length < 1 ||
    version.length > EXTENSION_INSTALL_MAX_VERSION_LENGTH ||
    !IDENTITY_PART.test(namespace) ||
    !IDENTITY_PART.test(name) ||
    !VERSION_PART.test(version) ||
    namespace.includes('..') ||
    name.includes('..') ||
    version.includes('..')
  ) {
    throw new InvalidExtensionInstallRequestError()
  }
  return { namespace, name, version }
}

/**
 * Download-URL allowlist: absolute HTTPS on the registry origin under
 * its API path. Applies to metadata-resolved URLs and every redirect
 * hop. Anything else normalizes to null (caller fails the install).
 */
export function validatedDownloadUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') {
    return null
  }
  if (parsed.hostname.toLowerCase() !== 'open-vsx.org') {
    return null
  }
  if (!parsed.pathname.startsWith('/api/')) {
    return null
  }
  return parsed.toString()
}

function versionMetadataUrl(identity: ValidatedInstallIdentity): string {
  const url = new URL(
    `/api/${encodeURIComponent(identity.namespace)}/${encodeURIComponent(identity.name)}/${encodeURIComponent(identity.version)}`,
    'https://open-vsx.org'
  )
  return url.toString()
}

/** Minimal fetch shape (global fetch in production, fakes in tests). */
export type InstallFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect?: 'manual' }
) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  json(): Promise<unknown>
  readonly body: unknown
}>

interface InstallMetadata {
  readonly downloadUrl: string
}

function readVersionMetadata(payload: unknown): InstallMetadata {
  if (typeof payload !== 'object' || payload === null) {
    throw new ExtensionInstallError('Registry metadata was malformed.')
  }
  const files = (payload as Record<string, unknown>)['files']
  const download =
    typeof files === 'object' && files !== null ? (files as Record<string, unknown>)['download'] : null
  const downloadUrl = validatedDownloadUrl(download)
  if (downloadUrl === null) {
    throw new ExtensionInstallError('Registry metadata was malformed.')
  }
  return { downloadUrl }
}

function parseContentLength(value: string | null): number | null {
  if (value === null || value === '') {
    return null
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null
  }
  return parsed
}

export class ExtensionInstallService {
  private readonly installRoot: string
  private readonly fetchImpl: InstallFetch
  private readonly inFlight = new Map<string, Promise<InstalledExtensionEntry>>()

  /**
   * @param installRoot main-owned `<userData>/extensions` directory
   *   (tests pass a disposable temp dir; production passes the real
   *   userData path — never a renderer-supplied location).
   */
  constructor(installRoot: string, fetchImpl?: InstallFetch) {
    this.installRoot = installRoot
    this.fetchImpl =
      fetchImpl ?? ((globalThis.fetch as unknown as InstallFetch | undefined) as InstallFetch)
  }

  /** Installs one extension by identity; concurrent duplicates share one flight. */
  async install(rawIdentity: unknown): Promise<InstalledExtensionEntry> {
    const identity = validatedInstallIdentity(rawIdentity)
    const key = `${identity.namespace}.${identity.name}@${identity.version}`
    const existing = this.inFlight.get(key)
    if (existing !== undefined) {
      return existing
    }
    const flight = this.runInstall(identity)
    this.inFlight.set(key, flight)
    try {
      return await flight
    } finally {
      if (this.inFlight.get(key) === flight) {
        this.inFlight.delete(key)
      }
    }
  }

  /** Lists installed extensions from on-disk metadata (no paths leak). */
  async listInstalled(): Promise<readonly InstalledExtensionEntry[]> {
    const collected: InstalledExtensionEntry[] = []
    let packageDirs: string[]
    try {
      packageDirs = readdirSync(this.installRoot)
    } catch {
      return []
    }
    for (const packageDir of packageDirs) {
      if (collected.length >= EXTENSION_INSTALL_MAX_LISTED) {
        break
      }
      if (packageDir.startsWith('.')) {
        continue
      }
      let versionDirs: string[]
      try {
        versionDirs = readdirSync(join(this.installRoot, packageDir))
      } catch {
        continue
      }
      for (const versionDir of versionDirs) {
        if (collected.length >= EXTENSION_INSTALL_MAX_LISTED) {
          break
        }
        if (versionDir.startsWith('.')) {
          continue
        }
        const entry = this.readInstalledEntry(join(this.installRoot, packageDir, versionDir))
        if (entry !== null) {
          collected.push(entry)
        }
      }
    }
    return collected
  }

  private readInstalledEntry(versionDir: string): InstalledExtensionEntry | null {
    const manifestPath = join(versionDir, EXTENSION_INSTALL_MANIFEST_NAME)
    let parsed: unknown
    try {
      if (statSync(manifestPath).size > EXTENSION_INSTALL_MAX_MANIFEST_BYTES) {
        return null
      }
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const record = parsed as Record<string, unknown>
    const { namespace, name, version, displayName } = record
    if (typeof namespace !== 'string' || typeof name !== 'string' || typeof version !== 'string') {
      return null
    }
    try {
      validatedInstallIdentity({ namespace, name, version })
    } catch {
      return null
    }
    if (record['source'] !== 'open-vsx') {
      return null
    }
    return {
      namespace,
      name,
      displayName: typeof displayName === 'string' && displayName !== '' ? displayName : name,
      version,
      status: 'installed'
    }
  }

  private installDirName(identity: ValidatedInstallIdentity): string {
    return `${identity.namespace}.${identity.name}`
  }

  private readCommittedEntry(identity: ValidatedInstallIdentity): InstalledExtensionEntry | null {
    const entry = this.readInstalledEntry(join(this.installRoot, this.installDirName(identity), identity.version))
    if (entry === null || entry.version !== identity.version) {
      return null
    }
    return entry
  }

  private async runInstall(identity: ValidatedInstallIdentity): Promise<InstalledExtensionEntry> {
    const committed = this.readCommittedEntry(identity)
    if (committed !== null && committed.version === identity.version) {
      return { ...committed, status: 'already_installed' }
    }
    const downloadUrl = await this.resolveDownloadUrl(identity)
    const staging = join(
      this.installRoot,
      EXTENSION_INSTALL_STAGING_DIR,
      `${EXTENSION_INSTALL_STAGING_PREFIX}${randomBytes(16).toString('hex')}`
    )
    const tmpDir = join(this.installRoot, EXTENSION_INSTALL_TMP_DIR)
    const tmpFile = join(tmpDir, `${EXTENSION_INSTALL_TMP_PREFIX}${randomBytes(16).toString('hex')}.vsix`)
    mkdirSync(staging, { recursive: true })
    mkdirSync(tmpDir, { recursive: true })
    try {
      const sha256 = await this.downloadPackage(downloadUrl, tmpFile)
      await extractVsix(tmpFile, staging)
      const manifest = readExtensionManifest(staging, identity)
      writeFileSync(
        join(staging, EXTENSION_INSTALL_MANIFEST_NAME),
        JSON.stringify(
          {
            namespace: identity.namespace,
            name: identity.name,
            displayName: manifest.displayName,
            version: identity.version,
            sha256,
            installedAt: new Date().toISOString(),
            source: 'open-vsx'
          },
          null,
          2
        ),
        'utf8'
      )
      const finalDir = join(this.installRoot, this.installDirName(identity), identity.version)
      const recheck = this.readCommittedEntry(identity)
      if (recheck !== null && recheck.version === identity.version) {
        return { ...recheck, status: 'already_installed' }
      }
      mkdirSync(join(this.installRoot, this.installDirName(identity)), { recursive: true })
      try {
        renameSync(staging, finalDir)
      } catch (error: unknown) {
        const again = this.readCommittedEntry(identity)
        if (again !== null && again.version === identity.version) {
          return { ...again, status: 'already_installed' }
        }
        throw error
      }
      return {
        namespace: identity.namespace,
        name: identity.name,
        displayName: manifest.displayName,
        version: identity.version,
        status: 'installed'
      }
    } finally {
      rmSync(staging, { recursive: true, force: true })
      rmSync(tmpFile, { force: true })
    }
  }

  private async resolveDownloadUrl(identity: ValidatedInstallIdentity): Promise<string> {
    const metadata = await this.fetchJson(versionMetadataUrl(identity))
    return readVersionMetadata(metadata).downloadUrl
  }

  private async fetchJson(url: string): Promise<unknown> {
    let response: { readonly ok: boolean; readonly status: number; json(): Promise<unknown> }
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(EXTENSION_INSTALL_TIMEOUT_MS),
        redirect: 'manual'
      })
    } catch (error: unknown) {
      throw new ExtensionInstallError('Registry request failed.', { cause: error })
    }
    if (!response.ok) {
      throw new ExtensionInstallError('Registry request failed.')
    }
    try {
      return await response.json()
    } catch (error: unknown) {
      throw new ExtensionInstallError('Registry response was malformed.', { cause: error })
    }
  }

  /**
   * Bounded package download with manual redirect validation. Every
   * hop must satisfy the download allowlist (max 3 hops); the body
   * streams through a byte counter capped at 50 MiB whether or not
   * Content-Length is present.
   */
  private async downloadPackage(url: string, tmpFile: string): Promise<string> {
    let current = url
    for (let hop = 0; hop <= 3; hop += 1) {
      const allowed = validatedDownloadUrl(current)
      if (allowed === null) {
        throw new ExtensionInstallError('Registry redirect escaped the allowlist.')
      }
      let response: {
        readonly ok: boolean
        readonly status: number
        readonly headers: { get(name: string): string | null }
        readonly body: unknown
      }
      try {
        response = await this.fetchImpl(allowed, {
          headers: { Accept: 'application/octet-stream' },
          signal: AbortSignal.timeout(EXTENSION_INSTALL_TIMEOUT_MS),
          redirect: 'manual'
        })
      } catch (error: unknown) {
        throw new ExtensionInstallError('Package download failed.', { cause: error })
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null || location === '') {
          throw new ExtensionInstallError('Registry redirect escaped the allowlist.')
        }
        try {
          current = new URL(location, allowed).toString()
        } catch {
          throw new ExtensionInstallError('Registry redirect escaped the allowlist.')
        }
        continue
      }
      if (!response.ok) {
        throw new ExtensionInstallError('Package download failed.')
      }
      const declared = parseContentLength(response.headers.get('content-length'))
      if (declared !== null && declared > EXTENSION_INSTALL_MAX_VSIX_BYTES) {
        throw new ExtensionInstallError('Package exceeds the size limit.')
      }
      return this.streamToTempFile(response.body, tmpFile)
    }
    throw new ExtensionInstallError('Registry redirect escaped the allowlist.')
  }

  private async streamToTempFile(body: unknown, tmpFile: string): Promise<string> {
    const hash = createHash('sha256')
    let bytes = 0
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        bytes += chunk.length
        if (bytes > EXTENSION_INSTALL_MAX_VSIX_BYTES) {
          callback(new ExtensionInstallError('Package exceeds the size limit.'))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      }
    })
    const source = body as NodeJS.ReadableStream | null
    if (source === null || typeof source !== 'object' || typeof (source as { pipe?: unknown }).pipe !== 'function') {
      throw new ExtensionInstallError('Package download failed.')
    }
    try {
      await pipeline(source as NodeJS.ReadableStream, counter, createWriteStream(tmpFile, { flags: 'wx', mode: 0o600 }))
    } catch (error: unknown) {
      if (error instanceof ExtensionInstallError) {
        throw error
      }
      throw new ExtensionInstallError('Package download failed.', { cause: error })
    }
    return hash.digest('hex')
  }
}

interface ValidatedManifest {
  readonly displayName: string
}

/**
 * Reads extension/package.json from a staged extraction as DATA ONLY
 * (JSON.parse + field comparison — never require/import/eval) and
 * proves name/publisher/version match the requested identity.
 */
export function readExtensionManifest(stagingDir: string, identity: ValidatedInstallIdentity): ValidatedManifest {
  const manifestPath = join(stagingDir, 'extension', 'package.json')
  let size: number
  try {
    size = statSync(manifestPath).size
  } catch {
    throw new ExtensionInstallError('Extension manifest is missing.')
  }
  if (size > EXTENSION_INSTALL_MAX_MANIFEST_BYTES) {
    throw new ExtensionInstallError('Extension manifest is missing.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  } catch {
    throw new ExtensionInstallError('Extension manifest is missing.')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ExtensionInstallError('Extension manifest is missing.')
  }
  const record = parsed as Record<string, unknown>
  if (record['name'] !== identity.name || record['publisher'] !== identity.namespace || record['version'] !== identity.version) {
    throw new ExtensionInstallError('Extension manifest is missing.')
  }
  const displayName = typeof record['displayName'] === 'string' && record['displayName'].trim() !== '' ? record['displayName'].trim() : identity.name
  return { displayName }
}

const UNIX_IFMT = 0o170000
const UNIX_IFREG = 0o100000
const UNIX_IFDIR = 0o040000

/**
 * Per-entry archive validation (pure on the name; mode checked by the
 * extractor). Rejects absolute, drive-letter, UNC, traversal,
 * separator, NUL, empty, and overlong names.
 */
export function validatedArchiveEntryPath(fileName: string): string {
  if (typeof fileName !== 'string' || fileName === '' || fileName.length > EXTENSION_INSTALL_MAX_PATH_LENGTH) {
    throw new ExtensionInstallError('Archive entry is not safe.')
  }
  if (fileName.includes('\0')) {
    throw new ExtensionInstallError('Archive entry is not safe.')
  }
  if (fileName.includes('\\')) {
    throw new ExtensionInstallError('Archive entry is not safe.')
  }
  if (fileName.startsWith('/')) {
    throw new ExtensionInstallError('Archive entry is not safe.')
  }
  if (/^[A-Za-z]:/.test(fileName)) {
    throw new ExtensionInstallError('Archive entry is not safe.')
  }
  const withoutTrailingSlash = fileName.endsWith('/') ? fileName.slice(0, -1) : fileName
  if (withoutTrailingSlash === '') {
    throw new ExtensionInstallError('Archive entry is not safe.')
  }
  for (const segment of withoutTrailingSlash.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ExtensionInstallError('Archive entry is not safe.')
    }
  }
  return fileName
}

function unixFileType(externalAttributes: number): number {
  return (externalAttributes >>> 16) & UNIX_IFMT
}

/**
 * Safe VSIX extraction through yauzl (lazy entries, validated one by
 * one). Rejects symlinks/special entries, over-count/over-size
 * archives, and anything escaping the staging directory. Regular
 * files and directories only; ownership/device metadata dropped.
 */
export async function extractVsix(archivePath: string, stagingDir: string): Promise<void> {
  const zipfile = await yauzl.openPromise(archivePath, { lazyEntries: true, strictFileNames: true })
  try {
    if (zipfile.entryCount > EXTENSION_INSTALL_MAX_ENTRIES) {
      throw new ExtensionInstallError('Archive exceeds its limits.')
    }
    let seen = 0
    let totalBytes = 0
    for (;;) {
      const entry = await readNextEntry(zipfile)
      if (entry === null) {
        break
      }
      seen += 1
      if (seen > EXTENSION_INSTALL_MAX_ENTRIES) {
        throw new ExtensionInstallError('Archive exceeds its limits.')
      }
      const name = validatedArchiveEntryPath(entry.fileName)
      const fileType = unixFileType(entry.externalFileAttributes)
      if (fileType !== 0 && fileType !== UNIX_IFREG && fileType !== UNIX_IFDIR) {
        throw new ExtensionInstallError('Archive entry is not safe.')
      }
      const dest = resolve(join(stagingDir, name))
      const base = resolve(stagingDir)
      if (dest !== base && !dest.startsWith(base + sep)) {
        throw new ExtensionInstallError('Archive entry is not safe.')
      }
      if (name.endsWith('/')) {
        mkdirSync(dest, { recursive: true })
        continue
      }
      if (entry.uncompressedSize > EXTENSION_INSTALL_MAX_ENTRY_BYTES) {
        throw new ExtensionInstallError('Archive exceeds its limits.')
      }
      totalBytes = await streamEntry(zipfile, entry, dest, totalBytes)
    }
  } finally {
    try {
      zipfile.close()
    } catch {
      // Best effort.
    }
  }
}

function readNextEntry(zipfile: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise<yauzl.Entry | null>((resolveEntry, rejectEntry) => {
    const onEntry = (entry: yauzl.Entry): void => {
      zipfile.removeListener('end', onEnd)
      zipfile.removeListener('error', onError)
      resolveEntry(entry)
    }
    const onEnd = (): void => {
      zipfile.removeListener('entry', onEntry)
      zipfile.removeListener('error', onError)
      resolveEntry(null)
    }
    const onError = (error: Error): void => {
      zipfile.removeListener('entry', onEntry)
      zipfile.removeListener('end', onEnd)
      rejectEntry(error)
    }
    zipfile.once('entry', onEntry)
    zipfile.once('end', onEnd)
    zipfile.once('error', onError)
    zipfile.readEntry()
  })
}

async function streamEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  dest: string,
  totalBytes: number
): Promise<number> {
  const stream = await zipfile.openReadStreamPromise(entry)
  const chunks: Buffer[] = []
  let fileBytes = 0
  let total = totalBytes
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer
      fileBytes += buffer.length
      total += buffer.length
      if (fileBytes > EXTENSION_INSTALL_MAX_ENTRY_BYTES || total > EXTENSION_INSTALL_MAX_EXTRACTED_BYTES) {
        try {
          stream.destroy()
        } catch {
          // Best effort.
        }
        throw new ExtensionInstallError('Archive exceeds its limits.')
      }
      chunks.push(buffer)
    }
  } catch (error: unknown) {
    if (error instanceof ExtensionInstallError) {
      throw error
    }
    throw new ExtensionInstallError('Archive entry could not be read.', { cause: error })
  }
  const parent = join(dest, '..')
  mkdirSync(parent, { recursive: true })
  writeFileSync(dest, Buffer.concat(chunks), { mode: 0o600 })
  return total
}

/**
 * Startup crash-safety: removes only directories/files matching
 * STARK's exact installer-owned staging/temp naming schemes under
 * `<userData>/extensions`, bounded per pass. Never throws, never
 * walks arbitrary trees. Returns the removed count.
 */
export function cleanupStaleInstallStaging(userDataDir: string): number {
  let removed = 0
  const scrub = (dir: string, pattern: RegExp): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (removed >= EXTENSION_INSTALL_MAX_CLEANUP) {
        return
      }
      if (!pattern.test(name)) {
        continue
      }
      try {
        rmSync(join(dir, name), { recursive: true, force: true })
        removed += 1
      } catch {
        // Best effort per entry.
      }
    }
  }
  if (typeof userDataDir !== 'string' || userDataDir === '') {
    return 0
  }
  const root = join(userDataDir, EXTENSION_INSTALL_DIR_NAME)
  scrub(join(root, EXTENSION_INSTALL_STAGING_DIR), STAGING_NAME)
  scrub(join(root, EXTENSION_INSTALL_TMP_DIR), TMP_NAME)
  return removed
}
