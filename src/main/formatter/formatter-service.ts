import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { FormatDocumentResult } from '../../shared/formatter/types'
import type { InstalledExtensionEntry } from '../../shared/extension-registry/types'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { ExtensionHostError } from '../extension-host/errors'
import type { ExtensionHostManager } from '../extension-host/extension-host-manager'
import {
  buildHostPayloadMessage,
  parseHostPayloadMessage,
  type FormatEditPayload
} from '../extension-host/protocol'
import type { EnabledExtensionPackage, ExtensionInstallService } from '../extension-install/extension-install-service'
import { MAX_TEXT_FILE_BYTES, MAX_WRITABLE_TEXT_FILE_BYTES } from '../workspace-files/limits'
import { resolveWorkspacePath } from '../workspace-files/workspace-path'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { FormatterError, InvalidFormatterRequestError } from './errors'

/**
 * Document formatter service (Prettier pilot — first real
 * third-party extension execution).
 *
 * Explicit user Format actions only: main reads the authoritative
 * file snapshot, starts the Extension Host on demand, activates the
 * single allowlisted formatter inside it, awaits bounded TextEdits,
 * and returns revision + formatted text. The service NEVER writes
 * project files — the renderer proposes through the existing
 * change-transaction pipeline, and only an explicit human Accept
 * writes. No retries, no polling, no auto-activation on startup, no
 * auto-restart.
 */

/** Exact pilot allowlist: nothing else may execute in Step 6. */
export const PILOT_FORMATTER_NAMESPACE = 'esbenp'
export const PILOT_FORMATTER_NAME = 'prettier-vscode'

/** One format request bound (activation has its own bound below). */
export const FORMATTER_REQUEST_TIMEOUT_MS = 15_000

/** Formatter activation bound (import + register). */
export const FORMATTER_ACTIVATION_TIMEOUT_MS = 10_000

/** Deactivate bound (best-effort unload before host stop). */
export const FORMATTER_DEACTIVATE_TIMEOUT_MS = 5_000

/** Maximum formatter edits applied per request. */
export const FORMATTER_MAX_EDITS = 64

/**
 * Pilot language gate: workspace file extension (lowercase, no dot)
 * to VS Code language id. Everything else is unsupported — the host
 * additionally matches the real registered selector, so an entry
 * here never promises more than Prettier claims.
 */
export const PILOT_FORMATTER_LANGUAGES: Readonly<Record<string, string>> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  vue: 'vue'
}

export function pilotLanguageIdForPath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  const basename = normalized.split('/').pop() ?? ''
  const dot = basename.lastIndexOf('.')
  if (dot <= 0 || dot === basename.length - 1) {
    return null
  }
  return PILOT_FORMATTER_LANGUAGES[basename.slice(dot + 1)] ?? null
}

interface PendingWaiter {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface FormatterServiceOptions {
  readonly manager: ExtensionHostManager
  readonly installService: ExtensionInstallService
  readonly filesService: WorkspaceFilesService
  readonly workspaces: WorkspaceRepository
  /** STARK-owned formatter module file URL (bundled alongside the bootstrap). */
  readonly formatterModuleUrl: string
  readonly requestTimeoutMs?: number
  readonly activationTimeoutMs?: number
  /**
   * Generic activation service (Step 7 primary pipeline). When
   * provided, Format Document activates Prettier through the SAME
   * generic ACTIVATE_EXTENSION flow as every other extension;
   * otherwise the legacy ACTIVATE_FORMATTER adapter is used
   * (older harnesses and unit tests).
   */
  readonly activationService?: {
    activateExtension(identity: { namespace: string; name: string; version: string }): Promise<{ extensionId: string }>
  }
}

export class FormatterService {
  private readonly manager: ExtensionHostManager
  private readonly installService: ExtensionInstallService
  private readonly filesService: WorkspaceFilesService
  private readonly workspaces: WorkspaceRepository
  private readonly formatterModuleUrl: string
  private readonly requestTimeoutMs: number
  private readonly activationTimeoutMs: number
  private readonly activationService?: FormatterServiceOptions['activationService']
  private readonly inFlight = new Map<string, Promise<FormatDocumentResult>>()
  private readonly pending = new Map<string, PendingWaiter>()
  private activationFlight: Promise<string> | null = null
  private activatedExtensionDir: string | null = null
  private readonly unsubscribe: () => void

