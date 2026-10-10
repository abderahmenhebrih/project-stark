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
  'DEACTIVATE_FORMATTER'
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
  'FORMATTER_DEACTIVATED'
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

export type MainToHostPayload = ActivateFormatterPayload | FormatDocumentPayload | DeactivateFormatterPayload

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
    default:
      return null
  }
}
