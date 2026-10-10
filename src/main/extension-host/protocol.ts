/**
 * Private main ↔ Extension Host control protocol (formatter pilot).
 *
 * Tiny closed vocabulary over a versioned envelope — no arbitrary
 * method names, no code payloads, no generic RPC, no path commands:
 *
 *   Main → Host:  PING, SHUTDOWN,
 *                 ACTIVATE_FORMATTER, FORMAT_DOCUMENT, DEACTIVATE_FORMATTER
 *   Host → Main:  READY, PONG, HOST_ERROR, SHUTDOWN_COMPLETE,
 *                 FORMATTER_READY, FORMAT_RESULT, FORMAT_ERROR,
 *                 FORMATTER_DEACTIVATED
 *
 * Lifecycle messages stay on the 64 KiB control cap. Formatter
 * payloads (document text, edit lists) travel in the same envelope
 * shape but are parsed separately with their own structural schemas
 * and a dedicated format-message cap sized for the 1 MiB editor
 * document bounds. The STARK-owned bootstrap mirrors the envelope in
 * plain JS; a static test asserts both sides name the same types.
 * Every inbound message is validated (envelope, type, cap) before
 * use; payload fields are re-validated by the formatter service.
 */

/** Protocol envelope version. Both sides must agree. */
export const EXTENSION_HOST_PROTOCOL = 'stark-extension-host/v1' as const

/** Maximum accepted control message size (UTF-8 JSON bytes). */
export const EXTENSION_HOST_MAX_MESSAGE_BYTES = 64 * 1024

/**
 * Maximum accepted formatter payload message size (UTF-8 JSON
 * bytes). Sized for the 1 MiB editor document bounds plus envelope
 * overhead — never unbounded.
 */
export const EXTENSION_HOST_MAX_FORMAT_MESSAGE_BYTES = 2 * 1024 * 1024

/** Maximum identifier length inside formatter payloads. */
export const EXTENSION_HOST_MAX_FORMAT_ID_LENGTH = 64

/** Messages main may send to the host. */
export const MAIN_TO_HOST_TYPES = [
  'PING',
  'SHUTDOWN',
  'ACTIVATE_FORMATTER',
  'FORMAT_DOCUMENT',
  'DEACTIVATE_FORMATTER',
  'ACTIVATE_EXTENSION',
  'DEACTIVATE_EXTENSION',
  'PROVIDER_QUERY',
  'EXECUTE_COMMAND',
  'DOCUMENT_EVENT',
  'ACTIVE_EDITOR',
  'WATCHER_EVENT',
  'WORKSPACE_FOLDERS',
  'HOST_RESPONSE'
] as const

/** Messages the host may send to main. */
export const HOST_TO_MAIN_TYPES = [
  'READY',
  'PONG',
  'HOST_ERROR',
  'SHUTDOWN_COMPLETE',
  'FORMATTER_READY',
  'FORMAT_RESULT',
  'FORMAT_ERROR',
  'FORMATTER_DEACTIVATED',
  'EXTENSION_ACTIVATED',
  'EXTENSION_ACTIVATION_ERROR',
  'EXTENSION_DEACTIVATED',
  'HOST_REQUEST',
  'EXTENSION_NOTIFY',
  'PROVIDER_RESULT',
  'COMMAND_RESULT'
] as const

export type MainToHostType = (typeof MAIN_TO_HOST_TYPES)[number]
export type HostToMainType = (typeof HOST_TO_MAIN_TYPES)[number]

export interface HostControlMessage {
  readonly protocol: string
  readonly type: string
}

function messageByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return EXTENSION_HOST_MAX_MESSAGE_BYTES + 1
  }
}

function isEnvelope(value: unknown): value is HostControlMessage {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return record['protocol'] === EXTENSION_HOST_PROTOCOL && typeof record['type'] === 'string'
}

/**
 * Validates one inbound host→main message. Returns its type, or null
 * for malformed envelopes, unknown types, or oversized payloads
 * (callers ignore such messages without replying).
 */
