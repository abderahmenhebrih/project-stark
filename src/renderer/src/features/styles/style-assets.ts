import type { BrandStyleId } from '../../../../shared/settings/types'
import {
  STARK_FULL_LOGO_URL,
  STARK_FROST_FULL_LOGO_URL,
  STARK_FROST_ICON_URL,
  STARK_FROST_WORDMARK_URL,
  STARK_ICON_URL,
  STARK_MAGMA_FULL_LOGO_URL,
  STARK_MAGMA_ICON_URL,
  STARK_MAGMA_WORDMARK_URL,
  STARK_VOID_FULL_LOGO_URL,
  STARK_VOID_ICON_URL,
  STARK_VOID_WORDMARK_URL,
  STARK_WORDMARK_URL
} from '../../components/brandAssets'

export interface StyleAssetUrls {
  readonly iconUrl: string
  readonly wordmarkUrl: string
  readonly fullLogoUrl: string
}

/**
 * True only in development builds. Vite statically replaces
 * `import.meta.env.DEV` with `false` in packaged production builds,
 * so development-only fixtures gated on this can never activate in
 * production. Renderer-only module (never imported from Node tests).
 */
export function isDevelopmentBuild(): boolean {
  try {
    return import.meta.env.DEV === true
  } catch {
    return false
  }
}

/**
 * Renderer-only bundled brand URLs per style (Vite-packaged local
 * PNGs, never remote). Kept out of style-registry.ts so the pure
 * registry stays importable from the Node test runner.
 */
export function styleAssetUrls(id: BrandStyleId): StyleAssetUrls {
  switch (id) {
    case 'magma':
      return {
        iconUrl: STARK_MAGMA_ICON_URL,
        wordmarkUrl: STARK_MAGMA_WORDMARK_URL,
        fullLogoUrl: STARK_MAGMA_FULL_LOGO_URL
      }
    case 'frost':
      return {
        iconUrl: STARK_FROST_ICON_URL,
        wordmarkUrl: STARK_FROST_WORDMARK_URL,
        fullLogoUrl: STARK_FROST_FULL_LOGO_URL
      }
    case 'void':
      return {
        iconUrl: STARK_VOID_ICON_URL,
        wordmarkUrl: STARK_VOID_WORDMARK_URL,
        fullLogoUrl: STARK_VOID_FULL_LOGO_URL
      }
    case 'free':
    default:
      return { iconUrl: STARK_ICON_URL, wordmarkUrl: STARK_WORDMARK_URL, fullLogoUrl: STARK_FULL_LOGO_URL }
  }
}
