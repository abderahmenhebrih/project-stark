import type { BrandStyleId } from '../../../../shared/settings/types'
import { useApp } from '../../app/app-context'
import { styleAssetUrls } from './style-assets'

export interface BrandAssets {
  readonly style: BrandStyleId
  readonly iconUrl: string
  readonly wordmarkUrl: string
  readonly fullLogoUrl: string
}

/**
 * Style-aware brand assets for the current global brand style.
 * Geometry never changes with style — only the asset family and the
 * CSS primary tokens change, so AppChrome layout stays identical.
 */
export function useBrandAssets(): BrandAssets {
  const { brandStyle } = useApp()
  return { style: brandStyle.style, ...styleAssetUrls(brandStyle.style) }
}
