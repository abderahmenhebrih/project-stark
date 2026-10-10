/**
 * Private main ↔ Terminal Host control protocol.
 *
 * Tiny closed vocabulary over a versioned envelope — no arbitrary
 * method names, no code payloads, no generic RPC, no path commands:
 *
 *   Main → Host:  SHUTDOWN, CREATE, WRITE, RESIZE, KILL
 *   Host → Main:  READY, SHUTDOWN_COMPLETE,
 *                 CREATED, CREATE_FAILED, DATA, EXIT, KILL_RESULT
 *
 * The host owns node-pty handles exclusively so a blocking native
 * ConPTY operation can never stall Electron's main event loop; main
 * stays a narrow broker (shell policy, cwd resolution, ownership,
 * caps). Lifecycle messages stay on the 64 KiB control cap; PTY
 * output chunks reuse the existing 64 KiB terminal output bound.
 * The STARK-owned bootstrap mirrors the envelope in plain JS; a
 * static test asserts both sides name the same types. Every inbound
 * message is validated (envelope, type, cap, schema) before use.
 */

/** Protocol envelope version. Both sides must agree. */
export const TERMINAL_HOST_PROTOCOL = 'stark-terminal-host/v1' as const

/** Maximum accepted control message size (UTF-8 JSON bytes). */
export const TERMINAL_HOST_MAX_MESSAGE_BYTES = 64 * 1024

/** Maximum PTY output payload per DATA message (matches terminal output bound). */
export const TERMINAL_HOST_MAX_DATA_BYTES = 64 * 1024

/** Maximum identifier length (session/request ids). */
export const TERMINAL_HOST_MAX_ID_LENGTH = 128

/** Messages main may send to the host. */
export const TERMINAL_MAIN_TO_HOST_TYPES = ['SHUTDOWN', 'CREATE', 'WRITE', 'RESIZE', 'KILL'] as const

/** Messages the host may send to main. */
export const TERMINAL_HOST_TO_MAIN_TYPES = [
  'READY',
  'SHUTDOWN_COMPLETE',
  'CREATED',
  'CREATE_FAILED',
  'DATA',
  'EXIT',
  'KILL_RESULT'
] as const

export type TerminalMainToHostType = (typeof TERMINAL_MAIN_TO_HOST_TYPES)[number]
export type TerminalHostToMainType = (typeof TERMINAL_HOST_TO_MAIN_TYPES)[number]

export interface TerminalHostControlMessage {
  readonly protocol: string
  readonly type: string
}

function messageByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return TERMINAL_HOST_MAX_MESSAGE_BYTES + 1
  }
}

function isEnvelope(value: unknown): value is TerminalHostControlMessage {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return record['protocol'] === TERMINAL_HOST_PROTOCOL && typeof record['type'] === 'string'
}

/**
 * Validates one inbound host→main message. Returns its type, or null
 * for malformed envelopes, unknown types, or oversized payloads
 * (callers ignore such messages without replying).
 */
export function parseTerminalHostMessage(value: unknown): TerminalHostToMainType | null {
  if (!isEnvelope(value)) {
    return null
  }
  const type = (value as TerminalHostControlMessage).type
  if (!(TERMINAL_HOST_TO_MAIN_TYPES as readonly string[]).includes(type)) {
    return null
  }
  if (messageByteLength(value) > TERMINAL_HOST_MAX_MESSAGE_BYTES) {
    return null
  }
  return type as TerminalHostToMainType
}

/** Builds one outbound main→host message (closed vocabulary only). */
export function buildTerminalHostMessage(type: TerminalMainToHostType): {
  readonly protocol: string
  readonly type: TerminalMainToHostType
} {
  return { protocol: TERMINAL_HOST_PROTOCOL, type }
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= TERMINAL_HOST_MAX_ID_LENGTH
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** CREATE payload: concrete spawn parameters, all main-resolved. */
export interface TerminalHostCreatePayload {
  readonly requestId: string
  readonly sessionId: string
  readonly cwd: string
  readonly shellFile: string
  readonly shellArgs: readonly string[]
  readonly cols: number
  readonly rows: number
  readonly env: Record<string, string>
}

/** WRITE payload: keystrokes for one owned session. */
export interface TerminalHostWritePayload {
  readonly sessionId: string
  readonly data: string
}

/** RESIZE payload: fitted dimensions for one owned session. */
export interface TerminalHostResizePayload {
  readonly sessionId: string
  readonly cols: number
  readonly rows: number
}

/** KILL payload: exact session termination. */
export interface TerminalHostKillPayload {
  readonly requestId: string
  readonly sessionId: string
}

export type TerminalMainToHostPayload =
  | TerminalHostCreatePayload
  | TerminalHostWritePayload
  | TerminalHostResizePayload
  | TerminalHostKillPayload

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false
  }
  return Object.values(value).every((entry) => typeof entry === 'string')
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Builds one outbound main→host payload message. Payload shapes are
 * fixed per type; anything else is a compile-time error.
 */
