/**
 * Canonical AI provider readiness (renderer, pure).
 *
 * Two independent concepts:
 * - The optional external (BYOK) lane: `not-configured` (no key),
 *   `needs-model` (key but no runnable selection), `ready`.
 * - The intrinsic STARK Free lane: `free` — the included catalog is
 *   always present, so STARK itself is never "not configured" just
 *   because no BYOK key exists.
 *
 * The session banner and the Usage sidebar render from ONE global
 * value: `ready` when the BYOK lane can actually run, `free` when a
 * signed-in account can run the hosted catalog, otherwise
 * `not-configured` (signed out — a sign-in prompt, never an OpenAI
 * demand). `free` sends through hosted inference.
 */

export type ProviderReadiness = 'not-configured' | 'needs-model' | 'ready' | 'free'

/** Canonical BYOK-lane readiness from provider panel state (pure). */
export function providerReadiness(configured: boolean, selectedModel: string | null): ProviderReadiness {
  if (!configured) {
    return 'not-configured'
  }
  if (selectedModel === null) {
    return 'needs-model'
  }
  return 'ready'
}

/** Short status label for the Usage sidebar provider row. */
export function providerReadinessLabel(status: ProviderReadiness): string {
  switch (status) {
    case 'ready':
      return 'Ready'
    case 'needs-model':
      return 'Configured — no model selected'
    case 'not-configured':
      return 'Not configured'
    case 'free':
      return 'STARK Free'
  }
}

/** True when the composer can actually send (BYOK credential + model, or signed-in Free). */
export function canSendWithProvider(status: ProviderReadiness): boolean {
  return status === 'ready' || status === 'free'
}
