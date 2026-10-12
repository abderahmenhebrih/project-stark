/**
 * Local-only compatibility diagnostic report (main-side).
 *
 * For a failed extension activation, records: extension id, version,
 * requested API, unsupported API, activation event, safe error
 * category. NEVER records workspace code, prompts, tokens, or secrets.
 * No network transmission exists in this module.
 */

export type CompatErrorCategory =
  | 'unsupported-api'
  | 'unsupported-kind'
  | 'timeout'
  | 'activation-failed'
  | 'host-unavailable'
  | 'proposed-api'
  | 'private-api'

export interface CompatDiagnostic {
  readonly extensionId: string
  readonly version: string
  readonly requestedApi: string | null
  readonly unsupportedApi: string | null
  readonly activationEvent: string | null
  readonly category: CompatErrorCategory
  readonly recordedAt: string
}

const MAX_ENTRIES = 256

const entries: CompatDiagnostic[] = []

function boundId(value: string): string {
  return value.slice(0, 320)
}

/** Records one diagnostic (bounded ring, local only). */
export function recordCompatDiagnostic(input: {
  readonly extensionId: string
  readonly version: string
  readonly requestedApi?: string | null
  readonly unsupportedApi?: string | null
  readonly activationEvent?: string | null
  readonly category: CompatErrorCategory
}): CompatDiagnostic {
  const entry: CompatDiagnostic = {
    extensionId: boundId(String(input.extensionId)),
    version: String(input.version).slice(0, 64),
    requestedApi:
      typeof input.requestedApi === 'string' ? input.requestedApi.slice(0, 256) : null,
    unsupportedApi:
      typeof input.unsupportedApi === 'string' ? input.unsupportedApi.slice(0, 256) : null,
    activationEvent:
      typeof input.activationEvent === 'string' ? input.activationEvent.slice(0, 256) : null,
    category: input.category,
    recordedAt: new Date().toISOString()
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES)
  }
  return entry
}

/** Returns a copy of recent diagnostics (bounded, local only). */
export function recentCompatDiagnostics(): readonly CompatDiagnostic[] {
  return [...entries]
}

/** Test/host reset. */
export function __resetCompatDiagnosticsForTests(): void {
  entries.length = 0
}