export function parseHostMessage(value: unknown): HostToMainType | null {
  if (!isEnvelope(value)) {
    return null
  }
  const type = (value as HostControlMessage).type
  if (!(HOST_TO_MAIN_TYPES as readonly string[]).includes(type)) {
    return null
  }
  if (messageByteLength(value) > EXTENSION_HOST_MAX_MESSAGE_BYTES) {
    return null
  }
  return type as HostToMainType
}

/** Builds one outbound main→host message (closed vocabulary only). */
export function buildHostMessage(type: MainToHostType): { readonly protocol: string; readonly type: MainToHostType } {
  return { protocol: EXTENSION_HOST_PROTOCOL, type }
}

/** Payload shapes main may send (formatter pilot only). */
export interface ActivateFormatterPayload {
  readonly activationId: string
  /** Main-derived STARK-owned formatter module file URL (never renderer-supplied). */
  readonly formatterModuleUrl: string
  /** Main-derived extension store root for host-side containment checks. */
  readonly storeRoot: string
  /** Main-resolved verified extension directory (under storeRoot). */
  readonly extensionDir: string
}

export interface FormatDocumentPayload {
  readonly requestId: string
  /** Canonical validated absolute file path (parser/config inference only). */
  readonly filePath: string
  readonly languageId: string
  readonly text: string
  readonly eol: 'lf' | 'crlf'
}

export interface DeactivateFormatterPayload {
  readonly activationId: string
}

export type MainToHostPayload =
  | ActivateFormatterPayload
  | FormatDocumentPayload
  | DeactivateFormatterPayload
  | ActivateExtensionPayload
  | DeactivateExtensionPayload
  | ProviderQueryPayload
  | ExecuteCommandPayload
  | DocumentEventPayload
  | ActiveEditorPayload
  | WatcherEventPayload
  | WorkspaceFoldersPayload
  | HostResponsePayload

/**
 * Generic activation payload (Step 7 primary lifecycle).
 *
 * All paths are main-derived absolute paths (never
 * renderer-supplied). The manifest subset is bounded normalized
 * data for host-side cross-checks — the host re-reads
 * `extension/package.json` from disk regardless.
 */
export interface ActivateExtensionPayload {
  readonly activationId: string
  /** Bounded instance id `<namespace>.<name>@<version>` (never a path). */
  readonly extensionId: string
  /** Main-derived extension store root for host-side containment. */
  readonly storeRoot: string
  /** Main-resolved verified version directory (under storeRoot). */
  readonly extensionDir: string
  /** Bounded normalized manifest subset (main/host cross-check). */
  readonly manifest: {
    readonly name: string
    readonly publisher: string
    readonly version: string
    readonly displayName: string
    readonly main: string | null
    readonly browser: string | null
    readonly activationEvents: readonly string[]
    readonly enginesVscode: string | null
  }
}

export interface DeactivateExtensionPayload {
  readonly activationId: string
  readonly extensionId: string
}

/** Language-feature kinds the host can query across active providers. */
export const PROVIDER_QUERY_KINDS = [
  'completion',
  'hover',
  'definition',
  'references',
  'documentSymbols',
  'workspaceSymbols',
  'rename',
  'signatureHelp',
  'codeAction',
  'rangeFormat',
  'codeLens',
  'documentLink',
  'documentHighlight',
  'foldingRange',
  'selectionRange',
  'inlayHint',
  'documentColor'
] as const

export type ProviderQueryKind = (typeof PROVIDER_QUERY_KINDS)[number]

export interface ProviderPositionPayload {
  readonly line: number
  readonly character: number
}

/**
 * Generic language-feature query (Step 8, main→host). Snapshot text
 * travels inline (bounded by the format-message cap); providers run
 * with a 5s bound and merged deterministic results.
 */
