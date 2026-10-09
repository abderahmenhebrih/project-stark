import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import {
  cleanupStaleInstallStaging,
  EXTENSION_INSTALL_MAX_ENTRIES,
  EXTENSION_INSTALL_MAX_ID_LENGTH,
  EXTENSION_INSTALL_TIMEOUT_MS,
  ExtensionInstallService,
  extractVsix,
  readExtensionManifest,
  validatedArchiveEntryPath,
  validatedDownloadUrl,
  validatedInstallIdentity,
  type InstallFetch
} from './extension-install-service'
import { toPublicExtensionInstallError } from './errors'

/* Minimal stored-method ZIP builder for fixtures (test data only). */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c % 2 === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface FixtureEntry {
  readonly name: string
  readonly data: Buffer
  readonly unixMode?: number
}

function buildZip(entries: readonly FixtureEntry[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(entry.data.length, 18)
    header.writeUInt32LE(entry.data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    chunks.push(header, name, entry.data)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(63, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(0, 10)
    record.writeUInt16LE(0, 12)
    record.writeUInt16LE(0, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(entry.data.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += header.length + name.length + entry.data.length
  }
  const centralStart = offset
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, ...central, end])
}

function manifestJson(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({ name: 'prettier-vscode', publisher: 'esbenp', version: '12.4.0', ...overrides }),
    'utf8'
  )
}

function goodZip(): Buffer {
  return buildZip([
    { name: 'extension/package.json', data: manifestJson() },
    { name: 'extension/dist/index.js', data: Buffer.from('console.log("inert")', 'utf8') }
  ])
}

const DOWNLOAD_URL = 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/x.vsix'

function metadataFetch(calls: string[], downloadUrl: string = DOWNLOAD_URL): InstallFetch {
  return async (url: string) => {
    calls.push(url)
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ files: { download: downloadUrl } }),
      body: null
    }
  }
}

function downloadFetch(vsix: Buffer, counter: { count: number }): InstallFetch {
  return async (url: string) => {
    assert.ok(url.startsWith('https://open-vsx.org/api/'))
    counter.count += 1
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'content-length' ? String(vsix.length) : null) },
      json: async (): Promise<unknown> => ({}),
      body: Readable.from([vsix])
    }
  }
}

function combinedFetch(vsix: Buffer, metaCalls: string[], counter: { count: number }): InstallFetch {
  const meta = metadataFetch(metaCalls)
  const dl = downloadFetch(vsix, counter)
  return (url: string, init) => (url.includes('/file/') ? dl(url, init) : meta(url, init))
}

describe('install identity validation', () => {
  it('accepts registry-safe identities', () => {
    assert.deepEqual(validatedInstallIdentity({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }), {
      namespace: 'esbenp',
      name: 'prettier-vscode',
      version: '12.4.0'
    })
  })

  it('rejects traversal, separators, and malformed identities', () => {
    for (const bad of [
      null,
      {},
      { namespace: 'a', name: 'b' },
      { namespace: 'a', name: 'b', version: '1', extra: 1 },
      { namespace: '../evil', name: 'b', version: '1' },
      { namespace: 'a', name: '..', version: '1' },
      { namespace: 'a/b', name: 'b', version: '1' },
      { namespace: 'a\\b', name: 'b', version: '1' },
      { namespace: 'a', name: 'b', version: '../../1' },
      { namespace: '', name: 'b', version: '1' },
      { namespace: 'a', name: 'b', version: '' },
      { namespace: 'a\0b', name: 'b', version: '1' },
      { namespace: 'a\nb', name: 'b', version: '1' },
      { namespace: 'a'.repeat(EXTENSION_INSTALL_MAX_ID_LENGTH + 1), name: 'b', version: '1' },
      { namespace: 'C:', name: 'b', version: '1' }
    ]) {
      assert.throws(() => validatedInstallIdentity(bad), /not valid/)
    }
  })
})

describe('download URL allowlist', () => {
  it('allows only registry-origin API file URLs', () => {
    const good = 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/x.vsix'
    assert.equal(validatedDownloadUrl(good), good)
    for (const bad of [
      'http://open-vsx.org/api/x/file/x.vsix',
      'https://evil.example/x.vsix',
      'https://open-vsx.org.evil.example/api/x',
      'https://open-vsx.org/other/x.vsix',
      '/api/x/file/x.vsix',
      '',
      null
    ]) {
      assert.equal(validatedDownloadUrl(bad), null)
    }
  })
})