  constructor(options: FormatterServiceOptions) {
    this.manager = options.manager
    this.installService = options.installService
    this.filesService = options.filesService
    this.workspaces = options.workspaces
    this.formatterModuleUrl = options.formatterModuleUrl
    this.requestTimeoutMs = options.requestTimeoutMs ?? FORMATTER_REQUEST_TIMEOUT_MS
    this.activationTimeoutMs = options.activationTimeoutMs ?? FORMATTER_ACTIVATION_TIMEOUT_MS
    this.activationService = options.activationService
    this.unsubscribe = this.manager.onHostEvent((event) => {
      if (event.kind === 'exit') {
        this.failAllPending(new FormatterError('host_unavailable'))
        this.activationFlight = null
        this.activatedExtensionDir = null
        return
      }
      const parsed = parseHostPayloadMessage(event.raw)
      if (parsed === null) {
        return
      }
      if (parsed.type === 'FORMATTER_READY' || parsed.type === 'FORMATTER_DEACTIVATED') {
        this.settleActivation(parsed.payload.activationId, null)
        return
      }
      if (parsed.type === 'FORMAT_RESULT') {
        this.settleRequest(parsed.payload.requestId, { ok: true as const, edits: parsed.payload.edits })
        return
      }
      if (parsed.type === 'FORMAT_ERROR') {
        this.settleRequest(parsed.payload.requestId, { ok: false as const, code: parsed.payload.code })
      }
    })
  }

  /** Detaches the host subscription (shutdown/test teardown only). */
  dispose(): void {
    this.unsubscribe()
  }

  private settleActivation(activationId: string, error: Error | null): void {
    const waiter = this.pending.get(`activate:${activationId}`)
    if (waiter === undefined) {
      return
    }
    this.pending.delete(`activate:${activationId}`)
    clearTimeout(waiter.timer)
    if (error !== null) {
      waiter.reject(error)
    } else {
      waiter.resolve(undefined)
    }
  }

  private settleRequest(
    requestId: string,
    outcome: { readonly ok: true; readonly edits: readonly FormatEditPayload[] } | { readonly ok: false; readonly code: string }
  ): void {
    const waiter = this.pending.get(`format:${requestId}`)
    if (waiter === undefined) {
      return
    }
    this.pending.delete(`format:${requestId}`)
    clearTimeout(waiter.timer)
    if (outcome.ok) {
      waiter.resolve(outcome.edits)
    } else if (outcome.code === 'unsupported-api') {
      waiter.reject(new FormatterError('unsupported_api', { cause: new Error(`host code: ${outcome.code}`) }))
    } else {
      waiter.reject(new FormatterError('format_failed', { cause: new Error(`host code: ${outcome.code}`) }))
    }
  }

