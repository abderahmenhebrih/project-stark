import starkFullLogoUrl from '../../../public/fullstark.png'
import starkIconUrl from '../../../public/starkicon.png'
import starkWordmarkUrl from '../../../public/starkword.png'

/**
 * Official STARK brand assets (D05).
 *
 * Physical sources (do not rename):
 * - src/public/starkicon.png  (emblem-only)
 * - src/public/starkword.png  (wordmark-only)
 * - src/public/fullstark.png  (full lockup)
 *
 * Renderer references these through Vite-bundled URLs so dev, build, and
 * packaged Electron all resolve the same packaged assets. No absolute
 * Windows filesystem paths, no runtime filesystem reads, no remote URLs.
 */
export const STARK_ICON_URL: string = starkIconUrl
export const STARK_WORDMARK_URL: string = starkWordmarkUrl
export const STARK_FULL_LOGO_URL: string = starkFullLogoUrl
