import { MAX_SESSION_TITLE_CODEPOINTS } from './limits'

function countCodePoints(value: string): number {
  return [...value].length
}

function takeCodePoints(value: string, count: number): string {
  return [...value].slice(0, count).join('')
}

/**
 * Derives a deterministic local session title from the first valid
 * user message. Pure and side-effect free: no AI, no I/O, no clock.
 *
 * Surrounding whitespace is trimmed for derivation only, interior
 * whitespace runs (spaces, tabs, newlines) collapse to single spaces,
 * and the result is bounded to MAX_SESSION_TITLE_CODEPOINTS code
 * points with a trailing ellipsis when truncated. Valid messages can
 * never produce an empty title.
 */
export function deriveSessionTitle(content: string): string {
  const collapsed = content.trim().replace(/\s+/g, ' ')
  if (countCodePoints(collapsed) <= MAX_SESSION_TITLE_CODEPOINTS) {
    return collapsed
  }
  return `${takeCodePoints(collapsed, MAX_SESSION_TITLE_CODEPOINTS)}…`
}
