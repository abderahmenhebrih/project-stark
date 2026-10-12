/**
 * Generic extension-agent provider registry (main-side).
 *
 * Data-driven: providers are records keyed by owning extension +
 * provider id. No vendor unions, no per-vendor branches, no
 * hardcoded extension names — any extension may register a provider
 * through the same narrow shape, and the composer target menu renders
 * whatever is registered. Unregistering removes the row; two
 * providers from separate extensions coexist by construction.
 */

import type { ExtensionAgentCapabilities } from '../../shared/extension-agents/types'

/** One registered agent provider (main-owned record, no secrets). */
export interface RegisteredAgentProvider {
  /** Owning extension coordinates (`namespace.name`). */
  readonly extensionId: string
  readonly namespace: string
  readonly name: string
  readonly version: string
  /** Stable provider id declared by the extension's own manifest. */
  readonly providerId: string
  readonly displayName: string
  /** Contributed command invoked to run the agent (must be contributed). */
  readonly command: string
  readonly capabilities: ExtensionAgentCapabilities
}

function isNonEmptyText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value !== '' && value.length <= maxLength && !value.includes('\0')
}

/** Validates one provider record (narrow bridge — malformed registrations fail closed). */
export function isRegisteredAgentProvider(value: unknown): value is RegisteredAgentProvider {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  const capabilities = record['capabilities']
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
    return false
  }
  const caps = capabilities as Record<string, unknown>
  for (const key of ['chat', 'streaming', 'tools', 'proposals', 'cancellation']) {
    if (typeof caps[key] !== 'boolean') {
      return false
    }
  }
  return (
    isNonEmptyText(record['extensionId'], 256) &&
    isNonEmptyText(record['namespace'], 128) &&
    isNonEmptyText(record['name'], 128) &&
    isNonEmptyText(record['version'], 64) &&
    isNonEmptyText(record['providerId'], 128) &&
    isNonEmptyText(record['displayName'], 128) &&
    isNonEmptyText(record['command'], 128)
  )
}

function providerKey(extensionId: string, providerId: string): string {
  return `${extensionId}::${providerId}`
}

/**
 * Data-driven provider registry: register/unregister/list by exact
 * coordinates. Registering the same coordinates twice replaces the
 * record (re-registration on extension update); unregistering an
 * extension removes all of its providers and never touches others.
 */
export class ExtensionAgentRegistry {
  private readonly providers = new Map<string, RegisteredAgentProvider>()

  register(provider: RegisteredAgentProvider): void {
    if (!isRegisteredAgentProvider(provider)) {
      throw new Error('That agent provider registration is not valid.')
    }
    this.providers.set(providerKey(provider.extensionId, provider.providerId), { ...provider })
  }

  unregisterProvider(extensionId: string, providerId: string): boolean {
    return this.providers.delete(providerKey(extensionId, providerId))
  }

  /** Removes every provider owned by one extension (disable/uninstall path). */
  unregisterForExtension(extensionId: string): number {
    let removed = 0
    for (const key of [...this.providers.keys()]) {
      const record = this.providers.get(key)
      if (record !== undefined && record.extensionId === extensionId) {
        this.providers.delete(key)
        removed += 1
      }
    }
    return removed
  }

  get(extensionId: string, providerId: string): RegisteredAgentProvider | undefined {
    const found = this.providers.get(providerKey(extensionId, providerId))
    return found === undefined ? undefined : { ...found }
  }

  list(): readonly RegisteredAgentProvider[] {
    return [...this.providers.values()]
      .sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0))
      .map((entry) => ({ ...entry }))
  }

  size(): number {
    return this.providers.size
  }
}
