import { InvalidContextRangeError } from './errors'

/**
 * Pure line-slicing helpers for explicit file context (Stage 15).
 * No filesystem access — callers supply already-validated file text.
 * All line numbers are 1-based inclusive, matching the UI contract.
 */

/** Splits text into lines, tolerating LF, CRLF, and lone CR. */
export function splitLines(content: string): string[] {
  return content.split(/\r\n|\r|\n/)
}

/**
 * Slices an inclusive 1-based range. Rejects reversed ranges,
 * non-positive bounds, and starts past the end. Clamps an
 * over-long end to the last line.
 */
export function sliceLines(content: string, lineStart: number, lineEnd: number): string[] {
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) {
    throw new InvalidContextRangeError()
  }
  if (lineStart < 1 || lineEnd < lineStart) {
    throw new InvalidContextRangeError()
  }
  const lines = splitLines(content)
  if (lineStart > lines.length) {
    throw new InvalidContextRangeError()
  }
  return lines.slice(lineStart - 1, Math.min(lineEnd, lines.length))
}

/**
 * Returns the window around a 1-based anchor line: `radius` lines on
 * each side, clamped to the file. Rejects out-of-file anchors.
 */
export function windowAroundLine(
  content: string,
  line: number,
  radius: number
): { readonly lines: string[]; readonly lineStart: number; readonly lineEnd: number } {
  if (!Number.isInteger(line) || line < 1) {
    throw new InvalidContextRangeError()
  }
  const lines = splitLines(content)
  if (line > lines.length) {
    throw new InvalidContextRangeError()
  }
  const lineStart = Math.max(1, line - radius)
  const lineEnd = Math.min(lines.length, line + radius)
  return { lines: lines.slice(lineStart - 1, lineEnd), lineStart, lineEnd }
}

/** Joins sliced lines with LF for provider/display use. */
export function joinLines(lines: readonly string[]): string {
  return lines.join('\n')
}