describe('archive entry validation', () => {
  it('accepts safe relative paths', () => {
    assert.equal(validatedArchiveEntryPath('extension/package.json'), 'extension/package.json')
    assert.equal(validatedArchiveEntryPath('extension/'), 'extension/')
  })

  it('rejects absolute, drive, traversal, and hostile names', () => {
    for (const bad of [
      '/abs/path',
      'C:/win/path',
      'C:relative',
      '\\\\UNC\\share',
      '../escape',
      'a/../../escape',
      'a/../b',
      '',
      'a\\b',
      'nul\0byte',
      'a//b'
    ]) {
      assert.throws(() => validatedArchiveEntryPath(bad), /not safe/)
    }
  })
})

describe('safe extraction', () => {
  it('extracts regular files and directories with containment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-good-'))
    try {
      const staging = join(dir, 'staging')
      mkdirSync(staging, { recursive: true })
      const archive = join(dir, 'good.vsix')
      writeFileSync(archive, goodZip())
      await extractVsix(archive, staging)
      assert.equal(readFileSync(join(staging, 'extension', 'package.json'), 'utf8'), manifestJson().toString('utf8'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects traversal archives with nothing written outside', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-evil-'))
    try {
      const archive = join(dir, 'evil.vsix')
      writeFileSync(archive, buildZip([{ name: '../evil.txt', data: Buffer.from('x', 'utf8') }]))
      const staging = join(dir, 'staging')
      mkdirSync(staging, { recursive: true })
      await assert.rejects(extractVsix(archive, staging), /not safe|invalid relative path/)
      assert.ok(!existsSync(join(dir, 'evil.txt')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects absolute, drive-letter, and symlink entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-special-'))
    try {
      const cases: ReadonlyArray<readonly [string, string, number | undefined]> = [
        ['absolute', '/abs.txt', undefined],
        ['drive', 'C:/w.txt', undefined],
        ['symlink', 'link.txt', 0o120777]
      ]
      for (const [label, name, mode] of cases) {
        const archive = join(dir, `${label}.vsix`)
        writeFileSync(archive, buildZip([{ name, data: Buffer.from('x', 'utf8'), unixMode: mode }]))
        const staging = join(dir, `staging-${label}`)
        mkdirSync(staging, { recursive: true })
        await assert.rejects(extractVsix(archive, staging), /not safe|path/)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects oversized entry counts', async () => {    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-big-'))
    try {
      const many = Array.from({ length: EXTENSION_INSTALL_MAX_ENTRIES + 1 }, (_, i) => ({
        name: `f${i}.txt`,
        data: Buffer.alloc(0)
      }))
      const archive = join(dir, 'many.vsix')
      writeFileSync(archive, buildZip(many))
      const staging = join(dir, 'staging')
      mkdirSync(staging, { recursive: true })
      await assert.rejects(extractVsix(archive, staging), /limits/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects single files over 50 MiB by header', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-bigfile-'))
    try {
      const archive = join(dir, 'big.vsix')
      writeFileSync(archive, buildZip([{ name: 'extension/big.bin', data: Buffer.alloc(51 * 1024 * 1024, 9) }]))
      const staging = join(dir, 'staging')
      mkdirSync(staging, { recursive: true })
      await assert.rejects(extractVsix(archive, staging), /limits/)
      assert.deepEqual(readdirSync(staging), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects extracted totals over 200 MiB by streamed bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-bomb-'))
    try {
      const files = Array.from({ length: 201 }, (_, i) => ({
        name: `extension/part${i}.bin`,
        data: Buffer.alloc(1024 * 1024, i % 251)
      }))
      const archive = join(dir, 'bomb.vsix')
      writeFileSync(archive, buildZip(files))
      const staging = join(dir, 'staging')
      mkdirSync(staging, { recursive: true })
      await assert.rejects(extractVsix(archive, staging), /limits/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never activates installed code', async () => {
    const { readFileSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    for (const file of ['extension-install-service.ts', 'errors.ts']) {
      const source = readFileSync(joinPath(process.cwd(), 'src', 'main', 'extension-install', file), 'utf8')
      for (const forbidden of ['activationEvents', 'child_process', 'spawn(', 'exec(', 'postinstall', 'Extension Host']) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
  })
})

describe('manifest validation', () => {
  it('requires exact identity match and never executes scripts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-manifest-'))
    try {
      const identity = { namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }
      const staging = join(dir, 'staging')
      mkdirSync(join(staging, 'extension'), { recursive: true })
      writeFileSync(join(staging, 'extension', 'package.json'), manifestJson({ scripts: { postinstall: 'touch PWNED' } }))
      const manifest = readExtensionManifest(staging, identity)
      assert.equal(manifest.displayName, 'prettier-vscode')
      assert.ok(!existsSync(join(staging, 'PWNED')))
      assert.throws(() => readExtensionManifest(staging, { ...identity, version: '9.9.9' }), /missing/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('install pipeline', () => {
  it('installs end to end with hash, commit, and cleanup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-install-'))
    try {
      const vsix = goodZip()
      const expectedSha = createHash('sha256').update(vsix).digest('hex')
      const metaCalls: string[] = []
      const downloads = { count: 0 }
      const service = new ExtensionInstallService(dir, combinedFetch(vsix, metaCalls, downloads))
      const result = await service.install({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' })
      assert.equal(result.status, 'installed')
      assert.equal(result.namespace, 'esbenp')
      const installJson = JSON.parse(
        readFileSync(join(dir, 'esbenp.prettier-vscode', '12.4.0', 'stark-install.json'), 'utf8')
      ) as Record<string, unknown>
      assert.equal(installJson['sha256'], expectedSha)
      assert.equal(installJson['source'], 'open-vsx')
      assert.ok(existsSync(join(dir, 'esbenp.prettier-vscode', '12.4.0', 'extension', 'package.json')))
      const stagingLeft = existsSync(join(dir, '.staging')) ? readdirSync(join(dir, '.staging')) : []
      assert.deepEqual(stagingLeft, [])
      const tmpLeft = existsSync(join(dir, '.tmp')) ? readdirSync(join(dir, '.tmp')) : []
      assert.deepEqual(tmpLeft, [])
      const listed = await service.listInstalled()
      assert.equal(listed.length, 1)
      assert.ok(!JSON.stringify(listed).includes(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('existing installs return already_installed without downloading', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-reinstall-'))
    try {
      const vsix = goodZip()
      const downloads = { count: 0 }
      const make = () => new ExtensionInstallService(dir, combinedFetch(vsix, [], downloads))
      const first = await make().install({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' })
      assert.equal(first.status, 'installed')
      const second = await make().install({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' })
      assert.equal(second.status, 'already_installed')
      assert.equal(downloads.count, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('concurrent duplicate installs download once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-dup-'))
    try {
      const vsix = goodZip()
      const downloads = { count: 0 }
      const service = new ExtensionInstallService(dir, combinedFetch(vsix, [], downloads))
      const identity = { namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }
      const [first, second] = await Promise.all([service.install(identity), service.install(identity)])
      assert.equal(first.status, 'installed')
      assert.equal(second.status, 'installed')
      assert.equal(downloads.count, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('manifest mismatch fails with staged extraction removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-mismatch-'))
    try {
      const vsix = buildZip([{ name: 'extension/package.json', data: manifestJson({ name: 'evil-fork' }) }])
      const service = new ExtensionInstallService(dir, combinedFetch(vsix, [], { count: 0 }))
      await assert.rejects(service.install({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }))
      assert.ok(!existsSync(join(dir, 'esbenp.prettier-vscode')))
      const stagingLeft = existsSync(join(dir, '.staging')) ? readdirSync(join(dir, '.staging')) : []
      assert.deepEqual(stagingLeft, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('redirect escapes and oversized packages are rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-bounds-'))
    try {
      const evilRedirect: InstallFetch = async () => ({
        ok: false,
        status: 302,
        headers: { get: (name: string) => (name === 'location' ? 'https://evil.example/x.vsix' : null) },
        json: async (): Promise<unknown> => ({}),
        body: null
      })
      const redirectService = new ExtensionInstallService(dir, async (url: string, init) => {
        if (url.includes('/file/')) {
          return evilRedirect(url, init)
        }
        return metadataFetch([])(url, init)
      })
      await assert.rejects(
        redirectService.install({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }),
        /escaped the allowlist/
      )
      const big: InstallFetch = async () => ({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'content-length' ? String(60 * 1024 * 1024) : null) },
        json: async (): Promise<unknown> => ({}),
        body: null
      })
      const bigService = new ExtensionInstallService(dir, async (url: string, init) => {
        if (url.includes('/file/')) {
          return big(url, init)
        }
        return metadataFetch([])(url, init)
      })
      await assert.rejects(
        bigService.install({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }),
        /exceeds the size limit/
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('streaming cap aborts bodies without Content-Length', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-stream-'))
    try {
      const { Readable } = await import('node:stream')
      let chunks = 0
      const endless = new Readable({
        read(): void {
          chunks += 1
          this.push(Buffer.alloc(1024 * 1024, 7))
          if (chunks > 60) {
            this.push(null)
          }
        }
      })
      const streaming: InstallFetch = async (url: string) => {
        if (url.includes('/file/')) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async (): Promise<unknown> => ({}),
            body: endless
          }
        }
        return metadataFetch([])(url, { headers: {}, signal: AbortSignal.timeout(1000) })
      }
      const service = new ExtensionInstallService(dir, streaming)
      await assert.rejects(
        service.install({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }),
        /exceeds the size limit/
      )
      assert.ok(chunks <= 52)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('public errors never leak internals and timeout is 30s', async () => {
    assert.equal(EXTENSION_INSTALL_TIMEOUT_MS, 30_000)
    assert.equal(toPublicExtensionInstallError(new Error('socket hang up')).message, 'We couldn’t install this extension.')
    const { ExtensionInstallError } = await import('./errors')
    assert.equal(
      toPublicExtensionInstallError(new ExtensionInstallError('Registry redirect escaped the allowlist.')).message,
      'We couldn’t install this extension.'
    )
  })
})

describe('startup staging cleanup', () => {
  it('removes only exact installer-owned names, bounded, never throws', () => {
    const userData = mkdtempSync(join(tmpdir(), 'stark-ext-clean-'))
    try {
      const staging = join(userData, 'extensions', '.staging')
      mkdirSync(staging, { recursive: true })
      mkdirSync(join(staging, `.stark-ext-staging-${'a'.repeat(32)}`))
      mkdirSync(join(staging, 'other-dir'))
      writeFileSync(join(staging, 'keep.txt'), 'x')
      const removed = cleanupStaleInstallStaging(userData)
      assert.equal(removed, 1)
      assert.ok(existsSync(join(staging, 'other-dir')))
      assert.ok(existsSync(join(staging, 'keep.txt')))
      assert.equal(cleanupStaleInstallStaging(join(userData, 'missing')), 0)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})

/* Uninstall fixtures: crafted on-disk installs (no network). */
function craftInstalled(
  root: string,
  namespace: string,
  name: string,
  version: string,
  manifest: Record<string, unknown> | null = null
): string {
  const versionDir = join(root, `${namespace}.${name}`, version)
  mkdirSync(join(versionDir, 'extension'), { recursive: true })
  writeFileSync(join(versionDir, 'extension', 'package.json'), JSON.stringify({ name, publisher: namespace, version }))
  writeFileSync(
    join(versionDir, 'stark-install.json'),
    JSON.stringify(
      manifest ?? {
        namespace,
        name,
        displayName: name,
        version,
        sha256: '0'.repeat(64),
        installedAt: '2026-01-01T00:00:00.000Z',
        source: 'open-vsx'
      }
    )
  )
  return versionDir
}

describe('safe uninstall', () => {
  it('removes the exact version and prunes only the emptied parent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-uninstall-'))
    try {
      craftInstalled(dir, 'esbenp', 'prettier-vscode', '10.4.0')
      craftInstalled(dir, 'esbenp', 'prettier-vscode', '10.3.0')
      craftInstalled(dir, 'other', 'tool', '1.0.0')
      writeFileSync(join(dir, 'notes.txt'), 'keep')
      const service = new ExtensionInstallService(dir)
      const result = await service.uninstall({ namespace: 'esbenp', name: 'prettier-vscode', version: '10.4.0' })
      assert.deepEqual(result, { namespace: 'esbenp', name: 'prettier-vscode', version: '10.4.0', status: 'uninstalled' })
      assert.ok(!existsSync(join(dir, 'esbenp.prettier-vscode', '10.4.0')))
      assert.ok(existsSync(join(dir, 'esbenp.prettier-vscode', '10.3.0', 'stark-install.json')))
      assert.ok(existsSync(join(dir, 'other.tool', '1.0.0', 'stark-install.json')))
      assert.ok(existsSync(join(dir, 'notes.txt')))
      assert.ok(existsSync(join(dir, 'esbenp.prettier-vscode')))
      const listed = await service.listInstalled()
      assert.equal(listed.length, 2)
      const second = await service.uninstall({ namespace: 'esbenp', name: 'prettier-vscode', version: '10.3.0' })
      assert.equal(second.status, 'uninstalled')
      assert.ok(!existsSync(join(dir, 'esbenp.prettier-vscode')))
      assert.ok(existsSync(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects traversal and malformed identities without touching disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-uninstall-bad-'))
    try {
      craftInstalled(dir, 'esbenp', 'prettier-vscode', '10.4.0')
      const before = readdirSync(dir).sort()
      const service = new ExtensionInstallService(dir)
      for (const bad of [
        null,
        {},
        { namespace: 'esbenp', name: 'prettier-vscode' },
        { namespace: '../evil', name: 'x', version: '1' },
        { namespace: 'esbenp', name: 'x', version: '../../1' },
        { namespace: 'esbenp', name: 'prettier-vscode', version: '10.4.0', path: '/tmp/x' },
        { namespace: 'esbenp', name: 'prettier-vscode', version: '10.4.0', url: 'https://evil.example/' }
      ]) {
        await assert.rejects(service.uninstall(bad), /not valid|not safe|We couldn’t install this extension\./)
      }
      assert.deepEqual(readdirSync(dir).sort(), before)
      assert.ok(existsSync(join(dir, 'esbenp.prettier-vscode', '10.4.0', 'stark-install.json')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on missing, malformed, or mismatched metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-uninstall-meta-'))
    try {
      const service = new ExtensionInstallService(dir)
      craftInstalled(dir, 'esbenp', 'prettier-vscode', '10.4.0')
      await assert.rejects(service.uninstall({ namespace: 'esbenp', name: 'missing', version: '1.0.0' }), /not safe/)
      const broken = join(dir, 'broken.tool', '1.0.0')
      mkdirSync(join(broken, 'extension'), { recursive: true })
      writeFileSync(join(broken, 'stark-install.json'), '{not json')
      await assert.rejects(service.uninstall({ namespace: 'broken', name: 'tool', version: '1.0.0' }), /not safe/)
      assert.ok(existsSync(join(broken, 'stark-install.json')))
      const tampered = join(dir, 'esbenp.prettier-vscode', '10.4.0', 'stark-install.json')
      writeFileSync(
        tampered,
        JSON.stringify({ namespace: 'evil', name: 'fork', version: '9.9.9', source: 'open-vsx' })
      )
      await assert.rejects(
        service.uninstall({ namespace: 'esbenp', name: 'prettier-vscode', version: '10.4.0' }),
        /not safe/
      )
      assert.ok(existsSync(tampered))
      const wrongSource = join(dir, 'esbenp.prettier-vscode', '10.4.0', 'stark-install.json')
      writeFileSync(
        wrongSource,
        JSON.stringify({ namespace: 'esbenp', name: 'prettier-vscode', version: '10.4.0', source: 'other' })
      )
      await assert.rejects(
        service.uninstall({ namespace: 'esbenp', name: 'prettier-vscode', version: '10.4.0' }),
        /not safe/
      )
      assert.ok(existsSync(wrongSource))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never follows symlinks and ignores package scripts entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-uninstall-link-'))
    try {
      const versionDir = craftInstalled(dir, 'esbenp', 'prettier-vscode', '10.4.0')
      writeFileSync(
        join(versionDir, 'extension', 'package.json'),
        JSON.stringify({
          name: 'prettier-vscode',
          publisher: 'esbenp',
          version: '10.4.0',
          scripts: { postinstall: 'touch PWNED', postuninstall: 'touch PWNED' },
          activationEvents: ['*']
        })
      )
      const outside = join(dir, 'outside')
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'victim.txt'), 'keep')
      const { symlinkSync } = await import('node:fs')
      let linked = false
      try {
        symlinkSync(outside, join(versionDir, 'extension', 'linked'), 'junction')
        linked = true
      } catch {
        console.warn('skipped: symlink case needs link privileges')
      }
      const service = new ExtensionInstallService(dir)
      if (linked) {
        await assert.rejects(
          service.uninstall({ namespace: 'esbenp', name: 'prettier-vscode', version: '10.4.0' }),
          /not safe/
        )
        assert.ok(existsSync(join(outside, 'victim.txt')))
        assert.ok(existsSync(versionDir))
      }
      assert.ok(!existsSync(join(versionDir, 'PWNED')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves neighboring userData files untouched', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'stark-ext-uninstall-neighbor-'))
    try {
      const root = join(userData, 'extensions')
      craftInstalled(root, 'esbenp', 'prettier-vscode', '10.4.0')
      writeFileSync(join(userData, 'workspace.db'), 'workspace-bytes')
      writeFileSync(join(userData, 'settings.json'), '{"theme":"dark"}')
      const beforeDb = readFileSync(join(userData, 'workspace.db'), 'utf8')
      const service = new ExtensionInstallService(root)
      const result = await service.uninstall({ namespace: 'esbenp', name: 'prettier-vscode', version: '10.4.0' })
      assert.equal(result.status, 'uninstalled')
      assert.equal(readFileSync(join(userData, 'workspace.db'), 'utf8'), beforeDb)
      assert.ok(existsSync(join(userData, 'settings.json')))
      assert.ok(existsSync(root))
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('dedups concurrent uninstalls and refuses install races', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-uninstall-race-'))
    try {
      craftInstalled(dir, 'esbenp', 'prettier-vscode', '10.4.0')
      const service = new ExtensionInstallService(dir)
      const identity = { namespace: 'esbenp', name: 'prettier-vscode', version: '10.4.0' }
      const [first, second] = await Promise.all([service.uninstall(identity), service.uninstall(identity)])
      assert.equal(first.status, 'uninstalled')
      assert.equal(second.status, 'uninstalled')
      assert.ok(!existsSync(join(dir, 'esbenp.prettier-vscode')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uninstall during an in-flight install reports install_in_progress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-uninstall-flight-'))
    try {
      let releaseMetadata = (): void => {}
      const gate = new Promise<void>((resolve) => {
        releaseMetadata = resolve
      })
      const service = new ExtensionInstallService(dir, (async (url: string) => {
        if (url.includes('/file/')) {
          throw new Error('unreachable in this test')
        }
        await gate
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async (): Promise<unknown> => ({ files: { download: 'https://open-vsx.org/api/a/b/1/file/x.vsix' } }),
          body: null
        }
      }) as never)
      const identity = { namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }
      const installing = service.install(identity)
      const refused = await service.uninstall(identity)
      assert.deepEqual(refused, { namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0', status: 'install_in_progress' })
      releaseMetadata()
      await assert.rejects(installing)
      assert.ok(!existsSync(join(dir, 'esbenp.prettier-vscode')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses only Node filesystem APIs with bounded enumeration', async () => {
    const { readFileSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const source = readFileSync(joinPath(process.cwd(), 'src', 'main', 'extension-install', 'extension-install-service.ts'), 'utf8')
    for (const forbidden of ['shell:true', 'taskkill', 'powershell', 'cmd.exe', 'rm -rf', 'spawn(', 'exec(']) {
      assert.ok(!source.includes(forbidden), `service must not contain ${forbidden}`)
    }
    assert.ok(source.includes('EXTENSION_UNINSTALL_MAX_ENTRIES'), 'uninstall must enforce an entry cap')
  })
})

describe('startup staging cleanup', () => {
  it('removes only exact installer-owned names, bounded, never throws', () => {
    const userData = mkdtempSync(join(tmpdir(), 'stark-ext-clean-'))
    try {
      const staging = join(userData, 'extensions', '.staging')
      mkdirSync(staging, { recursive: true })
      mkdirSync(join(staging, `.stark-ext-staging-${'a'.repeat(32)}`))
      mkdirSync(join(staging, 'other-dir'))
      writeFileSync(join(staging, 'keep.txt'), 'x')
      const removed = cleanupStaleInstallStaging(userData)
      assert.equal(removed, 1)
      assert.ok(existsSync(join(staging, 'other-dir')))
      assert.ok(existsSync(join(staging, 'keep.txt')))
      assert.equal(cleanupStaleInstallStaging(join(userData, 'missing')), 0)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
