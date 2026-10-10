import { randomBytes } from 'node:crypto'
import { lstatSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { ExtensionHostManager } from './extension-host-manager'
import {
  buildHostPayloadMessage,
  parseHostPayloadMessage,
  PROVIDER_QUERY_KINDS,
  type CommandResultPayload,
  type ExtensionNotifyPayload,
  type HostRequestPayload,
  type ProviderQueryKind,
  type ProviderResultPayload
} from './protocol'
import {
  validatedInstallIdentity,
  type ValidatedInstallIdentity
} from '../extension-install/extension-install-service'
import type { ExtensionInstallService } from '../extension-install/extension-install-service'
import type { ExtensionActivationService } from './extension-activation-service'
import { ExtensionActivationError } from './extension-activation-errors'
import { readNormalizedManifest, type NormalizedExtensionManifest } from './extension-manifest'
import {
  buildActivationIndex,
  extensionsForCommand,
  extensionsForLanguage,
  extensionsForStartupFinished,
  extensionsForWorkspace
} from './extension-activation-events'
import { isExtensionTrusted, writeExtensionTrust } from './extension-trust'
import { readExtensionConfigs, writeExtensionConfigValue, type ExtensionConfigValue } from './extension-config'
import { writeStorageValue } from './extension-storage'
import { analyzeCompatibility, type CompatibilityLevel } from './extension-compat'
import { parseContributions } from './extension-contributions'
import {
  JSON_SCHEMA_MAX_MERGED,
  fetchRemoteJsonSchema,
  isLocalSchemaUrl,
  readLocalJsonSchema,
  toMonacoFilePatterns,
  type ResolvedJsonSchema
} from './extension-json-validation'
import { checkExtensionUpdate, type CatalogVersionSource } from './extension-updates'
import { readExtensionPrefs, writeExtensionPrefs, type SelectedThemeRef } from './extension-prefs'
import { ExtensionWatcherService } from './extension-watchers'

/**
 * Generic extension runtime coordinator (Steps 8+9, main-side).
 *
 * Sits above the demand-driven activation service and owns everything
 * event-driven and cooperative:
 *
 * - trust-gated activation (installed + enabled + trusted-or-acknowledged)
 * - bounded demand-driven triggers (language / command / workspace /
 *   startup — never a blind startup sweep; `*` never auto-runs)
 * - host cooperation: answers HOST_REQUEST (findFiles, openDocument,
 *   prompts, clipboard, cross-activation, fs reads) and routes
 *   EXTENSION_NOTIFY into bounded caches + main-owned persistence
 *   (config, storage) — schema stays v19, no migration
 * - language-feature queries (completion/hover/definition/…), command
 *   execution, document/active-editor forwarding, watcher dispatch
 * - compatibility details, contribution summaries, update checks,
 *   failure tracking, prompt queue for renderer round-trips
 *
 * Review-before-write survives: extension edit proposals are cached
 * for the renderer to turn into change transactions (human Accept /
 * Reject). Nothing here writes project files. No retries, no polling,
 * no broad kills, no generic IPC.
 */

/** Maximum cached notifications. */
export const RUNTIME_MAX_NOTIFICATIONS = 32

/** Maximum cached edit proposals. */
export const RUNTIME_MAX_PROPOSALS = 32

/** Maximum cached output lines per channel. */
export const RUNTIME_MAX_OUTPUT_LINES = 200

/** Maximum output channels cached. */
export const RUNTIME_MAX_OUTPUT_CHANNELS = 64

/** Maximum status items cached. */
export const RUNTIME_MAX_STATUS_ITEMS = 128

/** Maximum pending prompts. */
export const RUNTIME_MAX_PROMPTS = 8

/** Prompt round-trip bound (renderer modal). */
export const RUNTIME_PROMPT_TIMEOUT_MS = 120_000

/** Provider query bound (host has its own 5s bound inside). */
export const RUNTIME_PROVIDER_TIMEOUT_MS = 8_000

/** Command execution bound. */
export const RUNTIME_COMMAND_TIMEOUT_MS = 10_000

/** Maximum failures tracked. */
export const RUNTIME_MAX_FAILURES = 128

/** Maximum text bytes accepted in document snapshots. */
export const RUNTIME_MAX_DOCUMENT_BYTES = 1024 * 1024

export type TriggerKind = 'language' | 'command' | 'workspace' | 'startup' | 'manual'

export interface TriggerRequest {
  readonly kind: TriggerKind
  /** Language id (language triggers) or command id (command triggers). */
  readonly value?: string
  /** Workspace-root entry names (workspace triggers). */
  readonly rootEntries?: readonly string[]
  /** Exact extension identity (manual triggers). */
  readonly identity?: { namespace: string; name: string; version: string }
}

export interface TriggerOutcome {
  readonly activated: readonly string[]
  /** Extension ids needing explicit trust before they may run. */
  readonly needsTrust: readonly string[]
}

export interface PromptRecord {
  readonly promptId: string
  readonly owner: string
  readonly kind: 'quickPick' | 'inputBox'
  readonly items?: readonly string[]
  readonly placeHolder?: string
  readonly prompt?: string
  readonly value?: string
  readonly password?: boolean
  readonly canPickMany?: boolean
}

export interface NotificationRecord {
  readonly id: string
  readonly owner: string
  readonly severity: 'info' | 'warning' | 'error'
  readonly message: string
  readonly receivedAt: number
}

export interface EditProposalRecord {
  readonly proposalId: string
  readonly owner: string
  readonly edits: readonly { uri: string; range: unknown; newText: string }[]
  readonly receivedAt: number
}

export interface DiagnosticRecord {
  readonly owner: string
  readonly collection: string
  readonly uri: string
  readonly severity: number
  readonly message: string
  readonly source?: string
  readonly range: { start: { line: number; character: number }; end: { line: number; character: number } }
}

export interface StatusItemRecord {
  readonly itemId: number
  readonly owner: string
  readonly text: string
  readonly tooltip?: string
  readonly command?: string
  readonly alignment: number
  readonly priority: number
  readonly visible: boolean
}

export interface ExtensionDetails {
  readonly namespace: string
  readonly name: string
  readonly version: string
  readonly displayName: string
  readonly enabled: boolean
  readonly active: boolean
  readonly trusted: boolean
  readonly compatibility: CompatibilityLevel
  readonly reasons: readonly string[]
  readonly commands: readonly { command: string; title: string; category: string | null }[]
  readonly languages: readonly string[]
  readonly themes: readonly { id: string; label: string }[]
  readonly keybindings: readonly { command: string; key: string }[]
  readonly hasConfiguration: boolean
  readonly capabilities: readonly string[]
  readonly failure: string | null
  readonly updateAvailable: boolean
  readonly latestVersion: string | null
}

export interface WorkspaceFileAccess {
  /** Bounded basename/relative listing for findFiles (glob `*`/`?`). */
  listFiles(pattern: string, maxResults: number): string[]
  /** Bounded read of one workspace-owned relative path (utf8) or null. */
  readFile(relativePath: string, maxBytes: number): { text: string; languageId: string } | null
  /** Stat of one workspace-owned relative path or null. */
  statFile(relativePath: string): { type: number } | null
}

export interface ExtensionRuntimeServiceOptions {
  readonly manager: ExtensionHostManager
  readonly activationService: ExtensionActivationService
  readonly installService: ExtensionInstallService
  readonly installRoot: string
  readonly workspaceFiles?: WorkspaceFileAccess
  readonly workspaceRootProvider?: () => string | null
  readonly catalogVersions?: CatalogVersionSource
  readonly promptTimeoutMs?: number
  readonly providerTimeoutMs?: number
  readonly commandTimeoutMs?: number
}

interface PendingWaiter {
  readonly resolve: (value: never) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

function extensionInstanceId(identity: ValidatedInstallIdentity): string {
  return `${identity.namespace}.${identity.name}@${identity.version}`
}

function shortId(): string {
  return randomBytes(8).toString('hex')
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value === '' || value.length > maxLength) {
    return null
  }
  return value
}

export class ExtensionRuntimeService {
  private readonly manager: ExtensionHostManager
  private readonly activationService: ExtensionActivationService
  private readonly installService: ExtensionInstallService
  private readonly installRoot: string
  private readonly workspaceFiles?: WorkspaceFileAccess
  private readonly workspaceRootProvider?: () => string | null
  private readonly catalogVersions?: CatalogVersionSource
  private readonly promptTimeoutMs: number
  private readonly providerTimeoutMs: number
  private readonly commandTimeoutMs: number
  private readonly watcherService: ExtensionWatcherService
  private readonly watcherRegistrations = new Map<string, number>()
  private readonly pending = new Map<string, PendingWaiter>()
  private readonly prompts = new Map<string, { record: PromptRecord; resolve: (response: Record<string, unknown> | null) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly notifications: NotificationRecord[] = []
  private readonly proposals: EditProposalRecord[] = []
  private readonly diagnostics: DiagnosticRecord[] = []
  private readonly output = new Map<string, string[]>()
  private readonly statusItems = new Map<number, StatusItemRecord>()
  private readonly failures = new Map<string, { code: string; unsupportedApi?: string; at: number }>()
  private readonly unsupportedApis = new Map<string, Set<string>>()
  private readonly childProcessCounts = new Map<string, number>()
  private readonly registrationCounts = new Map<string, { commands: number; providers: readonly string[] }>()
  /** Session cache of remote JSON schemas (url → schema or null-unavailable; no retries, no TTL). */
  private readonly remoteSchemaCache = new Map<string, Record<string, unknown> | null>()
  private readonly unsubscribe: () => void
  private promptListener: ((prompt: PromptRecord) => void) | null = null
  private eventListener: ((event: { kind: string; payload: Record<string, unknown> }) => void) | null = null

  constructor(options: ExtensionRuntimeServiceOptions) {
    this.manager = options.manager
    this.activationService = options.activationService
    this.installService = options.installService
    this.installRoot = options.installRoot
    this.workspaceFiles = options.workspaceFiles
    this.workspaceRootProvider = options.workspaceRootProvider
    this.catalogVersions = options.catalogVersions
    this.promptTimeoutMs = options.promptTimeoutMs ?? RUNTIME_PROMPT_TIMEOUT_MS
    this.providerTimeoutMs = options.providerTimeoutMs ?? RUNTIME_PROVIDER_TIMEOUT_MS
    this.commandTimeoutMs = options.commandTimeoutMs ?? RUNTIME_COMMAND_TIMEOUT_MS
    this.watcherService = new ExtensionWatcherService({
      workspaceRootProvider: () => this.workspaceRootProvider?.() ?? null
    })
    this.watcherService.setDispatchListener((event) => {
      if (this.manager.getStatus().state !== 'ready') {
        return
      }
      try {
        this.manager.postToHost(
          buildHostPayloadMessage('WATCHER_EVENT', { watcherId: event.hostWatcherId, kind: event.kind, uri: event.uri })
        )
      } catch {
        // Dispatch is best-effort.
      }
    })
    this.unsubscribe = this.manager.onHostEvent((event) => {
      if (event.kind === 'exit') {
        this.failAllPending(new ExtensionActivationError('host-unavailable', 'The Extension Host is unavailable.'))
        this.rejectAllPrompts()
        return
      }
      const parsed = parseHostPayloadMessage(event.raw)
      if (parsed === null) {
        return
      }
      if (parsed.type === 'HOST_REQUEST') {
        void this.answerHostRequest(parsed.payload)
        return
      }
      if (parsed.type === 'EXTENSION_NOTIFY') {
        this.routeNotify(parsed.payload)
        return
      }
      if (parsed.type === 'PROVIDER_RESULT') {
        this.settle(`provider:${parsed.payload.queryId}`, null, parsed.payload)
        return
      }
      if (parsed.type === 'COMMAND_RESULT') {
        this.settle(`command:${parsed.payload.requestId}`, null, parsed.payload)
        return
      }
      if (parsed.type === 'EXTENSION_ACTIVATION_ERROR') {
        this.recordFailure(parsed.payload.extensionId, parsed.payload.code, parsed.payload.unsupportedApi)
        return
      }
      if (parsed.type === 'EXTENSION_ACTIVATED') {
        this.failures.delete(parsed.payload.extensionId)
      }
    })
  }

  /** Detaches host subscription + watchers (shutdown/test teardown). */
  dispose(): void {
    this.unsubscribe()
    this.watcherService.dispose()
    for (const [, prompt] of this.prompts) {
      clearTimeout(prompt.timer)
    }
    this.prompts.clear()
  }

  /** Renderer push fan-out for prompts + notifications (wired in main/index). */
  setPromptListener(listener: (prompt: PromptRecord) => void): void {
    this.promptListener = listener
  }

  /** Renderer push fan-out for notification/clipboard/progress events. */
  setEventListener(listener: (event: { kind: string; payload: Record<string, unknown> }) => void): void {
    this.eventListener = listener
  }

  // ------------------------------------------------------------------
  // Trust-gated activation
  // ------------------------------------------------------------------

  /**
   * Activates one extension (installed + enabled + trusted or
   * explicitly acknowledged). Untrusted callers receive a
   * `trust-required` error so the renderer can show the trust dialog.
   */
  async activateExtension(
    rawIdentity: unknown,
    options?: { acknowledged?: boolean }
  ): Promise<{ extensionId: string; displayName: string }> {
    const identity = validatedInstallIdentity(rawIdentity)
    if (options?.acknowledged !== true && !isExtensionTrusted(this.installRoot, identity)) {
      throw new ExtensionActivationError('trust-required', 'STARK needs permission before running this extension.')
    }
    try {
      return await this.activationService.activateExtension(identity)
    } catch (error: unknown) {
      if (error instanceof ExtensionActivationError) {
        if (error.code === 'unsupported-api') {
          this.recordUnsupported(extensionInstanceId(identity), error.unsupportedApi)
        } else if (error.code !== 'disabled' && error.code !== 'not-installed') {
          this.recordFailure(extensionInstanceId(identity), error.code, error.unsupportedApi)
        }
      }
      throw error
    }
  }

  async deactivateExtension(rawIdentity: unknown): Promise<boolean> {
    const identity = validatedInstallIdentity(rawIdentity)
    const done = await this.activationService.deactivateExtension(identity)
    this.watcherService.unregisterOwner(extensionInstanceId(identity))
    return done
  }

  listActive(): readonly string[] {
    return this.activationService.listActive()
  }

  /** Whether one exact version is trusted (version-pinned). */
  isTrusted(rawIdentity: unknown): boolean {
    return isExtensionTrusted(this.installRoot, validatedInstallIdentity(rawIdentity))
  }

  /** Persists one trust flag (explicit user action only). */
  setTrusted(rawIdentity: unknown, trusted: boolean): boolean {
    const identity = validatedInstallIdentity(rawIdentity)
    if (typeof trusted !== 'boolean') {
      throw new ExtensionActivationError('invalid-request', 'That trust request is not valid.')
    }
    writeExtensionTrust(this.installRoot, identity, trusted)
    return trusted
  }

  // ------------------------------------------------------------------
  // Demand-driven triggers (no startup sweep; `*` never auto-runs)
  // ------------------------------------------------------------------

  private async installedManifests(): Promise<{ identity: ValidatedInstallIdentity; manifest: NormalizedExtensionManifest | null }[]> {
    let installed: readonly { namespace: string; name: string; version: string }[]
    try {
      installed = await this.installService.listInstalled()
    } catch {
      return []
    }
    const out: { identity: ValidatedInstallIdentity; manifest: NormalizedExtensionManifest | null }[] = []
    for (const entry of installed.slice(0, 512)) {
      let identity: ValidatedInstallIdentity
      try {
        identity = validatedInstallIdentity({ namespace: entry.namespace, name: entry.name, version: entry.version })
      } catch {
        continue
      }
      const versionDir = join(this.installRoot, `${identity.namespace}.${identity.name}`, identity.version)
      try {
        out.push({ identity, manifest: readNormalizedManifest(versionDir, identity) })
      } catch {
        out.push({ identity, manifest: null })
      }
    }
    return out
  }

  /**
   * Evaluates one trigger against installed + enabled extensions.
   * Trusted candidates activate (best-effort, failures recorded);
   * untrusted candidates are reported for the trust dialog — never
   * auto-run. `*` extensions are excluded from automatic triggers.
   */
  async fireTrigger(trigger: TriggerRequest): Promise<TriggerOutcome> {
    const snapshots = await this.installedManifests()
    const enabled = new Map<string, { identity: ValidatedInstallIdentity; manifest: NormalizedExtensionManifest | null }>()
    for (const snapshot of snapshots) {
      enabled.set(extensionInstanceId(snapshot.identity), snapshot)
    }
    // Enabled-state truth lives in the install service listing; the
    // snapshots above already reflect it (listInstalled carries flags).
    let installedFlags: Map<string, boolean>
    try {
      const listed = await this.installService.listInstalled()
      installedFlags = new Map(listed.map((entry) => [`${entry.namespace}.${entry.name}@${entry.version}`, entry.enabled]))
    } catch {
      installedFlags = new Map()
    }
    const index = buildActivationIndex(
      snapshots
        .filter((snapshot) => installedFlags.get(extensionInstanceId(snapshot.identity)) !== false)
        .map((snapshot) => ({
          extensionId: extensionInstanceId(snapshot.identity),
          activationEvents: snapshot.manifest?.activationEvents ?? []
        }))
    )
    let candidates: readonly string[] = []
    if (trigger.kind === 'language' && typeof trigger.value === 'string') {
      candidates = extensionsForLanguage(index, trigger.value)
    } else if (trigger.kind === 'command' && typeof trigger.value === 'string') {
      candidates = extensionsForCommand(index, trigger.value)
    } else if (trigger.kind === 'workspace') {
      candidates = extensionsForWorkspace(index, trigger.rootEntries ?? [])
    } else if (trigger.kind === 'startup') {
      candidates = extensionsForStartupFinished(index)
    } else if (trigger.kind === 'manual' && trigger.identity !== undefined) {
      try {
        const identity = validatedInstallIdentity(trigger.identity)
        candidates = [extensionInstanceId(identity)]
      } catch {
        candidates = []
      }
    }
    const activated: string[] = []
    const needsTrust: string[] = []
    for (const candidate of candidates.slice(0, 32)) {
      if (this.activationService.listActive().includes(candidate)) {
        continue
      }
      const snapshot = enabled.get(candidate)
      if (snapshot === undefined || installedFlags.get(candidate) === false) {
        continue
      }
      const at = candidate.lastIndexOf('@')
      const head = at === -1 ? candidate : candidate.slice(0, at)
      const dot = head.indexOf('.')
      if (dot === -1) {
        continue
      }
      const identity = { namespace: head.slice(0, dot), name: head.slice(dot + 1), version: candidate.slice(at + 1) }
      let validated: ValidatedInstallIdentity
      try {
        validated = validatedInstallIdentity(identity)
      } catch {
        continue
      }
      if (!isExtensionTrusted(this.installRoot, validated)) {
        if (!needsTrust.includes(candidate)) {
          needsTrust.push(candidate)
        }
        continue
      }
      try {
        await this.activationService.activateExtension(validated)
        activated.push(candidate)
      } catch (error: unknown) {
        if (error instanceof ExtensionActivationError && error.code === 'unsupported-api') {
          this.recordUnsupported(candidate, error.unsupportedApi)
        } else {
          this.recordFailure(candidate, error instanceof ExtensionActivationError ? error.code : 'activation-failed')
        }
      }
    }
    return { activated, needsTrust }
  }

  // ------------------------------------------------------------------
  // Language features + command execution
  // ------------------------------------------------------------------

  /**
   * Runs one language-feature query across active providers (bounded,
   * merged). Returns the host result or null when unavailable.
   */
  async queryProviders(request: {
    kind: string
    filePath: string
    languageId: string
    text: string
    position?: { line: number; character: number }
    endPosition?: { line: number; character: number }
    query?: string
    newName?: string
  }): Promise<Record<string, unknown> | null> {
    const kind = PROVIDER_QUERY_KINDS.find((entry) => entry === request.kind)
    if (kind === undefined) {
      throw new ExtensionActivationError('invalid-request', 'That language request is not valid.')
    }
    const typedKind: ProviderQueryKind = kind
    const filePath = boundedText(request.filePath, 4096)
    const languageId = boundedText(request.languageId, 64)
    if (filePath === null || languageId === null) {
      throw new ExtensionActivationError('invalid-request', 'That language request is not valid.')
    }
    if (typeof request.text !== 'string' || Buffer.byteLength(request.text, 'utf8') > RUNTIME_MAX_DOCUMENT_BYTES) {
      throw new ExtensionActivationError('invalid-request', 'That language request is not valid.')
    }
    if (this.manager.getStatus().state !== 'ready') {
      return null
    }
    const queryId = shortId()
    try {
      const reply = await this.postAndWait<ProviderResultPayload>(
        `provider:${queryId}`,
        this.providerTimeoutMs,
        () => new ExtensionActivationError('timeout', 'That extension timed out. No changes were made.'),
        () => {
          this.manager.postToHost(
            buildHostPayloadMessage('PROVIDER_QUERY', {
              queryId,
              kind: typedKind,
              filePath,
              languageId,
              text: request.text,
              position: validPosition(request.position),
              endPosition: validPosition(request.endPosition),
              query: typeof request.query === 'string' ? request.query.slice(0, 128) : undefined,
              newName: typeof request.newName === 'string' ? request.newName.slice(0, 256) : undefined
            })
          )
        }
      )
      if (!reply.ok) {
        return null
      }
      return (reply.result ?? null) as Record<string, unknown> | null
    } catch {
      return null
    }
  }

  /**
   * Executes one contributed command (user-invoked): activates the
   * owning extension on demand (acknowledged, demand-driven), then
   * dispatches owner-aware with the host nesting bound.
   */
  async invokeCommand(command: string, args?: readonly unknown[]): Promise<unknown> {
    if (typeof command !== 'string' || command === '' || command.length > 128) {
      throw new ExtensionActivationError('invalid-request', 'That command request is not valid.')
    }
    const boundedArgs = Array.isArray(args) ? args.slice(0, 8) : []
    let serialized: string
    try {
      serialized = JSON.stringify(boundedArgs) ?? ''
    } catch {
      throw new ExtensionActivationError('invalid-request', 'That command request is not valid.')
    }
    if (serialized.length > 64 * 1024) {
      throw new ExtensionActivationError('invalid-request', 'That command request is not valid.')
    }
    // onCommand activation first (acknowledged: explicit user action).
    await this.fireTrigger({ kind: 'command', value: command })
    if (this.manager.getStatus().state !== 'ready') {
      throw new ExtensionActivationError('host-unavailable', 'The Extension Host is unavailable.')
    }
    const requestId = shortId()
    const reply = await this.postAndWait<CommandResultPayload>(
      `command:${requestId}`,
      this.commandTimeoutMs,
      () => new ExtensionActivationError('timeout', 'That extension timed out. No changes were made.'),
      () => {
        this.manager.postToHost(buildHostPayloadMessage('EXECUTE_COMMAND', { requestId, command, args: boundedArgs }))
      }
    )
    if (!reply.ok) {
      if (reply.code === 'unsupported-api') {
        throw new ExtensionActivationError('unsupported-api', 'This extension requires a VS Code API that STARK does not support yet.', reply.unsupportedApi !== undefined ? { unsupportedApi: reply.unsupportedApi } : undefined)
      }
      throw new ExtensionActivationError('activation-failed', 'That extension could not be activated.')
    }
    return reply.result ?? null
  }

  // ------------------------------------------------------------------
  // Document / editor sync (renderer-driven, bounded)
  // ------------------------------------------------------------------

  /** Forwards one renderer-owned document snapshot to the host. */
  pushDocumentEvent(event: { kind: string; uri: string; languageId?: string; text?: string; version?: number }): void {
    if (this.manager.getStatus().state !== 'ready') {
      return
    }
    if (event.kind !== 'opened' && event.kind !== 'changed' && event.kind !== 'closed') {
      return
    }
    const uri = boundedText(event.uri, 4096)
    if (uri === null) {
      return
    }
    const text = event.text === undefined ? undefined : typeof event.text === 'string' && Buffer.byteLength(event.text, 'utf8') <= RUNTIME_MAX_DOCUMENT_BYTES ? event.text : undefined
    if ((event.kind === 'opened' || event.kind === 'changed') && text === undefined) {
      return
    }
    try {
      this.manager.postToHost(
        buildHostPayloadMessage('DOCUMENT_EVENT', {
          event: {
            kind: event.kind,
            uri,
            languageId: typeof event.languageId === 'string' ? event.languageId.slice(0, 64) : undefined,
            text,
            version: Number.isInteger(event.version) ? event.version : undefined
          }
        })
      )
    } catch {
      // Sync is best-effort.
    }
  }

  /** Forwards the active-editor snapshot to the host. */
  setActiveEditor(editor: { uri: string; languageId: string } | null): void {
    if (this.manager.getStatus().state !== 'ready') {
      return
    }
    try {
      this.manager.postToHost(
        buildHostPayloadMessage('ACTIVE_EDITOR', {
          editor: editor === null ? null : { uri: editor.uri.slice(0, 4096), languageId: editor.languageId.slice(0, 64) }
        })
      )
    } catch {
      // Best effort.
    }
  }

  /**
   * Forwards validated workspace folders to the host. Each folder must
   * be an existing directory (containment is inherent: the renderer
   * supplies the open workspace root, main re-validates on disk).
   * Invalid entries are dropped, never forwarded.
   */
  pushWorkspaceFolders(folders: readonly { uri: string; name: string }[] | null): void {
    if (this.manager.getStatus().state !== 'ready') {
      return
    }
    let validated: { uri: string; name: string }[] | null = null
    if (folders !== null && folders !== undefined) {
      if (!Array.isArray(folders)) {
        return
      }
      validated = []
      for (const entry of folders.slice(0, 8)) {
        if (entry === null || typeof entry !== 'object') {
          continue
        }
        const record = entry as Record<string, unknown>
        if (typeof record['uri'] !== 'string' || record['uri'] === '' || record['uri'].length > 4096) {
          continue
        }
        const root = folderPathFromUri(record['uri'])
        if (root === null) {
          continue
        }
        try {
          if (!statSync(root).isDirectory()) {
            continue
          }
        } catch {
          continue
        }
        validated.push({
          uri: (record['uri'] as string).slice(0, 4096),
          name: typeof record['name'] === 'string' && record['name'] !== '' ? (record['name'] as string).slice(0, 128) : root
        })
      }
    }
    try {
      this.manager.postToHost(buildHostPayloadMessage('WORKSPACE_FOLDERS', { folders: validated }))
    } catch {
      // Best effort.
    }
  }

  // ------------------------------------------------------------------
  // Details / compat / contributions / updates
  // ------------------------------------------------------------------

  /**
   * Builds the renderer-safe detail surface for one installed
   * extension (compat, commands, settings flag, capabilities,
   * failure, update). Never throws for missing manifests.
   */
  async getDetails(rawIdentity: unknown): Promise<ExtensionDetails> {
    const identity = validatedInstallIdentity(rawIdentity)
    const id = extensionInstanceId(identity)
    let displayName = identity.name
    let manifest: NormalizedExtensionManifest | null = null
    try {
      const installed = await this.installService.listInstalled()
      const match = installed.find((entry) => entry.namespace === identity.namespace && entry.name === identity.name && entry.version === identity.version)
      if (match !== undefined) {
        displayName = match.displayName
      }
      manifest = readNormalizedManifest(join(this.installRoot, `${identity.namespace}.${identity.name}`, identity.version), identity)
      if (manifest.displayName !== '') {
        displayName = manifest.displayName
      }
    } catch {
      // Details degrade gracefully without a manifest.
    }
    const contributes = manifest?.contributes !== undefined && manifest?.contributes !== null
      ? parseContributions(manifest.contributes)
      : null
    const unsupported = [...(this.unsupportedApis.get(id) ?? [])]
    const failure = this.failures.get(id)
    // One requirement → one reason: manifest keys already contain
    // every contribution class (otherKeys is a subset for reporting),
    // so merging both without dedupe double-flagged keys such as
    // jsonValidation. Dedupe here; the analyzer dedupes again.
    const contributesKeys = [
      ...(manifest?.contributes !== null && manifest?.contributes !== undefined ? Object.keys(manifest.contributes) : []),
      ...(contributes?.otherKeys ?? [])
    ]
    const compat = analyzeCompatibility({
      hasMain: manifest?.main !== null && manifest?.main !== undefined,
      hasBrowserOnly: (manifest?.main === null || manifest === null) && manifest?.browser !== null && manifest?.browser !== undefined,
      contributesKeys: [...new Set(contributesKeys)].slice(0, 32),
      unsupportedApis: unsupported.slice(0, 16),
      proposedApis: [],
      hasNativeModules: false,
      activationFailed: failure !== undefined,
      failureCode: failure?.code ?? null
    })
    const commands = (contributes?.commands ?? []).map((entry) => ({ command: entry.command, title: entry.title, category: entry.category }))
    const keybindings = (contributes?.keybindings ?? [])
      .filter((entry) => commands.some((command) => command.command === entry.command))
      .map((entry) => ({ command: entry.command, key: entry.key }))
    const languages = (contributes?.languages ?? []).map((entry) => entry.id)
    const themes = (contributes?.themes ?? []).map((entry) => ({ id: entry.id, label: entry.label }))
    const capabilities = capabilityLabels({
      hasMain: manifest?.main !== null && manifest?.main !== undefined,
      activationEvents: manifest?.activationEvents ?? [],
      contributesCommands: commands.length,
      providers: this.registrationCounts.get(id)?.providers ?? [],
      childProcesses: this.childProcessCounts.get(id) ?? 0
    })
    let updateAvailable = false
    let latestVersion: string | null = null
    if (this.catalogVersions !== undefined) {
      try {
        const planned = await checkExtensionUpdate(this.catalogVersions, identity)
        updateAvailable = planned.updateAvailable
        latestVersion = planned.latestVersion
      } catch {
        // Offline-safe: no update shown.
      }
    }
    return {
      namespace: identity.namespace,
      name: identity.name,
      version: identity.version,
      displayName,
      enabled: await this.isEnabled(identity),
      active: this.activationService.listActive().includes(id),
      trusted: isExtensionTrusted(this.installRoot, identity),
      compatibility: compat.level,
      reasons: compat.reasons,
      commands: commands.slice(0, 256),
      keybindings: keybindings.slice(0, 256),
      languages,
      themes,
      hasConfiguration: (contributes?.configuration.size ?? 0) > 0,
      capabilities,
      failure: failure !== undefined ? failure.code : null,
      updateAvailable,
      latestVersion
    }
  }

  private async isEnabled(identity: ValidatedInstallIdentity): Promise<boolean> {
    try {
      const listed = await this.installService.listInstalled()
      return listed.find((entry) => entry.namespace === identity.namespace && entry.name === identity.name && entry.version === identity.version)?.enabled ?? true
    } catch {
      return true
    }
  }

  /** Contributed + registered commands across installed extensions (bounded). */
  async listCommands(): Promise<readonly { command: string; title: string; category: string | null; extensionId: string }[]> {
    const snapshots = await this.installedManifests()
    const out: { command: string; title: string; category: string | null; extensionId: string }[] = []
    const seen = new Set<string>()
    const sorted = snapshots.sort((a, b) => extensionInstanceId(a.identity).localeCompare(extensionInstanceId(b.identity)))
    for (const snapshot of sorted) {
      if (snapshot.manifest?.contributes == null) {
        continue
      }
      const parsed = parseContributions(snapshot.manifest.contributes)
      for (const command of parsed.commands) {
        if (seen.has(command.command) || out.length >= 1024) {
          continue
        }
        seen.add(command.command)
        out.push({ command: command.command, title: command.title, category: command.category, extensionId: extensionInstanceId(snapshot.identity) })
      }
    }
    return out
  }

  /** Stored config values for one extension (bounded, renderer-safe). */
  getConfig(extensionId: string): Record<string, ExtensionConfigValue> {
    const configs = readExtensionConfigs(this.installRoot)
    const inner = configs.get(extensionId)
    if (inner === undefined) {
      return {}
    }
    const out: Record<string, ExtensionConfigValue> = {}
    for (const [key, value] of inner) {
      out[key] = value
    }
    return out
  }

  /** Persists one config value through the main-owned store. */
  updateConfig(extensionId: string, key: string, value: unknown): void {
    writeExtensionConfigValue(this.installRoot, extensionId, key, value)
  }

  /** Checks one identity for catalog updates (offline-safe). */
  async checkUpdate(rawIdentity: unknown): Promise<{ updateAvailable: boolean; latestVersion: string | null }> {
    const identity = validatedInstallIdentity(rawIdentity)
    if (this.catalogVersions === undefined) {
      return { updateAvailable: false, latestVersion: null }
    }
    return checkExtensionUpdate(this.catalogVersions, identity)
  }

  /** Reads the auto-update preference (DEFAULT OFF). */
  getAutoUpdate(): boolean {
    return readExtensionPrefs(this.installRoot).automaticallyUpdateExtensions
  }

  /** Persists the auto-update preference (explicit user action). */
  setAutoUpdate(enabled: boolean): boolean {
    if (typeof enabled !== 'boolean') {
      throw new ExtensionActivationError('invalid-request', 'That preference request is not valid.')
    }
    const current = readExtensionPrefs(this.installRoot)
    writeExtensionPrefs(this.installRoot, { ...current, automaticallyUpdateExtensions: enabled })
    return enabled
  }

  // ------------------------------------------------------------------
  // Contribution assets (languages / snippets / themes, containment-checked)
  // ------------------------------------------------------------------

  /** Merged contributed languages across installed extensions (bounded). */
  async listLanguages(): Promise<readonly { id: string; extensions: readonly string[]; aliases: readonly string[] }[]> {
    const snapshots = await this.installedManifests()
    const merged = new Map<string, { extensions: Set<string>; aliases: Set<string> }>()
    for (const snapshot of snapshots) {
      if (snapshot.manifest?.contributes == null) {
        continue
      }
      const parsed = parseContributions(snapshot.manifest.contributes)
      for (const language of parsed.languages) {
        let entry = merged.get(language.id)
        if (entry === undefined) {
          entry = { extensions: new Set(), aliases: new Set() }
          merged.set(language.id, entry)
        }
        for (const extension of language.extensions.slice(0, 16)) {
          entry.extensions.add(extension)
        }
        for (const alias of language.aliases.slice(0, 8)) {
          entry.aliases.add(alias)
        }
        if (merged.size >= 128) {
          break
        }
      }
    }
    return [...merged.entries()].map(([id, entry]) => ({
      id,
      extensions: [...entry.extensions].slice(0, 32),
      aliases: [...entry.aliases].slice(0, 16)
    }))
  }

  /**
   * Merged contributed snippets (bounded). Snippet files are parsed
   * as JSON/JSONC (comment-stripped, capped); bodies capped per
   * snippet. Optionally filtered by language id.
   */
  async getSnippets(languageId?: string): Promise<readonly { language: string; prefix: string; body: string; description: string }[]> {
    const snapshots = await this.installedManifests()
    const out: { language: string; prefix: string; body: string; description: string }[] = []
    for (const snapshot of snapshots) {
      if (out.length >= 512 || snapshot.manifest?.contributes == null) {
        continue
      }
      const parsed = parseContributions(snapshot.manifest.contributes)
      for (const snippet of parsed.snippets) {
        if (out.length >= 512) {
          break
        }
        if (languageId !== undefined && snippet.language !== languageId) {
          continue
        }
        const data = this.readContributionJson(snapshot.identity, snippet.path, 512 * 1024)
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          continue
        }
        for (const entry of Object.values(data as Record<string, unknown>).slice(0, 128)) {
          if (out.length >= 512) {
            break
          }
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            continue
          }
          const record = entry as Record<string, unknown>
          const prefixRaw = record['prefix']
          const prefix = Array.isArray(prefixRaw)
            ? prefixRaw.filter((part): part is string => typeof part === 'string').slice(0, 4).join(', ')
            : typeof prefixRaw === 'string' ? prefixRaw : null
          const bodyRaw = record['body']
          const body = Array.isArray(bodyRaw)
            ? bodyRaw.filter((part): part is string => typeof part === 'string').slice(0, 32).join('\n')
            : typeof bodyRaw === 'string' ? bodyRaw : null
          if (prefix === null || prefix === '' || body === null || body === '') {
            continue
          }
          out.push({
            language: snippet.language,
            prefix: prefix.slice(0, 128),
            body: body.slice(0, 4096),
            description: typeof record['description'] === 'string' ? record['description'].slice(0, 512) : ''
          })
        }
      }
    }
    return out
  }

  /**
   * Reads one contributed editor theme (bounded, containment-checked).
   * Returns the editor-relevant subset (colors + tokenColors); the
   * renderer maps it into Monaco only — never the application shell.
   */
  async getThemeData(
    rawIdentity: unknown,
    themeId: string
  ): Promise<{ uiTheme: string; colors: Record<string, string>; tokenColors: readonly { scope?: string | readonly string[]; settings: { foreground?: string; fontStyle?: string } }[] } | null> {
    const identity = validatedInstallIdentity(rawIdentity)
    if (typeof themeId !== 'string' || themeId === '' || themeId.length > 256) {
      throw new ExtensionActivationError('invalid-request', 'That theme request is not valid.')
    }
    const snapshots = await this.installedManifests()
    const snapshot = snapshots.find((entry) => extensionInstanceId(entry.identity) === extensionInstanceId(identity))
    if (snapshot?.manifest?.contributes == null) {
      return null
    }
    const parsed = parseContributions(snapshot.manifest.contributes)
    const theme = parsed.themes.find((entry) => entry.id === themeId || entry.label === themeId)
    if (theme === undefined) {
      return null
    }
    const data = this.readContributionJson(identity, theme.path, 512 * 1024)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return null
    }
    const record = data as Record<string, unknown>
    const colors: Record<string, string> = {}
    if (record['colors'] !== null && typeof record['colors'] === 'object' && !Array.isArray(record['colors'])) {
      for (const [key, value] of Object.entries(record['colors'] as Record<string, unknown>).slice(0, 256)) {
        if (typeof value === 'string' && /^#[0-9a-fA-F]{6,8}$/.test(value)) {
          colors[key.slice(0, 128)] = value
        }
      }
    }
    const tokenColors: { scope?: string | readonly string[]; settings: { foreground?: string; fontStyle?: string } }[] = []
    if (Array.isArray(record['tokenColors'])) {
      for (const entry of record['tokenColors'].slice(0, 256)) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          continue
        }
        const item = entry as Record<string, unknown>
        const settings = item['settings']
        if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
          continue
        }
        const settingsRecord = settings as Record<string, unknown>
        const normalized: { scope?: string | readonly string[]; settings: { foreground?: string; fontStyle?: string } } = {
          settings: {
            foreground: typeof settingsRecord['foreground'] === 'string' ? settingsRecord['foreground'].slice(0, 16) : undefined,
            fontStyle: typeof settingsRecord['fontStyle'] === 'string' ? settingsRecord['fontStyle'].slice(0, 32) : undefined
          }
        }
        const scope = item['scope']
        if (typeof scope === 'string') {
          normalized.scope = scope.slice(0, 512)
        } else if (Array.isArray(scope)) {
          normalized.scope = scope.filter((part): part is string => typeof part === 'string').slice(0, 16).map((part) => part.slice(0, 128))
        }
        tokenColors.push(normalized)
      }
    }
    return { uiTheme: theme.uiTheme, colors, tokenColors }
  }

  /**
   * Reads one contributed icon theme (bounded, containment-checked).
   * Icon files resolve to bounded `data:` URLs scoped to Explorer
   * file/folder rows — never STARK branding.
   */
  async getIconTheme(
    rawIdentity: unknown,
    themeId: string
  ): Promise<{ fileExtensions: Record<string, string>; fileNames: Record<string, string>; icons: Record<string, string> } | null> {
    const identity = validatedInstallIdentity(rawIdentity)
    if (typeof themeId !== 'string' || themeId === '' || themeId.length > 256) {
      throw new ExtensionActivationError('invalid-request', 'That icon-theme request is not valid.')
    }
    const snapshots = await this.installedManifests()
    const snapshot = snapshots.find((entry) => extensionInstanceId(entry.identity) === extensionInstanceId(identity))
    if (snapshot?.manifest?.contributes == null) {
      return null
    }
    const parsed = parseContributions(snapshot.manifest.contributes)
    const theme = parsed.iconThemes.find((entry) => entry.id === themeId || entry.label === themeId)
    if (theme === undefined) {
      return null
    }
    const data = this.readContributionJson(identity, theme.path, 256 * 1024)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return null
    }
    const record = data as Record<string, unknown>
    const pickMap = (value: unknown): Record<string, string> => {
      const out: Record<string, string> = {}
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return out
      }
      for (const [key, iconId] of Object.entries(value as Record<string, unknown>).slice(0, 512)) {
        if (typeof iconId === 'string' && iconId !== '' && iconId.length <= 128) {
          out[key.slice(0, 64).toLowerCase()] = iconId
        }
      }
      return out
    }
    const fileExtensions = pickMap(record['fileExtensions'])
    const fileNames = pickMap(record['fileNames'])
    const definitions = record['iconDefinitions']
    const icons: Record<string, string> = {}
    if (definitions !== null && typeof definitions === 'object' && !Array.isArray(definitions)) {
      for (const [iconId, definition] of Object.entries(definitions as Record<string, unknown>).slice(0, 128)) {
        if (Object.keys(icons).length >= 64) {
          break
        }
        if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
          continue
        }
        const iconPath = (definition as Record<string, unknown>)['iconPath']
        if (typeof iconPath !== 'string' || iconPath === '') {
          continue
        }
        const dataUrl = this.readContributionIcon(identity, theme.path, iconPath)
        if (dataUrl !== null) {
          icons[iconId.slice(0, 128)] = dataUrl
        }
      }
    }
    return { fileExtensions, fileNames, icons }
  }

  /**
   * Merged `contributes.jsonValidation` schemas across enabled
   * installed extensions (bounded, deterministic). Local schemas are
   * read containment-checked from the owning extension directory;
   * remote schemas resolve through the session-cached bounded
   * main-owned fetch (offline/unreachable entries are skipped, never
   * renderer-fetched). Derived from current enabled state on every
   * call, so disable/uninstall drops that owner's entries with no
   * separate unregister path. Returns inline schemas for Monaco —
   * the renderer performs no schema networking.
   */
  async listJsonSchemas(): Promise<readonly ResolvedJsonSchema[]> {
    const snapshots = await this.installedManifests()
    let enabledFlags: Map<string, boolean>
    try {
      const listed = await this.installService.listInstalled()
      enabledFlags = new Map(
        listed.map((entry) => [`${entry.namespace}.${entry.name}@${entry.version}`, entry.enabled])
      )
    } catch {
      enabledFlags = new Map()
    }
    const out: ResolvedJsonSchema[] = []
    const sorted = snapshots.sort((a, b) => extensionInstanceId(a.identity).localeCompare(extensionInstanceId(b.identity)))
    for (const snapshot of sorted) {
      if (out.length >= JSON_SCHEMA_MAX_MERGED) {
        break
      }
      const owner = extensionInstanceId(snapshot.identity)
      if (enabledFlags.get(owner) === false) {
        continue
      }
      if (snapshot.manifest?.contributes == null) {
        continue
      }
      const parsed = parseContributions(snapshot.manifest.contributes)
      if (parsed.jsonValidation.length === 0) {
        continue
      }
      const extensionBase = join(this.installRoot, `${snapshot.identity.namespace}.${snapshot.identity.name}`, snapshot.identity.version, 'extension')
      for (const entry of parsed.jsonValidation) {
        if (out.length >= JSON_SCHEMA_MAX_MERGED) {
          break
        }
        const fileMatch = toMonacoFilePatterns(entry.fileMatch)
        if (fileMatch.length === 0) {
          continue
        }
        if (isLocalSchemaUrl(entry.url)) {
          const schema = readLocalJsonSchema(extensionBase, entry.url)
          if (schema === null) {
            continue
          }
          out.push({ owner, fileMatch, url: entry.url, schema })
          continue
        }
        const cached = this.remoteSchemaCache.get(entry.url)
        if (cached !== undefined) {
          if (cached !== null) {
            out.push({ owner, fileMatch, url: entry.url, schema: cached })
          }
          continue
        }
        let fetched: Record<string, unknown> | null
        try {
          fetched = await fetchRemoteJsonSchema(entry.url)
        } catch {
          fetched = null
        }
        if (this.remoteSchemaCache.size >= 64) {
          const oldest = this.remoteSchemaCache.keys().next()
          if (!oldest.done) {
            this.remoteSchemaCache.delete(oldest.value)
          }
        }
        this.remoteSchemaCache.set(entry.url, fetched)
        if (fetched !== null) {
          out.push({ owner, fileMatch, url: entry.url, schema: fetched })
        }
      }
    }
    return out
  }

  /** Selected editor + icon themes (null = STARK defaults). */
  getSelectedThemes(): { editor: SelectedThemeRef | null; icon: SelectedThemeRef | null } {    const prefs = readExtensionPrefs(this.installRoot)
    return { editor: prefs.selectedEditorTheme, icon: prefs.selectedIconTheme }
  }

  /** Selects (or clears) an editor/icon theme (explicit user action). */
  setSelectedTheme(kind: 'editor' | 'icon', ref: SelectedThemeRef | null): { editor: SelectedThemeRef | null; icon: SelectedThemeRef | null } {
    if (kind !== 'editor' && kind !== 'icon') {
      throw new ExtensionActivationError('invalid-request', 'That theme request is not valid.')
    }
    if (ref !== null) {
      if (typeof ref.extensionId !== 'string' || typeof ref.themeId !== 'string' || ref.extensionId === '' || ref.themeId === '') {
        throw new ExtensionActivationError('invalid-request', 'That theme request is not valid.')
      }
    }
    const current = readExtensionPrefs(this.installRoot)
    const next = kind === 'editor' ? { ...current, selectedEditorTheme: ref } : { ...current, selectedIconTheme: ref }
    writeExtensionPrefs(this.installRoot, next)
    return { editor: next.selectedEditorTheme, icon: next.selectedIconTheme }
  }

  private readContributionJson(identity: ValidatedInstallIdentity, relPath: string, maxBytes: number): unknown {
    const bytes = this.readContributionBytes(identity, relPath, maxBytes)
    if (bytes === null) {
      return null
    }
    try {
      return JSON.parse(stripJsonComments(bytes.toString('utf8'))) as unknown
    } catch {
      return null
    }
  }

  private readContributionIcon(identity: ValidatedInstallIdentity, themePath: string, iconPath: string): string | null {
    if (typeof iconPath !== 'string' || iconPath === '' || iconPath.length > 512 || iconPath.includes('\0')) {
      return null
    }
    // Icon paths resolve relative to the theme file's directory.
    // SVG only: raster/vector formats outside this allowlist fall
    // back to STARK glyphs (never fetched, never executed).
    const themeDir = themePath.split('/').slice(0, -1).join('/')
    const joined = themeDir === '' ? iconPath : `${themeDir}/${iconPath}`
    if (!/\.svg$/i.test(joined)) {
      return null
    }
    const bytes = this.readContributionBytes(identity, joined, 64 * 1024)
    if (bytes === null) {
      return null
    }
    const text = bytes.toString('utf8')
    if (text.includes('<script') || text.includes('javascript:')) {
      return null
    }
    return `data:image/svg+xml;base64,${bytes.toString('base64')}`
  }

  private readContributionBytes(identity: ValidatedInstallIdentity, relPath: string, maxBytes: number): Buffer | null {
    if (typeof relPath !== 'string' || relPath === '' || relPath.length > 512 || relPath.includes('\0')) {
      return null
    }
    if (relPath.includes('\\') || relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) {
      return null
    }
    const base = resolve(join(this.installRoot, `${identity.namespace}.${identity.name}`, identity.version, 'extension'))
    const candidate = resolve(base, relPath)
    const baseLower = base.toLowerCase()
    const candidateLower = candidate.toLowerCase()
    if (candidateLower !== baseLower && !candidateLower.startsWith(`${baseLower}${sep}`)) {
      return null
    }
    try {
      const stats = lstatSync(candidate)
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size <= 0 || stats.size > maxBytes) {
        return null
      }
      return readFileSync(candidate)
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------------
  // Host-cooperation caches (pull reads for the renderer)
  // ------------------------------------------------------------------

  listNotifications(): readonly NotificationRecord[] {
    return [...this.notifications].slice(-RUNTIME_MAX_NOTIFICATIONS)
  }

  listEditProposals(): readonly EditProposalRecord[] {
    return [...this.proposals]
  }

  dismissProposal(proposalId: string): boolean {
    const index = this.proposals.findIndex((entry) => entry.proposalId === proposalId)
    if (index === -1) {
      return false
    }
    this.proposals.splice(index, 1)
    return true
  }

  listDiagnostics(uri?: string): readonly DiagnosticRecord[] {
    if (uri === undefined) {
      return [...this.diagnostics].slice(0, 2000)
    }
    return this.diagnostics.filter((entry) => entry.uri === uri).slice(0, 2000)
  }

  getOutput(channel: string): readonly string[] {
    return [...(this.output.get(channel) ?? [])]
  }

  listOutputChannels(): readonly string[] {
    return [...this.output.keys()].slice(0, RUNTIME_MAX_OUTPUT_CHANNELS)
  }

  listStatusItems(): readonly StatusItemRecord[] {
    return [...this.statusItems.values()].filter((item) => item.visible).slice(0, RUNTIME_MAX_STATUS_ITEMS)
  }

  listPrompts(): readonly PromptRecord[] {
    return [...this.prompts.values()].map((entry) => entry.record)
  }

  /** Resolves one pending renderer prompt (quick pick / input box). */
  resolvePrompt(promptId: string, response: { selected?: unknown; value?: string; cancelled?: boolean }): boolean {
    const pending = this.prompts.get(promptId)
    if (pending === undefined) {
      return false
    }
    this.prompts.delete(promptId)
    clearTimeout(pending.timer)
    try {
      if (response.cancelled === true) {
        pending.resolve(null)
      } else if (pending.record.kind === 'quickPick') {
        pending.resolve({ selected: response.selected ?? null })
      } else {
        pending.resolve(typeof response.value === 'string' ? { value: response.value.slice(0, 2048) } : null)
      }
    } catch {
      // Best effort.
    }
    return true
  }

  // ------------------------------------------------------------------
  // Host request / notify plumbing
  // ------------------------------------------------------------------

  private async answerHostRequest(request: HostRequestPayload): Promise<void> {
    const { requestId, type, payload } = request
    const respond = (response: Record<string, unknown> | null): void => {
      if (this.manager.getStatus().state !== 'ready') {
        return
      }
      try {
        this.manager.postToHost(buildHostPayloadMessage('HOST_RESPONSE', { requestId, response }))
      } catch {
        // Best effort.
      }
    }
    try {
      switch (type) {
        case 'findFiles': {
          const pattern = boundedText(payload['pattern'], 256)
          const maxResults = Math.max(1, Math.min(100, Math.floor(Number(payload['maxResults'] ?? 100))))
          if (pattern === null || this.workspaceFiles === undefined) {
            respond({ uris: [] })
            return
          }
          respond({ uris: this.workspaceFiles.listFiles(pattern, maxResults).slice(0, maxResults) })
          return
        }
        case 'openDocument':
        case 'fsRead': {
          const uri = boundedText(payload['uri'], 4096)
          if (uri === null || this.workspaceFiles === undefined) {
            respond(null)
            return
          }
          const relative = relativePathFromUri(uri, this.workspaceRootProvider?.() ?? null)
          if (relative === null) {
            respond(null)
            return
          }
          const file = this.workspaceFiles.readFile(relative, RUNTIME_MAX_DOCUMENT_BYTES)
          if (file === null) {
            respond(null)
            return
          }
          if (type === 'openDocument') {
            respond({ text: file.text, languageId: file.languageId })
          } else {
            respond({ content: Buffer.from(file.text, 'utf8').toString('base64') })
          }
          return
        }
        case 'fsStat': {
          const uri = boundedText(payload['uri'], 4096)
          if (uri === null || this.workspaceFiles === undefined) {
            respond(null)
            return
          }
          const relative = relativePathFromUri(uri, this.workspaceRootProvider?.() ?? null)
          if (relative === null) {
            respond(null)
            return
          }
          respond(this.workspaceFiles.statFile(relative))
          return
        }
        case 'showQuickPick':
        case 'showInputBox': {
          const owner = boundedText(payload['owner'], 321) ?? 'unknown'
          const record: PromptRecord = type === 'showQuickPick'
            ? {
                promptId: requestId,
                owner,
                kind: 'quickPick',
                items: Array.isArray(payload['items']) ? payload['items'].filter((entry): entry is string => typeof entry === 'string').slice(0, 32) : [],
                placeHolder: boundedText(payload['placeHolder'], 256) ?? undefined,
                canPickMany: payload['canPickMany'] === true
              }
            : {
                promptId: requestId,
                owner,
                kind: 'inputBox',
                prompt: boundedText(payload['prompt'], 512) ?? undefined,
                placeHolder: boundedText(payload['placeHolder'], 256) ?? undefined,
                value: boundedText(payload['value'], 2048) ?? undefined,
                password: payload['password'] === true
              }
          if (this.prompts.size >= RUNTIME_MAX_PROMPTS) {
            respond(null)
            return
          }
          const timer = setTimeout(() => {
            const pending = this.prompts.get(requestId)
            if (pending !== undefined) {
              this.prompts.delete(requestId)
              pending.resolve(null)
            }
          }, this.promptTimeoutMs)
          this.prompts.set(requestId, {
            record,
            resolve: (response) => {
              clearTimeout(timer)
              respond(response)
            },
            timer
          })
          try {
            this.promptListener?.(record)
            this.eventListener?.({ kind: 'prompt', payload: { promptId: requestId } })
          } catch {
            // Listener failures never break the request.
          }
          return
        }
        case 'showTextDocument': {
          this.pushNotification('extension', 'info', 'An extension asked to reveal a document.')
          respond({ opened: false })
          return
        }
        case 'clipboardRead': {
          respond(null)
          return
        }
        case 'activateExtension': {
          const extensionId = boundedText(payload['extensionId'], 321)
          if (extensionId === null) {
            respond({ activated: false })
            return
          }
          const parsed = parseInstanceId(extensionId)
          if (parsed === null) {
            respond({ activated: false })
            return
          }
          try {
            if (!isExtensionTrusted(this.installRoot, parsed)) {
              respond({ activated: false })
              return
            }
            await this.activationService.activateExtension(parsed)
            respond({ activated: true })
          } catch {
            respond({ activated: false })
          }
          return
        }
        case 'activateForCommand': {
          const command = boundedText(payload['command'], 128)
          if (command === null) {
            respond({ activated: false })
            return
          }
          // User-invoked command path: demand-driven activation of the
          // owning extension is the acknowledged action itself.
          const outcome = await this.fireTrigger({ kind: 'command', value: command })
          respond({ activated: outcome.activated.length > 0 })
          return
        }
        default: {
          respond(null)
        }
      }
    } catch {
      respond(null)
    }
  }

  private routeNotify(notify: ExtensionNotifyPayload): void {
    const kind = notify.notify
    const owner = typeof notify.owner === 'string' ? notify.owner : 'unknown'
    try {
      switch (kind) {
        case 'MESSAGE_SHOWN': {
          const message = boundedText(notify.message, 2048)
          if (message === null) {
            return
          }
          const severity = notify.severity === 'warning' || notify.severity === 'error' ? notify.severity : 'info'
          this.pushNotification(owner, severity, message)
          return
        }
        case 'OUTPUT_APPEND': {
          const channel = boundedText(notify.channel, 128)
          const text = typeof notify.text === 'string' ? notify.text.slice(0, 8192) : null
          if (channel === null || text === null) {
            return
          }
          const lines = this.output.get(channel) ?? []
          lines.push(text)
          while (lines.length > RUNTIME_MAX_OUTPUT_LINES) {
            lines.shift()
          }
          this.output.set(channel, lines)
          while (this.output.size > RUNTIME_MAX_OUTPUT_CHANNELS) {
            const oldest = this.output.keys().next().value as string | undefined
            if (oldest === undefined) {
              break
            }
            this.output.delete(oldest)
          }
          return
        }
        case 'OUTPUT_CLEAR': {
          const channel = boundedText(notify.channel, 128)
          if (channel !== null) {
            this.output.delete(channel)
          }
          return
        }
        case 'STATUSBAR_UPDATE': {
          const itemId = Number(notify.itemId)
          if (!Number.isInteger(itemId)) {
            return
          }
          this.statusItems.set(itemId, {
            itemId,
            owner,
            text: typeof notify.text === 'string' ? notify.text.slice(0, 256) : '',
            tooltip: typeof notify.tooltip === 'string' ? notify.tooltip.slice(0, 512) : undefined,
            command: typeof notify.command === 'string' ? notify.command.slice(0, 128) : undefined,
            alignment: notify.alignment === 1 ? 1 : 2,
            priority: typeof notify.priority === 'number' && Number.isFinite(notify.priority) ? notify.priority : 0,
            visible: notify.visible === true
          })
          while (this.statusItems.size > RUNTIME_MAX_STATUS_ITEMS) {
            const oldest = this.statusItems.keys().next().value as number | undefined
            if (oldest === undefined) {
              break
            }
            this.statusItems.delete(oldest)
          }
          return
        }
        case 'STATUSBAR_DISPOSE': {
          const itemId = Number(notify.itemId)
          if (Number.isInteger(itemId)) {
            this.statusItems.delete(itemId)
          }
          return
        }
        case 'DIAGNOSTICS_CHANGED': {
          const collection = boundedText(notify.collection, 128) ?? 'default'
          const entries = Array.isArray(notify.entries) ? notify.entries.slice(0, 256) : []
          for (let index = this.diagnostics.length - 1; index >= 0; index -= 1) {
            const existing = this.diagnostics[index] as DiagnosticRecord
            if (existing.owner === owner && existing.collection === collection) {
              this.diagnostics.splice(index, 1)
            }
          }
          for (const entry of entries) {
            if (this.diagnostics.length >= 10000) {
              break
            }
            if (typeof entry !== 'object' || entry === null) {
              continue
            }
            const record = entry as Record<string, unknown>
            const uri = boundedText(record['uri'], 4096)
            const diagnostics = Array.isArray(record['diagnostics']) ? record['diagnostics'].slice(0, 2000) : []
            if (uri === null) {
              continue
            }
            for (const diagnostic of diagnostics) {
              if (this.diagnostics.length >= 10000) {
                break
              }
              if (typeof diagnostic !== 'object' || diagnostic === null) {
                continue
              }
              const detail = diagnostic as Record<string, unknown>
              const message = boundedText(detail['message'], 2048)
              if (message === null) {
                continue
              }
              this.diagnostics.push({
                owner,
                collection,
                uri,
                severity: typeof detail['severity'] === 'number' ? detail['severity'] : 0,
                message,
                source: typeof detail['source'] === 'string' ? detail['source'].slice(0, 128) : undefined,
                range: normalizeDiagnosticRange(detail['range'])
              })
            }
          }
          this.eventListener?.({ kind: 'diagnostics', payload: { owner } })
          return
        }
        case 'EDIT_PROPOSAL': {
          const edits = Array.isArray(notify.edits) ? notify.edits.slice(0, 64) : []
          const normalized: { uri: string; range: unknown; newText: string }[] = []
          for (const edit of edits) {
            if (typeof edit !== 'object' || edit === null) {
              continue
            }
            const record = edit as Record<string, unknown>
            const uri = boundedText(record['uri'], 4096)
            if (uri === null || typeof record['newText'] !== 'string' || record['newText'].length > RUNTIME_MAX_DOCUMENT_BYTES) {
              continue
            }
            normalized.push({ uri, range: record['range'] ?? null, newText: record['newText'] })
          }
          if (normalized.length === 0) {
            return
          }
          this.proposals.push({ proposalId: shortId(), owner, edits: normalized, receivedAt: Date.now() })
          while (this.proposals.length > RUNTIME_MAX_PROPOSALS) {
            this.proposals.shift()
          }
          this.eventListener?.({ kind: 'edit-proposal', payload: { owner } })
          return
        }
        case 'WATCHER_REGISTER': {
          const pattern = boundedText(notify.pattern, 256)
          const hostWatcherId = Number(notify.watcherId)
          if (pattern === null || !Number.isInteger(hostWatcherId)) {
            return
          }
          try {
            const registration = this.watcherService.register(owner, pattern, hostWatcherId)
            this.watcherRegistrations.set(`${owner}:${hostWatcherId}`, registration.id)
          } catch {
            // Caps/containment failures degrade to no events.
          }
          return
        }
        case 'WATCHER_DISPOSE': {
          const hostWatcherId = Number(notify.watcherId)
          if (!Number.isInteger(hostWatcherId)) {
            return
          }
          const key = `${owner}:${hostWatcherId}`
          const id = this.watcherRegistrations.get(key)
          if (id !== undefined) {
            this.watcherRegistrations.delete(key)
            this.watcherService.unregister(id)
          }
          return
        }
        case 'STORAGE_WRITE': {
          const scope = notify.scope === 'workspace' ? 'workspace' : 'global'
          const key = boundedText(notify.key, 256)
          if (key === null) {
            return
          }
          try {
            if (notify.deleted === true) {
              writeStorageValue(this.installRoot, owner, scope, key, undefined)
            } else {
              writeStorageValue(this.installRoot, owner, scope, key, notify.value ?? null)
            }
          } catch {
            // Quota/shape failures degrade to memory-only state.
          }
          return
        }
        case 'CONFIG_UPDATE': {
          const key = boundedText(notify.key, 256)
          if (key === null) {
            return
          }
          try {
            writeExtensionConfigValue(this.installRoot, owner, key, notify.value ?? null)
          } catch {
            // Shape failures degrade to memory-only state.
          }
          return
        }
        case 'PROGRESS_START': {
          const title = boundedText(notify.title, 256) ?? 'Working…'
          this.pushNotification(owner, 'info', title)
          return
        }
        case 'PROGRESS_END': {
          return
        }
        case 'CLIPBOARD_WRITE': {
          const text = typeof notify.text === 'string' ? notify.text.slice(0, 65536) : ''
          this.eventListener?.({ kind: 'clipboard', payload: { text } })
          return
        }
        case 'PROCESS_SPAWNED': {
          this.childProcessCounts.set(owner, (this.childProcessCounts.get(owner) ?? 0) + 1)
          return
        }
        case 'REGISTRATIONS_CHANGED': {
          const commands = Number(notify.commands ?? 0)
          const providers = Array.isArray(notify.providers) ? notify.providers.filter((entry): entry is string => typeof entry === 'string').slice(0, 16) : []
          this.registrationCounts.set(owner, { commands: Number.isFinite(commands) ? commands : 0, providers })
          return
        }
        default: {
          return
        }
      }
    } catch {
      // Notify routing never breaks the host.
    }
  }

  private pushNotification(owner: string, severity: 'info' | 'warning' | 'error', message: string): void {
    this.notifications.push({ id: shortId(), owner, severity, message: message.slice(0, 2048), receivedAt: Date.now() })
    while (this.notifications.length > RUNTIME_MAX_NOTIFICATIONS) {
      this.notifications.shift()
    }
    try {
      this.eventListener?.({ kind: 'notification', payload: { owner, severity, message: message.slice(0, 2048) } })
    } catch {
      // Best effort fan-out.
    }
  }

  private recordFailure(extensionId: string, code: string, unsupportedApi?: string): void {
    if (this.failures.size >= RUNTIME_MAX_FAILURES && !this.failures.has(extensionId)) {
      return
    }
    this.failures.set(extensionId, { code: code.slice(0, 64), unsupportedApi: unsupportedApi?.slice(0, 256), at: Date.now() })
    if (unsupportedApi !== undefined && unsupportedApi !== '') {
      this.recordUnsupported(extensionId, unsupportedApi)
    }
  }

  private recordUnsupported(extensionId: string, api: string | undefined): void {
    if (typeof api !== 'string' || api === '') {
      return
    }
    let set = this.unsupportedApis.get(extensionId)
    if (set === undefined) {
      set = new Set()
      this.unsupportedApis.set(extensionId, set)
    }
    if (set.size < 16) {
      set.add(api.slice(0, 256))
    }
  }

  private settle(key: string, error: Error | null, value: unknown): void {
    const waiter = this.pending.get(key)
    if (waiter === undefined) {
      return
    }
    this.pending.delete(key)
    clearTimeout(waiter.timer)
    if (error !== null) {
      waiter.reject(error)
    } else {
      waiter.resolve(value as never)
    }
  }

  private failAllPending(error: Error): void {
    for (const [key, waiter] of [...this.pending]) {
      this.pending.delete(key)
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  private rejectAllPrompts(): void {
    for (const [id, prompt] of [...this.prompts]) {
      this.prompts.delete(id)
      clearTimeout(prompt.timer)
      try {
        prompt.resolve(null)
      } catch {
        // Best effort.
      }
    }
  }

  private track<T>(key: string, timeoutMs: number, onTimeout: () => Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(onTimeout())
      }, timeoutMs)
      this.pending.set(key, { resolve: resolve as (value: never) => void, reject, timer })
    })
  }

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
}

