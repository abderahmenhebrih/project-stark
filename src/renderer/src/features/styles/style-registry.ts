/**
 * STARK style registry (Settings → Styles foundation).
 *
 * Four typed brand styles. Magenta stays the secondary accent across
 * all styles; only the primary family changes. Semantic
 * success/warning/error colors are never touched by styles.
 *
 * Application is by CSS custom-property override (see styles/tokens.css
 * `[data-stark-style]` blocks reusing the existing lime/accent token
 * names) plus tier logo-asset selection — no scattered hex values.
 * Selecting a locked style is refused; an entitled style that lapses
 * falls back to the highest currently entitled style.
 */

import type { BrandStyleId } from '../../../../shared/settings/types'
import type { AccountEntitlements } from '../billing/entitlements'

export interface StarkStyleDefinition {
  readonly id: BrandStyleId
  readonly label: string
  readonly colorDescription: string
  readonly primary: string
  readonly primarySoft: string
  readonly secondary: string
  /**
   * Local asset file names (src/public). Bundled URLs resolve through
   * style-assets.ts (renderer-only) so this pure registry stays
   * importable from the Node test runner, which cannot require PNGs.
   */
  readonly fullLogoFile: string
  readonly iconFile: string
  readonly wordmarkFile: string
}

export const STARK_STYLES: readonly StarkStyleDefinition[] = [
  {
    id: 'free',
    label: 'STARK',
    colorDescription: 'Lime + Magenta',
    primary: '#c8ff00',
    primarySoft: 'rgba(200, 255, 0, 0.12)',
    secondary: '#ff2ea6',
    fullLogoFile: 'fullstark.png',
    iconFile: 'starkicon.png',
    wordmarkFile: 'starkword.png'
  },
  {
    id: 'magma',
    label: 'STARK Magma',
    colorDescription: 'Volcano orange + Magenta',
    primary: '#ff6a00',
    primarySoft: 'rgba(255, 106, 0, 0.12)',
    secondary: '#ff2ea6',
    fullLogoFile: 'fullstarkmagma.png',
    iconFile: 'starkiconmagma.png',
    wordmarkFile: 'starkwordmagma.png'
  },
  {
    id: 'frost',
    label: 'STARK Frost',
    colorDescription: 'Frozen white / icy blue + Magenta',
    primary: '#cfe9ff',
    primarySoft: 'rgba(207, 233, 255, 0.14)',
    secondary: '#ff2ea6',
    fullLogoFile: 'fullstarkfrost.png',
    iconFile: 'starkiconfrost.png',
    wordmarkFile: 'starkwordfrost.png'
  },
  {
    id: 'void',
    label: 'STARK Void',
    colorDescription: 'Powder white + Magenta',
    primary: '#f4f4f5',
    primarySoft: 'rgba(244, 244, 245, 0.12)',
    secondary: '#ff2ea6',
    fullLogoFile: 'fullstarkvoid.png',
    iconFile: 'starkiconvoid.png',
    wordmarkFile: 'starkwordvoid.png'
  }
]

const STYLE_ORDER: readonly BrandStyleId[] = ['free', 'magma', 'frost', 'void']

export function findStyleDefinition(id: BrandStyleId): StarkStyleDefinition {
  const found = STARK_STYLES.find((entry) => entry.id === id)
  if (found === undefined) {
    return STARK_STYLES[0] as StarkStyleDefinition
  }
  return found
}



/** True when the entitlements unlock this style right now. */
export function canApplyStyle(id: BrandStyleId, entitlements: AccountEntitlements): boolean {
  return entitlements.unlockedStyles.includes(id)
}

/**
 * Highest currently entitled style at or below the request in style
 * order — used when a subscription lapses under a selected style.
 * Void-activated accounts keep every style (permanent unlock).
 */
export function fallbackStyle(requested: BrandStyleId, entitlements: AccountEntitlements): BrandStyleId {
  if (canApplyStyle(requested, entitlements)) {
    return requested
  }
  const unlocked = new Set(entitlements.unlockedStyles)
  const wanted = STYLE_ORDER.indexOf(requested)
  for (let index = wanted; index >= 0; index -= 1) {
    const candidate = STYLE_ORDER[index]
    if (candidate !== undefined && unlocked.has(candidate)) {
      return candidate
    }
  }
  return 'free'
}

/**
 * Explicit development-only unlock fixture (never production UI, never
 * functional entitlements).
 *
 * BOTH conditions must hold:
 * - `options.dev` is true. Production call sites pass the real build
 *   flag (`isDevelopmentBuild()` in style-assets.ts, backed by
 *   `import.meta.env.DEV`, which Vite compiles to `false` in packaged
 *   builds). In a production build the flag can never be true, so the
 *   query parameter below has zero effect.
 * - the renderer URL carries `?stark-dev-styles=all`.
 *
 * Visual style preview only: it never alters basePlan, Void wallet
 * state, AccountEntitlements, billing, plugins, LoopLink limits, or
 * sponsored-working eligibility (none of those read this fixture).
 */
export function resolveDevStyleUnlock(options?: { readonly dev?: boolean }): readonly BrandStyleId[] | null {
  try {
    if (options?.dev !== true) {
      return null
    }
    // globalThis lookup keeps this module compiling under the Node test
    // config (no DOM lib); non-DOM runtimes simply report no override.
    const holder = globalThis as unknown as { readonly window?: { readonly location?: { readonly search?: string } } }
    const search = holder.window?.location?.search
    if (typeof search !== 'string') {
      return null
    }
    const params = new URLSearchParams(search)
    if (params.get('stark-dev-styles') === 'all') {
      return ['free', 'magma', 'frost', 'void']
    }
    return null
  } catch {
    return null
  }
}
