/**
 * STARK sponsored-working provider seam.
 *
 * Narrow provider abstraction so a real sponsor provider can be added
 * later without redesigning monetization. No network, no IPC, no API
 * keys, no remote dependencies in this pass.
 *
 * PRIVACY: the provider receives ONLY SponsorPlacementContext
 * ({ placement: 'ai-working' }). The type cannot carry prompt text,
 * responses, code, filenames, workspace paths, terminal contents,
 * attachments, keys, diffs, or tool output — by construction.
 */

import type { SponsorCreative, SponsorPlacementContext } from './sponsor-types'

/** Narrow provider interface for future real sponsor integrations. */
export interface SponsorProvider {
  getCreative(context: SponsorPlacementContext): SponsorCreative | null
}

/**
 * Builds the (minimal, whitelisted) sponsor context. Takes no arguments
 * so sensitive AI/workspace data cannot flow in accidentally; the
 * compiler rejects any call that tries to pass prompt/code/paths.
 */
export function buildSponsorContext(): SponsorPlacementContext {
  return { placement: 'ai-working' }
}

/** Runtime whitelist guard: context must carry exactly the allowed keys. */
const ALLOWED_CONTEXT_KEYS: ReadonlySet<string> = new Set(['placement'])

export function isAllowedSponsorContext(value: unknown): value is SponsorPlacementContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== 'placement') {
    return false
  }
  if (!ALLOWED_CONTEXT_KEYS.has(keys[0] as string)) {
    return false
  }
  return record['placement'] === 'ai-working'
}

/**
 * Production provider: returns null, so production with no sponsor
 * provider renders nothing. This is the provider SessionPanel binds.
 */
export class NullSponsorProvider implements SponsorProvider {
  getCreative(context: SponsorPlacementContext): SponsorCreative | null {
    void context
    return null
  }
}

/**
 * Development/test-only deterministic fixture. Must NEVER become a real
 * remote integration: local structured data only, injected explicitly by
 * tests or dev harnesses — never referenced by production bindings.
 */
export const DEV_SPONSOR_FIXTURE: SponsorCreative = {
  id: 'dev-examplecloud-1',
  sponsorName: 'ExampleCloud',
  message: 'Developer infrastructure for AI applications',
  disclosureLabel: 'Sponsored'
} as const

export class DevFixtureSponsorProvider implements SponsorProvider {
  getCreative(context: SponsorPlacementContext): SponsorCreative | null {
    if (!isAllowedSponsorContext(context)) {
      return null
    }
    return DEV_SPONSOR_FIXTURE
  }
}
