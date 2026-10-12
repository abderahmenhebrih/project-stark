/**
 * Canonical AI provider readiness (renderer, pure).
 *
 * Single source of truth behind both the session banner and the Usage
 * sidebar. `configured` means an encrypted credential is stored (says
 * nothing about validity); `ready` additionally requires a selected
 * model. The old split — banner keyed on `configured && model`, Usage
 * keyed on `configured` alone — made "not connected" and
 * "OpenAI · configured" appear at the same time. That contradiction
 * is impossible through this selector: both surfaces render from the
 * same value.
 */

export type ProviderReadiness = 'not-configured' | 'needs-model' | 'ready'

/** Canonical readiness from provider panel state (pure). */
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
  }
}

/** True when the composer can actually send (credential + model). */
export function canSendWithProvider(status: ProviderReadiness): boolean {
  return status === 'ready'
}
