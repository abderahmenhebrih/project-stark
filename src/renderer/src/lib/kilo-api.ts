import { KILO_ADAPTER_ID, type KiloAvailability } from '../../../shared/agent-target/types'
import { getStarkApi } from './stark-api'

/**
 * Real Kilo availability probe (renderer side).
 *
 * Reads the REAL installed-extension registry through the existing
 * narrow extensions bridge — no new IPC, no process spawning from
 * the renderer (main owns all privileged operations). Never fakes a
 * working state:
 * - no compatible Kilo extension/CLI installed → unavailable with
 *   "Kilo bridge not available".
 * - a backend is present but no safe proposal-only mechanism has
 *   been proven → unavailable with the exact write-safety blocker.
 * Kilo must enter the Change Transaction / Review flow and never
 * bypass human Accept; until that is proven it stays unselectable.
 */

function isKiloEntry(namespace: string, name: string): boolean {
  const ns = namespace.trim().toLowerCase()
  const nm = name.trim().toLowerCase()
  return (
    (ns === 'kilocode' && nm === 'kilo-code') ||
    (ns === 'kilo-code' && nm === 'kilo-code') ||
    nm === KILO_ADAPTER_ID
  )
}

/** Sanitized Kilo availability for the composer target menu. */
export async function getKiloAvailability(): Promise<KiloAvailability> {
  const api = getStarkApi()?.extensions.listInstalled
  if (api === undefined) {
    return { status: 'unavailable', reason: 'Kilo bridge not available', version: null }
  }
  let installed: readonly { readonly namespace: string; readonly name: string; readonly version: string }[]
  try {
    installed = await api()
  } catch {
    return { status: 'unavailable', reason: 'Kilo bridge not available', version: null }
  }
  const found = installed.find((entry) => isKiloEntry(entry.namespace, entry.name))
  if (found === undefined) {
    return { status: 'unavailable', reason: 'Kilo bridge not available', version: null }
  }
  // A Kilo surface exists, but STARK has no proven safe
  // proposal-only mechanism (no read-only CLI flag, no shadow
  // workspace protocol, no permission hook STARK can own). Live
  // workspace writes stay forbidden — report the blocker honestly.
  return {
    status: 'unavailable',
    reason: 'Kilo bridge not available — no safe proposal-only mechanism proven',
    version: found.version
  }
}