function normalizeDiagnosticRange(value: unknown): { start: { line: number; character: number }; end: { line: number; character: number } } {
  const fallback = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
  if (typeof value !== 'object' || value === null) {
    return fallback
  }
  const record = value as Record<string, unknown>
  const start = validPosition(record['start']) ?? fallback.start
  const end = validPosition(record['end']) ?? fallback.end
  return {
    start: { line: Math.min(start.line, 1000000), character: Math.min(start.character, 1000000) },
    end: { line: Math.min(end.line, 1000000), character: Math.min(end.character, 1000000) }
  }
}

function validPosition(value: unknown): { line: number; character: number } | undefined {  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (typeof record['line'] !== 'number' || typeof record['character'] !== 'number') {
    return undefined
  }
  return { line: Math.max(0, Math.floor(record['line'])), character: Math.max(0, Math.floor(record['character'])) }
}

function parseInstanceId(extensionId: string): ValidatedInstallIdentity | null {
  const at = extensionId.lastIndexOf('@')
  const dot = extensionId.indexOf('.')
  if (at === -1 || dot === -1 || dot > at) {
    return null
  }
  try {
    return validatedInstallIdentity({
      namespace: extensionId.slice(0, dot),
      name: extensionId.slice(dot + 1, at),
      version: extensionId.slice(at + 1)
    })
  } catch {
    return null
  }
}