export interface ProviderQueryPayload {
  readonly queryId: string
  readonly kind: ProviderQueryKind
  readonly filePath: string
  readonly languageId: string
  readonly text: string
  readonly position?: ProviderPositionPayload
  readonly endPosition?: ProviderPositionPayload
  readonly query?: string
  readonly newName?: string
}

/** Command-palette execution (Step 9, main→host, owner-aware dispatch). */
export interface ExecuteCommandPayload {
  readonly requestId: string
  readonly command: string
  readonly args?: readonly unknown[]
}

/** Document sync event (Step 8, main→host, bounded snapshot). */
export interface DocumentEventPayload {
  readonly event: {
    readonly kind: 'opened' | 'changed' | 'closed'
    readonly uri: string
    readonly languageId?: string
    readonly text?: string
    readonly version?: number
  }
}

/** Active-editor snapshot (Step 8, main→host). */
export interface ActiveEditorPayload {
  readonly editor: { readonly uri: string; readonly languageId: string } | null
}

/** File-watcher dispatch (Step 8, main→host). */
export interface WatcherEventPayload {
  readonly watcherId: number
  readonly kind: 'create' | 'change' | 'delete'
  readonly uri: string
}

/** Answer to a host HOST_REQUEST (Step 8, main→host, correlated). */
export interface HostResponsePayload {
  readonly requestId: string
  readonly response: Record<string, unknown> | null
}

/** Workspace-folder snapshot (Step 8, main→host, validated root only). */
export interface WorkspaceFoldersPayload {
  readonly folders: readonly { readonly uri: string; readonly name: string }[] | null
}

function isShortId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= EXTENSION_HOST_MAX_FORMAT_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  )
}

/**
 * Builds one outbound main→host formatter message. Payload shapes are
 * fixed per type; anything else is a compile-time error. Wire-size is
 * enforced by the host before use.
 */
export function buildHostPayloadMessage(
  type: 'ACTIVATE_FORMATTER',
  payload: ActivateFormatterPayload
): { readonly protocol: string; readonly type: 'ACTIVATE_FORMATTER'; readonly payload: ActivateFormatterPayload }
export function buildHostPayloadMessage(
  type: 'FORMAT_DOCUMENT',
  payload: FormatDocumentPayload
): { readonly protocol: string; readonly type: 'FORMAT_DOCUMENT'; readonly payload: FormatDocumentPayload }
export function buildHostPayloadMessage(
  type: 'DEACTIVATE_FORMATTER',
  payload: DeactivateFormatterPayload
): { readonly protocol: string; readonly type: 'DEACTIVATE_FORMATTER'; readonly payload: DeactivateFormatterPayload }
export function buildHostPayloadMessage(
  type: 'ACTIVATE_EXTENSION',
  payload: ActivateExtensionPayload
): { readonly protocol: string; readonly type: 'ACTIVATE_EXTENSION'; readonly payload: ActivateExtensionPayload }
export function buildHostPayloadMessage(
  type: 'DEACTIVATE_EXTENSION',
  payload: DeactivateExtensionPayload
): { readonly protocol: string; readonly type: 'DEACTIVATE_EXTENSION'; readonly payload: DeactivateExtensionPayload }
export function buildHostPayloadMessage(
  type: 'PROVIDER_QUERY',
  payload: ProviderQueryPayload
): { readonly protocol: string; readonly type: 'PROVIDER_QUERY'; readonly payload: ProviderQueryPayload }
export function buildHostPayloadMessage(
  type: 'EXECUTE_COMMAND',
  payload: ExecuteCommandPayload
): { readonly protocol: string; readonly type: 'EXECUTE_COMMAND'; readonly payload: ExecuteCommandPayload }
export function buildHostPayloadMessage(
  type: 'DOCUMENT_EVENT',
  payload: DocumentEventPayload
): { readonly protocol: string; readonly type: 'DOCUMENT_EVENT'; readonly payload: DocumentEventPayload }
export function buildHostPayloadMessage(
  type: 'ACTIVE_EDITOR',
  payload: ActiveEditorPayload
): { readonly protocol: string; readonly type: 'ACTIVE_EDITOR'; readonly payload: ActiveEditorPayload }
export function buildHostPayloadMessage(
  type: 'WATCHER_EVENT',
  payload: WatcherEventPayload
): { readonly protocol: string; readonly type: 'WATCHER_EVENT'; readonly payload: WatcherEventPayload }
export function buildHostPayloadMessage(
  type: 'WORKSPACE_FOLDERS',
  payload: WorkspaceFoldersPayload
): { readonly protocol: string; readonly type: 'WORKSPACE_FOLDERS'; readonly payload: WorkspaceFoldersPayload }
export function buildHostPayloadMessage(
  type: 'HOST_RESPONSE',
  payload: HostResponsePayload
): { readonly protocol: string; readonly type: 'HOST_RESPONSE'; readonly payload: HostResponsePayload }
export function buildHostPayloadMessage(type: MainToHostType, payload: MainToHostPayload): {
  readonly protocol: string
  readonly type: MainToHostType
  readonly payload: MainToHostPayload
} {
  return { protocol: EXTENSION_HOST_PROTOCOL, type, payload }
}

