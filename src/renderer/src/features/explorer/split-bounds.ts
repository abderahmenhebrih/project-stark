/**
 * Pure split-pane bounds for the Session | secondary editor divider
 * (no React imports) so drag math is unit-testable with the Node
 * runner. The split is a continuous session-width percentage — never
 * snapped to presets — clamped dynamically from the measured row
 * width so neither pane can be dragged into an unusable size and the
 * row can never overflow horizontally.
 */

/** Minimum usable Session width in pixels (desktop). */
export const SPLIT_SESSION_MIN_PX = 320

/** Minimum usable secondary editor width in pixels (desktop). */
export const SPLIT_SECONDARY_MIN_PX = 420

/** Divider interaction width plus the row gap, in pixels. */
export const SPLIT_CHROME_PX = 14

/**
 * Clamps a raw session-width percentage into the usable range for a
 * row of `rowWidthPx`. Non-finite or non-positive widths fall back to
 * the neutral 45% default instead of producing NaN bounds.
 */
export function clampSplitPct(rawPct: number, rowWidthPx: number): number {
  const { min, max } = splitBounds(rowWidthPx)
  if (!Number.isFinite(rawPct)) {
    return 45
  }
  if (rawPct < min) {
    return min
  }
  if (rawPct > max) {
    return max
  }
  return rawPct
}

/**
 * Usable session-width percentage range for a row of `rowWidthPx`,
 * derived from the pixel minimums. Degenerate widths collapse to the
 * neutral default point.
 */
export function splitBounds(rowWidthPx: number): { readonly min: number; readonly max: number } {
  if (!Number.isFinite(rowWidthPx) || rowWidthPx <= 0) {
    return { min: 45, max: 45 }
  }
  const usable = Math.max(0, rowWidthPx - SPLIT_CHROME_PX)
  if (usable <= 0) {
    return { min: 45, max: 45 }
  }
  const lo = (SPLIT_SESSION_MIN_PX / usable) * 100
  const hi = 100 - (SPLIT_SECONDARY_MIN_PX / usable) * 100
  if (lo > hi) {
    const pinned = Math.min(100, Math.max(0, lo))
    return { min: pinned, max: pinned }
  }
  return { min: lo, max: hi }
}
