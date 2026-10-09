import type { ReactElement } from 'react'
import './StarkMark.css'

interface StarkMarkProps {
  /** Official emblem asset slot (e.g. a bundled SVG once provided). */
  readonly src?: string
  readonly size?: 'bar' | 'hero'
  readonly label?: string
}

/**
 * STARK emblem slot.
 *
 * Renders the official emblem asset when `src` is provided; until the
 * official logo asset lands in the repository it renders a faithful
 * CSS representation (lime/magenta split) as a temporary
 * stand-in. Never invents a different emblem.
 */
export function StarkMark({ src, size = 'bar', label = 'STARK' }: StarkMarkProps): ReactElement {
  return (
    <span className={`stark-mark stark-mark--${size}`} role="img" aria-label={label}>
      {src !== undefined && src !== '' ? (
        <img className="stark-mark__asset" src={src} alt="" aria-hidden="true" />
      ) : (
        <span className="stark-mark__fallback" aria-hidden="true" />
      )}
    </span>
  )
}