/** Validated inbound formatter payloads (host→main). */
export interface FormatterReadyPayload {
  readonly activationId: string
}

export interface FormatEditPayload {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number }
    readonly end: { readonly line: number; readonly character: number }
  }
  readonly newText: string
}

export interface FormatResultPayload {
  readonly requestId: string
  readonly edits: readonly FormatEditPayload[]
}

export interface FormatErrorPayload {
  readonly requestId: string
  readonly code: string
}

export interface FormatterDeactivatedPayload {
  readonly activationId: string
}

export type HostPayloadMessage =
  | { readonly type: 'FORMATTER_READY'; readonly payload: FormatterReadyPayload }
  | { readonly type: 'FORMAT_RESULT'; readonly payload: FormatResultPayload }
  | { readonly type: 'FORMAT_ERROR'; readonly payload: FormatErrorPayload }
  | { readonly type: 'FORMATTER_DEACTIVATED'; readonly payload: FormatterDeactivatedPayload }
  | { readonly type: 'EXTENSION_ACTIVATED'; readonly payload: ExtensionActivatedPayload }
  | { readonly type: 'EXTENSION_ACTIVATION_ERROR'; readonly payload: ExtensionActivationErrorPayload }
  | { readonly type: 'EXTENSION_DEACTIVATED'; readonly payload: ExtensionDeactivatedPayload }
  | { readonly type: 'HOST_REQUEST'; readonly payload: HostRequestPayload }
  | { readonly type: 'EXTENSION_NOTIFY'; readonly payload: ExtensionNotifyPayload }
  | { readonly type: 'PROVIDER_RESULT'; readonly payload: ProviderResultPayload }
  | { readonly type: 'COMMAND_RESULT'; readonly payload: CommandResultPayload }

/** Validated inbound generic activation payloads (host→main). */
export interface ExtensionActivatedPayload {
  readonly activationId: string
  readonly extensionId: string
}

export interface ExtensionActivationErrorPayload {
  readonly activationId: string
  readonly extensionId: string
  readonly code: string
  /** Exact unsupported API for diagnostics (bounded, optional). */
  readonly unsupportedApi?: string
}

export interface ExtensionDeactivatedPayload {
  readonly activationId: string
  readonly extensionId: string
}

/** Host-initiated cooperation request kinds (Step 8, closed vocabulary). */
export const HOST_REQUEST_TYPES = [
  'findFiles',
  'openDocument',
  'showQuickPick',
  'showInputBox',
  'showTextDocument',
  'clipboardRead',
  'activateExtension',
  'activateForCommand',
  'fsRead',
  'fsStat'
] as const

export type HostRequestType = (typeof HOST_REQUEST_TYPES)[number]

