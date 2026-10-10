/**
 * Pure helpers for turning extension edit proposals into
 * human-review change transactions (Step 8+9, renderer-side).
 *
 * Review-before-write is non-negotiable: extension edits NEVER write
 * disk directly. Each proposal uri maps to a workspace-relative path
 * (root-prefix match, case-insensitive on Windows); mapped files load
 * their current content + revision, edits apply in memory, and the
 * result enters the existing change-transaction pipeline (human
 * Accept / Reject). Unmappable uris surface honestly instead of
 * guessing.
 */

export interface ProposalEdit {
  readonly uri: string
  readonly range: unknown
  readonly newText: string
}

export interface ProposalPosition {
  readonly line: number
  readonly character: number
}

export interface ProposalRange {
  readonly start: ProposalPosition
  readonly end: ProposalPosition
}

function isPosition(value: unknown): value is ProposalPosition {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record['line'] === 'number' &&
    Number.isInteger(record['line']) &&
    (record['line'] as number) >= 0 &&
    typeof record['character'] === 'number' &&
    Number.isInteger(record['character']) &&
    (record['character'] as number) >= 0
  )
}

function isRange(value: unknown): value is ProposalRange {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return isPosition(record['start']) && isPosition(record['end'])
}

/**
 * Maps a proposal uri to a workspace-relative path via the workspace
 * root prefix (case-insensitive, slash-normalized). Returns null when
 * the uri is outside the workspace — never guesses.
 */
export function relativePathFromProposalUri(uri: string, rootPath: string): string | null {
  if (typeof uri !== 'string' || uri === '' || typeof rootPath !== 'string' || rootPath === '') {
    return null
  }
  let rest = uri.startsWith('file:') ? uri.slice('file:'.length) : uri
  try {
    rest = decodeURIComponent(rest)
  } catch {
    return null
  }
  const normalized = rest.replace(/\\/g, '/')
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    const relative = normalized.slice(root.length + 1)
    if (relative === '' || relative.includes('..')) {
      return null
    }
    return relative
  }
  // Bare workspace-relative form (`file:src/a.ts`) passes through.
  const bare = normalized.replace(/^\/+/, '')
  if (bare === '' || bare.includes('..') || bare.startsWith('/') || /^[A-Za-z]:/.test(bare)) {
    return null
  }
  return bare
}

function offsetAt(lines: string[], position: ProposalPosition): number {
  const line = Math.min(position.line, lines.length - 1)
  let offset = 0
  for (let index = 0; index < line; index += 1) {
    offset += (lines[index] as string).length + 1
  }
  return offset + Math.min(position.character, (lines[line] as string).length)
}

/**
 * Applies validated proposal edits to file content in memory (pure).
 * Invalid ranges/edits throw — callers surface calm copy and keep
 * the proposal for dismissal. Output capped at 1 MiB.
 */
export function applyProposalEdits(content: string, edits: readonly ProposalEdit[]): string {
  if (edits.length > 64) {
    throw new Error('Too many proposal edits.')
  }
  const lines = content.split('\n')
  const spans: { start: number; end: number; newText: string }[] = []
  for (const edit of edits) {
    if (typeof edit.newText !== 'string' || !isRange(edit.range)) {
      throw new Error('Proposal edit is not valid.')
    }
    const start = offsetAt(lines, edit.range.start)
    const end = offsetAt(lines, edit.range.end)
    if (end < start) {
      throw new Error('Proposal edit is not valid.')
    }
    spans.push({ start, end, newText: edit.newText })
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  for (let index = 1; index < spans.length; index += 1) {
    if ((spans[index] as { start: number }).start < (spans[index - 1] as { end: number }).end) {
      throw new Error('Proposal edits overlap.')
    }
  }
  let result = content
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index] as { start: number; end: number; newText: string }
    result = result.slice(0, span.start) + span.newText + result.slice(span.end)
  }
  if (new TextEncoder().encode(result).length > 1024 * 1024) {
    throw new Error('Proposal result exceeds its bound.')
  }
  return result
}

/** Groups proposal edits by uri (bounded, deterministic order). */
export function groupProposalEditsByUri(edits: readonly ProposalEdit[]): { uri: string; edits: ProposalEdit[] }[] {
  const groups = new Map<string, ProposalEdit[]>()
  for (const edit of edits.slice(0, 64)) {
    const list = groups.get(edit.uri) ?? []
    list.push(edit)
    groups.set(edit.uri, list)
  }
  return [...groups.entries()].map(([uri, group]) => ({ uri, edits: group })).sort((a, b) => (a.uri < b.uri ? -1 : 1))
}
