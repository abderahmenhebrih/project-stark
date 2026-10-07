/**
 * Pure Search-result → editor-focus mapping.
 *
 * Validates the 1-based line/column coming from Stage 7 matches and
 * produces the cursor request passed to Monaco's reveal APIs. Invalid
 * lines yield no focus request; columns fall back to 1. No Monaco
 * dependency — the component performs the actual reveal.
 */

export interface EditorFocus {
  readonly lineNumber: number
  readonly column: number
}

/** Focus request for a 1-based line/column, or null when unusable. */
export function toEditorFocus(line: unknown, column: unknown): EditorFocus | null {
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    return null
  }
  const safeColumn = typeof column === 'number' && Number.isInteger(column) && column >= 1 ? column : 1
  return { lineNumber: line, column: safeColumn }
}
