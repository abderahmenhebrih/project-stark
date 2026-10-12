/**
 * Kilo Code bridge probe (composer hardening — REAL integration only).
 *
 * Kilo's VS Code extension uses a Kilo CLI backend/server
 * architecture. This module owns the ONLY local detection path:
 * - installed-extension check for a compatible Kilo extension, plus
 * - bounded `kilo --version` CLI probe (main-owned, no shell,
 *   windowsHide, hard timeout, exact-owned cleanup).
 *
 * WRITE SAFETY: no safe proposal-only mechanism has been proven for
 * the installed Kilo surface (no read-only/proposal-only CLI flag,
 * no shadow-workspace protocol, no permission hook STARK can own).
 * Granting Kilo live-workspace write access would violate
 * AI-proposes → human-reviews → Accept-writes. Until a safe
 * mechanism is proven, the adapter reports UNAVAILABLE honestly and
 * startRun refuses. Never weaken STARK safety to make the dropdown
 * look functional.
 */

import { spawn } from 'node:child_process'
import { KILO_ADAPTER_ID, KILO_DISPLAY_NAME, emptyKiloUnavailable, type KiloAvailability } from '../../shared/agent-target/types'
import type { ExternalAgentAdapter } from './external-agent'

/** Bounded Kilo CLI probe budget (fail fast, never poll forever). */
export const KILO_CLI_PROBE_TIMEOUT_MS = 5000

/** Extension coordinates treated as a compatible Kilo agent surface. */
const KILO_EXTENSION_MATCHERS: readonly { readonly namespace: string; readonly name: string }[] = [
  { namespace: 'kilocode', name: 'kilo-code' },
  { namespace: 'kilo-code', name: 'kilo-code' }
]

function isKiloExtension(namespace: string, name: string): boolean {
  const ns = namespace.trim().toLowerCase()
  const nm = name.trim().toLowerCase()
  return KILO_EXTENSION_MATCHERS.some((entry) => entry.namespace === ns && entry.name === nm)
}

/**
 * Pure helper: true when any installed extension is a compatible Kilo
 * surface. No filesystem, no process, no network — unit-testable.
 */
export function hasKiloExtension(
  installed: readonly { readonly namespace: string; readonly name: string }[]
): boolean {
  return installed.some((entry) => isKiloExtension(entry.namespace, entry.name))
}

/** Pure helper: parses `kilo --version` stdout into a short version. */
export function parseKiloVersion(stdout: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(stdout)
  return match !== null && match[1] !== undefined ? match[1] : null
}

/**
 * Bounded CLI probe: spawns `kilo --version` with no shell,
 * windowsHide, exact-owned child, hard timeout. Resolves the version
 * string or null (absent/timed-out/unparseable). Never throws.
 */
export function probeKiloCliVersion(options?: { readonly timeoutMs?: number }): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? KILO_CLI_PROBE_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | null): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    let child: ReturnType<typeof spawn> | null = null
    try {
      child = spawn('kilo', ['--version'], { shell: false, windowsHide: true, timeout: timeoutMs })
    } catch {
      done(null)
      return
    }
    let stdout = ''
    const timer = setTimeout(() => {
      try {
        child?.kill()
      } catch {
        // Best effort; the timeout below still resolves null.
      }
      done(null)
    }, timeoutMs + 250)
    // `timeout` option already bounds the stdio; the timer is the
    // fail-closed net for platforms that ignore it.
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      ;(timer as unknown as { unref: () => void }).unref()
    }
    child.stdout?.on('data', (chunk: unknown) => {
      if (typeof chunk === 'string') {
        stdout += chunk
      } else if (chunk instanceof Buffer) {
        stdout += chunk.toString('utf8')
      }
      if (stdout.length > 4096) {
        stdout = stdout.slice(0, 4096)
      }
    })
    child.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      done(parseKiloVersion(stdout))
    })
  })
}

export interface KiloInstalledEntry {
  readonly namespace: string
  readonly name: string
}

export interface KiloBridgeDeps {
  /**
   * Installed extensions (main-owned registry): either a direct
   * snapshot or a loader. No renderer input, no paths, no versions
   * beyond display metadata.
   */
  readonly listInstalled?: (() => Promise<readonly KiloInstalledEntry[]> | readonly KiloInstalledEntry[]) | readonly KiloInstalledEntry[]
  /** CLI probe override for deterministic tests. */
  readonly probeCli?: () => Promise<string | null>
}

/**
 * Kilo as the first external adapter. availability() performs the
 * real probe; startRun always refuses until a safe proposal-only
 * mechanism is proven (write-safety gate). Renderer receives only
 * the sanitized KiloAvailability — never tokens, env, or URLs.
 */
export class KiloCodeAdapter implements ExternalAgentAdapter {
  readonly id = KILO_ADAPTER_ID
  readonly displayName = KILO_DISPLAY_NAME
  readonly capabilities = { streaming: false, proposalImport: false, readOnly: true } as const

  constructor(private readonly deps: KiloBridgeDeps = {}) {}

  async availability(): Promise<KiloAvailability> {
    let extensionPresent: boolean
    try {
      const source = this.deps.listInstalled
      const installed = typeof source === 'function' ? await source() : (source ?? [])
      extensionPresent = hasKiloExtension(installed)
    } catch {
      extensionPresent = false
    }
    let cliVersion: string | null
    try {
      cliVersion = this.deps.probeCli !== undefined ? await this.deps.probeCli() : await probeKiloCliVersion()
    } catch {
      cliVersion = null
    }
    // No compatible backend installed → honest unavailable state.
    if (!extensionPresent && cliVersion === null) {
      return emptyKiloUnavailable('Kilo bridge not available')
    }
    // A backend exists but no proven safe proposal-only mechanism:
    // remain unavailable with the exact write-safety blocker rather
    // than granting live-workspace writes.
    return {
      status: 'unavailable',
      reason: 'Kilo bridge not available — no safe proposal-only mechanism proven',
      version: cliVersion
    }
  }

  async startRun(): Promise<never> {
    throw new Error('Kilo bridge not available — no safe proposal-only mechanism proven.')
  }
}