  private failAllPending(error: Error): void {
    for (const [key, waiter] of [...this.pending]) {
      this.pending.delete(key)
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  private track<T>(key: string, timeoutMs: number, onTimeout: () => Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Timers intentionally hold the loop: a pending format must
      // never be silently dropped by loop drain (main never exits via
      // drain; shutdown is explicit and settles waiters via exit).
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(onTimeout())
      }, timeoutMs)
      this.pending.set(key, { resolve: resolve as (value: unknown) => void, reject, timer })
    })
  }

  /**
   * Registers the waiter BEFORE posting: a synchronous reply (tests,
   * fast hosts) must never land before its waiter exists. A posting
   * failure removes the waiter and rethrows.
   */
  private async postAndWait<T>(key: string, timeoutMs: number, onTimeout: () => Error, post: () => void): Promise<T> {
    const gate = this.track<T>(key, timeoutMs, onTimeout)
    try {
      post()
    } catch (error: unknown) {
      const waiter = this.pending.get(key)
      if (waiter !== undefined) {
        this.pending.delete(key)
        clearTimeout(waiter.timer)
      }
      throw error
    }
    return gate
  }

  /**
   * Formats one workspace file through the pilot formatter. Returns
   * the snapshot revision (for expectedRevision stale protection)
   * plus formatted text. One request per document at a time;
   * concurrent duplicates share the single flight.
   */
  async formatDocument(rawRequest: unknown): Promise<FormatDocumentResult> {
    if (typeof rawRequest !== 'object' || rawRequest === null || Array.isArray(rawRequest)) {
      throw new InvalidFormatterRequestError()
    }
    const record = rawRequest as Record<string, unknown>
    if (Object.keys(record).length !== 2) {
      throw new InvalidFormatterRequestError()
    }
    const { workspaceId, relativePath } = record
    if (typeof workspaceId !== 'number' || !Number.isInteger(workspaceId) || workspaceId <= 0) {
      throw new InvalidFormatterRequestError()
    }
    if (typeof relativePath !== 'string' || relativePath === '') {
      throw new InvalidFormatterRequestError()
    }
    const key = `${workspaceId}:${relativePath}`
    if (this.inFlight.has(key)) {
      // A second concurrent request for the same document is refused
      // calmly rather than queued: exactly one flight per document.
      throw new FormatterError('busy')
    }
    const flight = this.runFormat(workspaceId, relativePath)
    this.inFlight.set(key, flight)
    try {
      return await flight
    } finally {
      if (this.inFlight.get(key) === flight) {
        this.inFlight.delete(key)
      }
    }
  }

  /**
   * Best-effort unload after disable/uninstall: bounded DEACTIVATE
   * (the pilot extension exposes no deactivate export, so this drops
   * registrations) followed by full host stop. Never throws.
   */
  async noteExtensionDisabled(): Promise<void> {
    if (this.manager.getStatus().state !== 'ready') {
      return
    }
    const activationId = randomBytes(8).toString('hex')
    try {
      await this.postAndWait<unknown>(
        `activate:${activationId}`,
        FORMATTER_DEACTIVATE_TIMEOUT_MS,
        () => new FormatterError('timeout'),
        () => {
          this.manager.postToHost(buildHostPayloadMessage('DEACTIVATE_FORMATTER', { activationId }))
        }
      )
    } catch {
      // Best effort: the stop below still unloads everything.
    }
    this.activatedExtensionDir = null
    this.activationFlight = null
    try {
      await this.manager.stop()
    } catch {
      // Best effort during unload.
    }
  }

  private async runFormat(workspaceId: number, relativePath: string): Promise<FormatDocumentResult> {
    // 1. Pilot language gate first (pure path check — the host
    //    re-checks the real registered selector before formatting).
    const languageId = pilotLanguageIdForPath(relativePath)
    if (languageId === null) {
      throw new FormatterError('unsupported_language')
    }
    // 2. Authoritative snapshot (containment + 1 MiB cap inherited).
    let snapshot: { content: string; revision: string }
    try {
      const file = await this.filesService.readTextFile({ workspaceId, relativePath })
      snapshot = { content: file.content, revision: file.revision }
    } catch (error: unknown) {
      throw new FormatterError('format_failed', { cause: error })
    }
    if (Buffer.byteLength(snapshot.content, 'utf8') > MAX_TEXT_FILE_BYTES) {
      throw new FormatterError('format_failed')
    }
    // 3. Allowlisted, installed, enabled package (version may vary).
    const installed = await this.installedPilotState()
    if (installed === 'absent') {
      throw new FormatterError('not_installed')
    }
    const wasDisabled = installed === 'disabled'
    if (wasDisabled) {
      throw new FormatterError('disabled')
    }
    const extensionPackage = this.installService.resolveEnabledExtensionPackage(
      PILOT_FORMATTER_NAMESPACE,
      PILOT_FORMATTER_NAME
    )
    if (extensionPackage === null) {
      throw new FormatterError(wasDisabled ? 'disabled' : 'not_installed')
    }
    // 4. Canonical absolute path (parser/config inference only —
    //    documented: Prettier keys parser inference, ignore lookup,
    //    and plugin/filepath options off the file path; text and
    //    language alone cannot drive them).
    const workspace = this.workspaces.findById(workspaceId)
    if (workspace === undefined) {
      throw new FormatterError('format_failed')
    }
    let filePath: string
    try {
      filePath = (await resolveWorkspacePath(workspace.rootPath, relativePath)).absolutePath
    } catch (error: unknown) {
      throw new FormatterError('format_failed', { cause: error })
    }
    // 5. Host ready on demand (explicit user action only — never at startup).
    if (this.manager.getStatus().state !== 'ready') {
      try {
        await this.manager.start()
      } catch (error: unknown) {
        throw new FormatterError('host_unavailable', { cause: error })
      }
    }
    // 6. Formatter active for this exact package directory.
    try {
      await this.ensureFormatterActive(extensionPackage)
    } catch (error: unknown) {
      if (error instanceof FormatterError) {
        throw error
      }
      throw new FormatterError('format_failed', { cause: error })
    }
    // 7. Single bounded format attempt.
    const requestId = randomBytes(8).toString('hex')
    const eol = snapshot.content.includes('\r\n') ? ('crlf' as const) : ('lf' as const)
    const result = await this.postFormatRequest(requestId, filePath, languageId, snapshot.content, eol)
    const afterText = applyFormatEdits(snapshot.content, result)
    return { revision: snapshot.revision, afterText }
  }

  /** Installed-but-state lookup to separate disabled from absent. */
  private async installedPilotState(): Promise<'ready' | 'disabled' | 'absent'> {
    let installed: readonly InstalledExtensionEntry[]
    try {
      installed = await this.installService.listInstalled()
    } catch {
      return 'absent'
    }
    const match = installed.find(
      (entry) => entry.namespace === PILOT_FORMATTER_NAMESPACE && entry.name === PILOT_FORMATTER_NAME
    )
    if (match === undefined) {
      return 'absent'
    }
    return match.enabled ? 'ready' : 'disabled'
  }

  private async ensureFormatterActive(extensionPackage: EnabledExtensionPackage): Promise<void> {
    if (this.activatedExtensionDir === extensionPackage.extensionDir && this.manager.getStatus().state === 'ready') {
      return
    }
    if (this.activationFlight !== null) {
      await this.activationFlight
      if (this.activatedExtensionDir === extensionPackage.extensionDir) {
        return
      }
      throw new FormatterError('format_failed')
    }
    // Generic pipeline (Step 7 primary): Prettier activates through
    // the SAME generic service as every other extension (no
    // Prettier-only host gate). The legacy adapter remains for older
    // harnesses without an activation service.
    if (this.activationService !== undefined) {
      const flight = (async (): Promise<string> => {
        try {
          await this.activationService?.activateExtension({
            namespace: PILOT_FORMATTER_NAMESPACE,
            name: PILOT_FORMATTER_NAME,
            version: extensionPackage.version
          })
        } catch (error: unknown) {
          const code = (error as { code?: unknown })?.code
          if (code === 'disabled') {
            throw new FormatterError('disabled', { cause: error })
          }
          if (code === 'not-installed' || code === 'uninstalled') {
            throw new FormatterError('not_installed', { cause: error })
          }
          if (code === 'unsupported-api') {
            throw new FormatterError('unsupported_api', { cause: error })
          }
          if (code === 'unsupported-extension-kind') {
            throw new FormatterError('format_failed', { cause: error })
          }
          if (code === 'timeout') {
            throw new FormatterError('timeout', { cause: error })
          }
          if (code === 'host-unavailable') {
            throw new FormatterError('host_unavailable', { cause: error })
          }
          throw error
        }
        this.activatedExtensionDir = extensionPackage.extensionDir
        return extensionPackage.extensionDir
      })()
      this.activationFlight = flight
      try {
        await flight
      } catch (error: unknown) {
        this.activatedExtensionDir = null
        if (error instanceof FormatterError) {
          throw error
        }
        if (error instanceof ExtensionHostError) {
          throw new FormatterError('host_unavailable', { cause: error })
        }
        throw error
      } finally {
        if (this.activationFlight === flight) {
          this.activationFlight = null
        }
      }
      return
    }
    const activationId = randomBytes(8).toString('hex')
    const flight = (async (): Promise<string> => {
      // extensionDir is <store>/<ns.name>/<version>/extension:
      // version dir goes up one, store root up three. Both are
      // main-derived; the host re-checks containment regardless.
      const versionDir = join(extensionPackage.extensionDir, '..')
      const storeRoot = join(extensionPackage.extensionDir, '..', '..', '..')
      await this.postAndWait<unknown>(
        `activate:${activationId}`,
        this.activationTimeoutMs,
        () => new FormatterError('timeout'),
        () => {
          this.manager.postToHost(
            buildHostPayloadMessage('ACTIVATE_FORMATTER', {
              activationId,
              formatterModuleUrl: this.formatterModuleUrl,
              storeRoot,
              extensionDir: versionDir
            })
          )
        }
      )
      this.activatedExtensionDir = extensionPackage.extensionDir
      return extensionPackage.extensionDir
    })()
    this.activationFlight = flight
    try {
      await flight
    } catch (error: unknown) {
      this.activatedExtensionDir = null
      if (error instanceof ExtensionHostError) {
        throw new FormatterError('host_unavailable', { cause: error })
      }
      throw error
    } finally {
      if (this.activationFlight === flight) {
        this.activationFlight = null
      }
    }
  }

  private async postFormatRequest(
    requestId: string,
    filePath: string,
    languageId: string,
    text: string,
    eol: 'lf' | 'crlf'
  ): Promise<readonly FormatEditPayload[]> {
    try {
      return await this.postAndWait<readonly FormatEditPayload[]>(
        `format:${requestId}`,
        this.requestTimeoutMs,
        () => new FormatterError('timeout'),
        () => {
          this.manager.postToHost(buildHostPayloadMessage('FORMAT_DOCUMENT', { requestId, filePath, languageId, text, eol }))
        }
      )
    } catch (error: unknown) {
      if (error instanceof ExtensionHostError) {
        throw new FormatterError('host_unavailable', { cause: error })
      }
      if (error instanceof FormatterError) {
        throw error
      }
      throw new FormatterError('format_failed', { cause: error })
    }
  }
}