/**
 * Resolves a `file:` folder uri to an absolute host path for
 * existence validation (pure shape check + normalization; the caller
 * stats the result). Returns null for malformed values.
 */
export function folderPathFromUri(uri: string): string | null {
  if (typeof uri !== 'string' || uri === '' || uri.length > 4096 || uri.includes('\0')) {
    return null
  }
  let rest = uri.startsWith('file:') ? uri.slice('file:'.length) : uri
  try {
    rest = decodeURIComponent(rest)
  } catch {
    return null
  }
  rest = rest.replace(/\\/g, '/')
  if (!/^[A-Za-z]:\//.test(rest) && !rest.startsWith('/')) {
    return null
  }
  return rest
}

function relativePathFromUri(uri: string, workspaceRoot: string | null): string | null {  let rest: string
  if (uri.startsWith('file:')) {
    rest = uri.slice('file:'.length)
  } else if (uri === '' || uri.includes('\0') || uri.includes('..') || uri.startsWith('/') || /^[A-Za-z]:/.test(uri)) {
    return null
  } else {
    rest = uri
  }
  try {
    rest = decodeURIComponent(rest)
  } catch {
    return null
  }
  rest = rest.replace(/\\/g, '/')
  if (rest === '' || rest.includes('\0') || rest.includes('..')) {
    return null
  }
  if (workspaceRoot !== null && workspaceRoot !== '') {
    const rootNormalized = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    const lower = rest.toLowerCase()
    const rootLower = rootNormalized.toLowerCase()
    if (lower === rootLower) {
      return null
    }
    if (lower.startsWith(`${rootLower}/`)) {
      return rest.slice(rootNormalized.length + 1)
    }
    // Absolute paths outside the workspace never resolve (containment).
    if (rest.startsWith('/') || /^[A-Za-z]:/.test(rest)) {
      return null
    }
    return rest.replace(/^\/+/, '')
  }
  return rest.replace(/^\/+/, '')
}