/** One host→main cooperation request (correlated, bounded). */
export interface HostRequestPayload {
  readonly requestId: string
  readonly type: HostRequestType
  readonly payload: Record<string, unknown>
}

/** Host fire-and-forget notification kinds (Step 8, closed vocabulary). */
export const EXTENSION_NOTIFY_KINDS = [
  'MESSAGE_SHOWN',
  'OUTPUT_APPEND',
  'OUTPUT_CLEAR',
  'STATUSBAR_UPDATE',
  'STATUSBAR_DISPOSE',
  'DIAGNOSTICS_CHANGED',
  'EDIT_PROPOSAL',
  'WATCHER_REGISTER',
  'WATCHER_DISPOSE',
  'STORAGE_WRITE',
  'CONFIG_UPDATE',
  'PROGRESS_START',
  'PROGRESS_END',
  'CLIPBOARD_WRITE',
  'PROCESS_SPAWNED',
  'REGISTRATIONS_CHANGED'
] as const

export type ExtensionNotifyKind = (typeof EXTENSION_NOTIFY_KINDS)[number]

/** One host→main notification (bounded, validated per kind by main). */
export interface ExtensionNotifyPayload {
  readonly notify: ExtensionNotifyKind
  readonly owner?: string
  readonly [field: string]: unknown
}

/** Answer to a main PROVIDER_QUERY (Step 8, correlated, bounded). */
export interface ProviderResultPayload {
  readonly queryId: string
  readonly ok: boolean
  readonly result?: Record<string, unknown>
  readonly code?: string
}

/** Answer to a main EXECUTE_COMMAND (Step 9, correlated, bounded). */
export interface CommandResultPayload {
  readonly requestId: string
  readonly command: string
  readonly ok: boolean
  readonly result?: unknown
  readonly code?: string
  readonly unsupportedApi?: string
}

const EXTENSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*@[0-9A-Za-z][0-9A-Za-z._+-]*$/

function isExtensionId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 321 && EXTENSION_ID_PATTERN.test(value)
}

