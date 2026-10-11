import starkFullLogoUrl from '../../../public/fullstark.png'
import starkIconUrl from '../../../public/starkicon.png'
import starkWordmarkUrl from '../../../public/starkword.png'
import starkMagmaFullLogoUrl from '../../../public/fullstarkmagma.png'
import starkMagmaIconUrl from '../../../public/starkiconmagma.png'
import starkMagmaWordmarkUrl from '../../../public/starkwordmagma.png'
import starkFrostFullLogoUrl from '../../../public/fullstarkfrost.png'
import starkFrostIconUrl from '../../../public/starkiconfrost.png'
import starkFrostWordmarkUrl from '../../../public/starkwordfrost.png'
import starkVoidFullLogoUrl from '../../../public/fullstarkvoid.png'
import starkVoidIconUrl from '../../../public/starkiconvoid.png'
import starkVoidWordmarkUrl from '../../../public/starkwordvoid.png'

/**
 * Official STARK brand assets (D05 + tier families).
 *
 * Physical sources (do not rename):
 * - src/public/starkicon.png  (emblem-only)
 * - src/public/starkword.png  (wordmark-only)
 * - src/public/fullstark.png  (full lockup)
 * - src/public/starkicon{magma,frost,void}.png
 * - src/public/starkword{magma,frost,void}.png
 * - src/public/fullstark{magma,frost,void}.png
 *
 * Renderer references these through Vite-bundled URLs so dev, build, and
 * packaged Electron all resolve the same packaged assets. No absolute
 * Windows filesystem paths, no runtime filesystem reads, no remote URLs.
 */
export const STARK_ICON_URL: string = starkIconUrl
export const STARK_WORDMARK_URL: string = starkWordmarkUrl
export const STARK_FULL_LOGO_URL: string = starkFullLogoUrl
export const STARK_MAGMA_ICON_URL: string = starkMagmaIconUrl
export const STARK_MAGMA_WORDMARK_URL: string = starkMagmaWordmarkUrl
export const STARK_MAGMA_FULL_LOGO_URL: string = starkMagmaFullLogoUrl
export const STARK_FROST_ICON_URL: string = starkFrostIconUrl
export const STARK_FROST_WORDMARK_URL: string = starkFrostWordmarkUrl
export const STARK_FROST_FULL_LOGO_URL: string = starkFrostFullLogoUrl
export const STARK_VOID_ICON_URL: string = starkVoidIconUrl
export const STARK_VOID_WORDMARK_URL: string = starkVoidWordmarkUrl
export const STARK_VOID_FULL_LOGO_URL: string = starkVoidFullLogoUrl