function capabilityLabels(options: {
  hasMain: boolean
  activationEvents: readonly string[]
  contributesCommands: number
  providers: readonly string[]
  childProcesses: number
}): readonly string[] {
  const labels: string[] = []
  if (options.hasMain) {
    labels.push('Runs code')
  }
  if (options.hasMain) {
    labels.push('Reads workspace')
  }
  if (options.providers.some((provider) => ['documentFormatter', 'rangeFormatter', 'codeAction', 'rename'].includes(provider)) || options.contributesCommands > 0) {
    labels.push('Proposes workspace edits')
  }
  if (options.childProcesses > 0 || options.activationEvents.some((event) => event.startsWith('onLanguage:') || event.startsWith('workspaceContains:'))) {
    labels.push('May start language servers')
  }
  if (options.providers.length > 0 || options.contributesCommands > 0) {
    labels.push('Stores local data')
  }
  return labels
}

/**
 * Strips JSONC comments (snippet files) with a quote-aware scanner
 * (bounded input, pure). `//` line comments and `/* *\/` blocks
 * outside strings are removed; everything else passes through.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let index = 0
  let inString = false
  let escaped = false
  while (index < text.length) {
    const char = text[index] as string
    const next = text[index + 1] as string | undefined
    if (inString) {
      out += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1
      }
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        index += 1
      }
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out
}