function isActivationCode(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= EXTENSION_HOST_MAX_FORMAT_ID_LENGTH
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPosition(value: unknown): value is { line: number; character: number } {
  if (!isRecord(value)) {
    return false
  }
  const { line, character } = value
  return (
    typeof line === 'number' &&
    Number.isInteger(line) &&
    line >= 0 &&
    line <= 1_000_000 &&
    typeof character === 'number' &&
    Number.isInteger(character) &&
    character >= 0 &&
    character <= 1_000_000
  )
}

function isEdit(value: unknown): value is FormatEditPayload {
  if (!isRecord(value)) {
    return false
  }
  const { range, newText } = value
  if (!isRecord(range) || !isPosition(range['start']) || !isPosition(range['end'])) {
    return false
  }
  return typeof newText === 'string'
}

/**
 * Validates one inbound host→main formatter message. Returns the
 * typed message, or null for malformed envelopes, unknown types,
 * oversized payloads, or schema violations (callers ignore such
 * messages without replying). Edit ranges are re-validated against
 * the snapshot by the formatter service before use.
 */
export function parseHostPayloadMessage(value: unknown): HostPayloadMessage | null {
  if (!isEnvelope(value)) {
    return null
  }
  if (messageByteLength(value) > EXTENSION_HOST_MAX_FORMAT_MESSAGE_BYTES) {
    return null
  }
  const record = value as unknown as Record<string, unknown>
  const { type, payload } = record
  if (!isRecord(payload)) {
    return null
  }
  switch (type) {
    case 'FORMATTER_READY':
      return isShortId(payload['activationId']) ? { type, payload: { activationId: payload['activationId'] } } : null
    case 'FORMATTER_DEACTIVATED':
      return isShortId(payload['activationId']) ? { type, payload: { activationId: payload['activationId'] } } : null
    case 'FORMAT_ERROR':
      return isShortId(payload['requestId']) && typeof payload['code'] === 'string' && payload['code'] !== '' && payload['code'].length <= EXTENSION_HOST_MAX_FORMAT_ID_LENGTH
        ? { type, payload: { requestId: payload['requestId'], code: payload['code'] } }
        : null
    case 'FORMAT_RESULT': {
      if (!isShortId(payload['requestId']) || !Array.isArray(payload['edits']) || payload['edits'].length > 64) {
        return null
      }
      const edits: FormatEditPayload[] = []
      for (const entry of payload['edits']) {
        if (!isEdit(entry)) {
          return null
        }
        edits.push({ range: entry.range, newText: entry.newText })
      }
      return { type, payload: { requestId: payload['requestId'], edits } }
    }
    case 'EXTENSION_ACTIVATED':
      return isShortId(payload['activationId']) && isExtensionId(payload['extensionId'])
        ? { type, payload: { activationId: payload['activationId'] as string, extensionId: payload['extensionId'] as string } }
        : null
    case 'EXTENSION_DEACTIVATED':
      return isShortId(payload['activationId']) && isExtensionId(payload['extensionId'])
        ? { type, payload: { activationId: payload['activationId'] as string, extensionId: payload['extensionId'] as string } }
        : null
    case 'EXTENSION_ACTIVATION_ERROR': {
      if (!isShortId(payload['activationId']) || !isExtensionId(payload['extensionId']) || !isActivationCode(payload['code'])) {
        return null
      }
      const unsupportedApi = payload['unsupportedApi']
      if (unsupportedApi === undefined) {
        return { type, payload: { activationId: payload['activationId'] as string, extensionId: payload['extensionId'] as string, code: payload['code'] as string } }
      }
      if (typeof unsupportedApi !== 'string' || unsupportedApi === '' || unsupportedApi.length > 256) {
        return null
      }
      return {
        type,
        payload: { activationId: payload['activationId'] as string, extensionId: payload['extensionId'] as string, code: payload['code'] as string, unsupportedApi }
      }
    }
    case 'HOST_REQUEST': {
      if (!isShortId(payload['requestId']) || typeof payload['type'] !== 'string') {
        return null
      }
      if (!(HOST_REQUEST_TYPES as readonly string[]).includes(payload['type'] as string)) {
        return null
      }
      if (!isRecord(payload['payload'])) {
        return null
      }
      return {
        type,
        payload: {
          requestId: payload['requestId'] as string,
          type: payload['type'] as HostRequestType,
          payload: payload['payload'] as Record<string, unknown>
        }
      }
    }
    case 'EXTENSION_NOTIFY': {
      if (typeof payload['notify'] !== 'string') {
        return null
      }
      if (!(EXTENSION_NOTIFY_KINDS as readonly string[]).includes(payload['notify'] as string)) {
        return null
      }
      const owner = payload['owner']
      if (owner !== undefined && !isExtensionId(owner)) {
        return null
      }
      return { type, payload: payload as unknown as ExtensionNotifyPayload }
    }
    case 'PROVIDER_RESULT': {
      if (!isShortId(payload['queryId']) || typeof payload['ok'] !== 'boolean') {
        return null
      }
      if (payload['code'] !== undefined && !isActivationCode(payload['code'])) {
        return null
      }
      return { type, payload: payload as unknown as ProviderResultPayload }
    }
    case 'COMMAND_RESULT': {
      if (!isShortId(payload['requestId']) || typeof payload['command'] !== 'string' || typeof payload['ok'] !== 'boolean') {
        return null
      }
      if (payload['code'] !== undefined && !isActivationCode(payload['code'])) {
        return null
      }
      const unsupportedApi = payload['unsupportedApi']
      if (unsupportedApi !== undefined && (typeof unsupportedApi !== 'string' || unsupportedApi === '' || unsupportedApi.length > 256)) {
        return null
      }
      return { type, payload: payload as unknown as CommandResultPayload }
    }
    default:
      return null
  }
}
