/**
 * Private main ↔ Extension Host control protocol (foundation only).
 *
 * Tiny closed vocabulary over a versioned envelope — no arbitrary
 * method names, no code payloads, no generic RPC, no path commands:
 *
 *   Main → Host:  PING, SHUTDOWN
 *   Host → Main:  READY, PONG, HOST_ERROR, SHUTDOWN_COMPLETE
 *
 * The STARK-owned bootstrap mirrors this envelope in plain JS; a
 * static test asserts both sides name the same types. Every inbound
 * message is validated (envelope, type, 64 KiB cap) before use.
 */

/** Protocol envelope version. Both sides must agree. */
export const EXTENSION_HOST_PROTOCOL = 'stark-extension-host/v1' as const

/** Maximum accepted control message size (UTF-8 JSON bytes). */
export const EXTENSION_HOST_MAX_MESSAGE_BYTES = 64 * 1024

/** Messages main may send to the host. */
export const MAIN_TO_HOST_TYPES = ['PING', 'SHUTDOWN'] as const

/** Messages the host may send to main. */
export const HOST_TO_MAIN_TYPES = ['READY', 'PONG', 'HOST_ERROR', 'SHUTDOWN_COMPLETE'] as const

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