export function buildTerminalHostPayloadMessage(
  type: 'CREATE',
  payload: TerminalHostCreatePayload
): { readonly protocol: string; readonly type: 'CREATE'; readonly payload: TerminalHostCreatePayload }
export function buildTerminalHostPayloadMessage(
  type: 'WRITE',
  payload: TerminalHostWritePayload
): { readonly protocol: string; readonly type: 'WRITE'; readonly payload: TerminalHostWritePayload }
export function buildTerminalHostPayloadMessage(
  type: 'RESIZE',
  payload: TerminalHostResizePayload
): { readonly protocol: string; readonly type: 'RESIZE'; readonly payload: TerminalHostResizePayload }
export function buildTerminalHostPayloadMessage(
  type: 'KILL',
  payload: TerminalHostKillPayload
): { readonly protocol: string; readonly type: 'KILL'; readonly payload: TerminalHostKillPayload }
export function buildTerminalHostPayloadMessage(type: TerminalMainToHostType, payload: TerminalMainToHostPayload): {
  readonly protocol: string
  readonly type: TerminalMainToHostType
  readonly payload: TerminalMainToHostPayload
} {
  return { protocol: TERMINAL_HOST_PROTOCOL, type, payload }
}

/** CREATED: spawn accepted for one session. */
export interface TerminalHostCreatedPayload {
  readonly requestId: string
  readonly sessionId: string
}

/** CREATE_FAILED: spawn rejected (closed reason code, no paths/PIDs). */
export interface TerminalHostCreateFailedPayload {
  readonly requestId: string
  readonly sessionId: string
  readonly code: 'invalid' | 'spawn_failed'
}

/** DATA: bounded PTY output chunk for one session. */
export interface TerminalHostDataPayload {
  readonly sessionId: string
  readonly data: string
}

/** EXIT: shell exit for one session, delivered once. */
export interface TerminalHostExitPayload {
  readonly sessionId: string
  readonly exitCode: number | null
  readonly signal: number | null
}

/** KILL_RESULT: exact outcome of one KILL request. */
export interface TerminalHostKillResultPayload {
  readonly requestId: string
  readonly sessionId: string
  readonly outcome: 'initiated' | 'gone' | 'failed'
}

export type TerminalHostPayloadMessage =
  | { readonly type: 'CREATED'; readonly payload: TerminalHostCreatedPayload }
  | { readonly type: 'CREATE_FAILED'; readonly payload: TerminalHostCreateFailedPayload }
  | { readonly type: 'DATA'; readonly payload: TerminalHostDataPayload }
  | { readonly type: 'EXIT'; readonly payload: TerminalHostExitPayload }
  | { readonly type: 'KILL_RESULT'; readonly payload: TerminalHostKillResultPayload }

/**
 * Validates one inbound host→main payload message. Returns the typed
 * message, or null for malformed envelopes, unknown types, oversized
 * payloads, or schema violations (callers ignore such messages
 * without replying).
 */
