import type { ReactElement } from 'react'
import { STARK_ICON_URL } from './brandAssets'
import './StarkMark.css'

interface StarkMarkProps {
  /** Official emblem asset override. Defaults to the official starkicon. */
  readonly src?: string
  readonly size?: 'bar' | 'hero'
  readonly label?: string
}

/**
 * STARK emblem.
 *
 * Renders the official starkicon production asset
 * (src/public/starkicon.png, bundled via brandAssets). The temporary
 * CSS lime/magenta fallback has been retired — production branding
 * always shows the real raster emblem with object-fit: contain.
 */
export function StarkMark({ src = STARK_ICON_URL, size = 'bar', label = 'STARK' }: StarkMarkProps): ReactElement {
  return (
    <span className={`stark-mark stark-mark--${size}`} role="img" aria-label={label}>
      <img className="stark-mark__asset" src={src} alt="" aria-hidden="true" />
    </span>
  )
}