/**
 * Applies validated host edits to the snapshot in main (pure,
 * testable). Ranges are re-checked against the snapshot: sorted,
 * non-overlapping, in-bounds. Output is capped at the existing
 * writable document bound. Throws FormatterError('format_failed')
 * on any violation — never produces unbounded strings.
 */
export function applyFormatEdits(beforeText: string, edits: readonly FormatEditPayload[]): string {
  if (edits.length > FORMATTER_MAX_EDITS) {
    throw new FormatterError('format_failed')
  }
  const lineStarts = computeLineStarts(beforeText)
  const toOffset = (line: number, character: number): number => {
    if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) {
      throw new FormatterError('format_failed')
    }
    if (line >= lineStarts.length) {
      throw new FormatterError('format_failed')
    }
    const start = lineStarts[line] as number
    const next = line + 1 < lineStarts.length ? (lineStarts[line + 1] as number) : beforeText.length + 1
    // VS Code characters count UTF-16 units including \r; clamp to the line end.
    const offset = start + Math.min(character, Math.max(0, next - start - 1))
    if (offset > beforeText.length) {
      throw new FormatterError('format_failed')
    }
    return offset
  }
  const spans = edits.map((edit) => {
    if (typeof edit.newText !== 'string' || Buffer.byteLength(edit.newText, 'utf8') > MAX_WRITABLE_TEXT_FILE_BYTES) {
      throw new FormatterError('format_failed')
    }
    const start = toOffset(edit.range.start.line, edit.range.start.character)
    const end = toOffset(edit.range.end.line, edit.range.end.character)
    if (end < start) {
      throw new FormatterError('format_failed')
    }
    return { start, end, newText: edit.newText }
  })
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  for (let index = 1; index < spans.length; index += 1) {
    if ((spans[index] as { start: number }).start < (spans[index - 1] as { end: number }).end) {
      throw new FormatterError('format_failed')
    }
  }
  let result = beforeText
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index] as { start: number; end: number; newText: string }
    result = result.slice(0, span.start) + span.newText + result.slice(span.end)
  }
  if (Buffer.byteLength(result, 'utf8') > MAX_WRITABLE_TEXT_FILE_BYTES) {
    throw new FormatterError('format_failed')
  }
  return result
}

function computeLineStarts(text: string): readonly number[] {
  const starts: number[] = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1)
    }
  }
  return starts
}