export function parseTerminalHostPayloadMessage(value: unknown): TerminalHostPayloadMessage | null {
  if (!isEnvelope(value)) {
    return null
  }
  if (messageByteLength(value) > TERMINAL_HOST_MAX_MESSAGE_BYTES) {
    return null
  }
  const record = value as unknown as Record<string, unknown>
  const { type, payload } = record
  if (!isRecord(payload)) {
    return null
  }
  switch (type) {
    case 'CREATED':
      return isBoundedId(payload['requestId']) && isBoundedId(payload['sessionId'])
        ? { type, payload: { requestId: payload['requestId'], sessionId: payload['sessionId'] } }
        : null
    case 'CREATE_FAILED':
      return isBoundedId(payload['requestId']) &&
        isBoundedId(payload['sessionId']) &&
        (payload['code'] === 'invalid' || payload['code'] === 'spawn_failed')
        ? {
            type,
            payload: {
              requestId: payload['requestId'],
              sessionId: payload['sessionId'],
              code: payload['code']
            }
          }
        : null
    case 'DATA': {
      if (!isBoundedId(payload['sessionId']) || typeof payload['data'] !== 'string') {
        return null
      }
      try {
        return Buffer.byteLength(payload['data'], 'utf8') <= TERMINAL_HOST_MAX_DATA_BYTES
          ? { type, payload: { sessionId: payload['sessionId'], data: payload['data'] } }
          : null
      } catch {
        return null
      }
    }
    case 'EXIT': {
      const { sessionId, exitCode, signal } = payload
      if (!isBoundedId(sessionId)) {
        return null
      }
      const codeOk = exitCode === null || (typeof exitCode === 'number' && Number.isInteger(exitCode))
      const signalOk = signal === null || (typeof signal === 'number' && Number.isInteger(signal))
      return codeOk && signalOk
        ? { type, payload: { sessionId, exitCode: exitCode as number | null, signal: signal as number | null } }
        : null
    }
    case 'KILL_RESULT':
      return isBoundedId(payload['requestId']) &&
        isBoundedId(payload['sessionId']) &&
        (payload['outcome'] === 'initiated' || payload['outcome'] === 'gone' || payload['outcome'] === 'failed')
        ? {
            type,
            payload: {
              requestId: payload['requestId'],
              sessionId: payload['sessionId'],
              outcome: payload['outcome']
            }
          }
        : null
    default:
      return null
  }
}

/**
 * Validates one inbound main→host payload message (host-side gate).
 * Same closed vocabularies and bounds as main; the host re-checks
 * every field before touching node-pty.
 */
export function parseTerminalMainPayloadMessage(
  value: unknown
): { readonly type: 'CREATE'; readonly payload: TerminalHostCreatePayload } | { readonly type: 'WRITE'; readonly payload: TerminalHostWritePayload } | { readonly type: 'RESIZE'; readonly payload: TerminalHostResizePayload } | { readonly type: 'KILL'; readonly payload: TerminalHostKillPayload } | null {
  if (!isEnvelope(value)) {
    return null
  }
  if (messageByteLength(value) > TERMINAL_HOST_MAX_MESSAGE_BYTES) {
    return null
  }
  const record = value as unknown as Record<string, unknown>
  const { type, payload } = record
  if (!isRecord(payload)) {
    return null
  }
  switch (type) {
    case 'CREATE': {
      const { requestId, sessionId, cwd, shellFile, shellArgs, cols, rows, env } = payload
      if (
        !isBoundedId(requestId) ||
        !isBoundedId(sessionId) ||
        typeof cwd !== 'string' ||
        cwd === '' ||
        typeof shellFile !== 'string' ||
        shellFile === '' ||
        !isStringArray(shellArgs) ||
        !isPositiveInt(cols) ||
        cols > 500 ||
        !isPositiveInt(rows) ||
        rows > 200 ||
        !isStringMap(env)
      ) {
        return null
      }
      return {
        type,
        payload: { requestId, sessionId, cwd, shellFile, shellArgs, cols, rows, env }
      }
    }
    case 'WRITE':
      return isBoundedId(payload['sessionId']) && typeof payload['data'] === 'string' && payload['data'] !== ''
        ? { type, payload: { sessionId: payload['sessionId'] as string, data: payload['data'] as string } }
        : null
    case 'RESIZE': {
      const { sessionId, cols, rows } = payload
      return isBoundedId(sessionId) && isPositiveInt(cols) && cols <= 500 && isPositiveInt(rows) && rows <= 200
        ? { type, payload: { sessionId, cols, rows } }
        : null
    }
    case 'KILL':
      return isBoundedId(payload['requestId']) && isBoundedId(payload['sessionId'])
        ? { type, payload: { requestId: payload['requestId'] as string, sessionId: payload['sessionId'] as string } }
        : null
    default:
      return null
  }
}
