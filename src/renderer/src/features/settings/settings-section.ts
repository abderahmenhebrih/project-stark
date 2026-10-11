/**
 * Settings top-level sections (locked product decision).
 *
 * - Models: provider/key/model + Brain/Heart chain configuration.
 * - Permissions: workspace capability configuration.
 * - Account: cloud account (Google/GitHub) + local profile presentation.
 * - Billing: STARK Free/Magma/Frost/Void product surface (no payment
 *   backend yet — cards are product information with honest actions).
 * - Styles: global brand style selection (Free/Magma/Frost/Void).
 * - About: real application metadata (no secrets/paths).
 *
 * Renderer-local navigation only: never persisted, no migration.
 * Unknown/stale values normalize to 'models' via normalizeSettingsSection.
 */

export type SettingsSection = 'models' | 'permissions' | 'account' | 'billing' | 'styles' | 'about'

export const SETTINGS_SECTIONS: readonly { readonly kind: SettingsSection; readonly label: string }[] = [
  { kind: 'models', label: 'Models' },
  { kind: 'permissions', label: 'Permissions' },
  { kind: 'account', label: 'Account' },
  { kind: 'billing', label: 'Billing' },
  { kind: 'styles', label: 'Styles' },
  { kind: 'about', label: 'About' }
]

const KNOWN: ReadonlySet<string> = new Set(SETTINGS_SECTIONS.map((entry) => entry.kind))

/** Normalizes unknown or legacy section values (e.g. old 'ai') to the Models default. */
export function normalizeSettingsSection(value: unknown): SettingsSection {
  return typeof value === 'string' && KNOWN.has(value) ? (value as SettingsSection) : 'models'
}
