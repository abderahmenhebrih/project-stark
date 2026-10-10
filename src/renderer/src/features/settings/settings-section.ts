/**
 * Settings V2 top-level sections (locked product decision).
 *
 * - Models: existing provider/key/model configuration (re-housed).
 * - Permissions: existing workspace capability configuration (re-housed).
 * - Account: existing account + local profile presentation (absorbed).
 * - Billing: honest placeholder (no backend yet).
 * - About: real application metadata (no secrets/paths).
 *
 * Renderer-local navigation only: never persisted, no migration.
 * Unknown/stale values normalize to 'models' via normalizeSettingsSection.
 */

export type SettingsSection = 'models' | 'permissions' | 'account' | 'billing' | 'about'

export const SETTINGS_SECTIONS: readonly { readonly kind: SettingsSection; readonly label: string }[] = [
  { kind: 'models', label: 'Models' },
  { kind: 'permissions', label: 'Permissions' },
  { kind: 'account', label: 'Account' },
  { kind: 'billing', label: 'Billing' },
  { kind: 'about', label: 'About' }
]

const KNOWN: ReadonlySet<string> = new Set(SETTINGS_SECTIONS.map((entry) => entry.kind))

/** Normalizes unknown or legacy section values (e.g. old 'ai') to the Models default. */
export function normalizeSettingsSection(value: unknown): SettingsSection {
  return typeof value === 'string' && KNOWN.has(value) ? (value as SettingsSection) : 'models'
}
