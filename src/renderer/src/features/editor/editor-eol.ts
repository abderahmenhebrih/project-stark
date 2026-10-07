/**
 * Pure line-ending classification for editor safety.
 *
 * Stage 8 guarantees exact content preservation, so Monaco must never
 * silently normalize endings. Uniform LF and uniform CRLF files are
 * editable with the model's EOL pinned to match; anything else
 * (mixed LF/CRLF, lone CR) opens read-only. Never inspects anything
 * beyond the content string itself.
 */

export type EolKind = 'none' | 'lf' | 'crlf' | 'mixed'

/** Copy shown when editing is disabled for line-ending safety. */
export const MIXED_EOL_MESSAGE =
  'This file uses mixed line endings. Editing is disabled to avoid changing its formatting.'

/**
 * Classifies content by line-ending style:
 * - none: no line breaks at all (single line, possibly empty)
 * - lf: only bare LF breaks
 * - crlf: only CRLF breaks
 * - mixed: any mixture, or any lone CR
 */
export function classifyEol(content: string): EolKind {
  let sawLf = false
  let sawCrlf = false
  for (let i = 0; i < content.length; i += 1) {
    const unit = content[i]
    if (unit === '\n') {
      if (i > 0 && content[i - 1] === '\r') {
        sawCrlf = true
      } else {
        sawLf = true
      }
    } else if (unit === '\r') {
      if (!(i + 1 < content.length && content[i + 1] === '\n')) {
        return 'mixed'
      }
    }
  }
  if (sawLf && sawCrlf) {
    return 'mixed'
  }
  if (sawCrlf) {
    return 'crlf'
  }
  if (sawLf) {
    return 'lf'
  }
  return 'none'
}

/** True for content the editor may open read-write. */
export function isEditableEol(kind: EolKind): boolean {
  return kind === 'none' || kind === 'lf' || kind === 'crlf'
}
