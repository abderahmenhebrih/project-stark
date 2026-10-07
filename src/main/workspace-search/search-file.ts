import type { WorkspaceSearchRequest } from '../../shared/workspace-search/types'
import { InvalidWorkspaceError } from '../workspace/errors'
import { InvalidSearchQueryError } from './errors'
import {
  MAX_PREVIEW_CHARACTERS,
  MAX_SEARCH_QUERY_CODEPOINTS,
  SENSITIVE_DOTENV_PREFIX,
  SENSITIVE_EXACT_NAMES,
  SENSITIVE_EXTENSIONS
} from './limits'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const ALLOWED_REQUEST_KEYS: readonly string[] = ['workspaceId', 'query', 'caseSensitive']

/** Counts Unicode code points (not UTF-16 units). */
export function countCodePoints(value: string): number {
  return Array.from(value).length
}

/**
 * True when the string contains a C0/C1 control character (U+0000-U+001F,
 * U+007F-U+009F), including newline and tab. Implemented with char codes
 * so no control bytes ever appear in this source file.
 */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true
    }
  }
  return false
}

/**
 * Validates the raw query string.
 *
 * Literal text search only: `* . [ ( backslash` are normal characters,
 * never regex. Validation trims only for the emptiness check; the returned
 * query preserves the user's actual text (including leading/trailing
 * spaces) so matching stays literal. Rejects non-strings, empty or
 * whitespace-only input, overlong input (>256 code points), and any
 * control character (including newline/tab).
 */
export function validateSearchQuery(rawQuery: unknown): string {
  if (typeof rawQuery !== 'string') {
    throw new InvalidSearchQueryError('search query must be a string')
  }
  if (rawQuery.trim().length === 0) {
    throw new InvalidSearchQueryError('search query must contain meaningful text')
  }
  if (countCodePoints(rawQuery) > MAX_SEARCH_QUERY_CODEPOINTS) {
    throw new InvalidSearchQueryError('search query is too long')
  }
  if (hasControlCharacters(rawQuery)) {
    throw new InvalidSearchQueryError('search query contains unsupported characters')
  }
  return rawQuery
}

/** Parsed and validated search request (query preserved verbatim). */
export interface ParsedSearchRequest {
  readonly workspaceId: number
  readonly query: string
  readonly caseSensitive: boolean
}

/**
 * Validates an IPC search payload at runtime.
 *
 * Strict object policy (like settings updates): only workspaceId, query,
 * and caseSensitive are accepted; unknown fields are rejected. The
 * renderer never supplies a filesystem root — only the persisted
 * workspace id, resolved in the main process.
 */
export function parseSearchRequest(raw: unknown): ParsedSearchRequest {
  if (!isRecord(raw)) {
    throw new InvalidSearchQueryError('workspace search request is invalid')
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_REQUEST_KEYS.includes(key)) {
      throw new InvalidSearchQueryError(`unknown search field '${key}'`)
    }
  }
  const workspaceId = raw['workspaceId']
  if (typeof workspaceId !== 'number' || !Number.isInteger(workspaceId) || workspaceId <= 0) {
    throw new InvalidWorkspaceError('workspace reference is invalid')
  }
  const query = validateSearchQuery(raw['query'])
  const caseSensitiveRaw = raw['caseSensitive']
  let caseSensitive = false
  if (caseSensitiveRaw !== undefined) {
    if (typeof caseSensitiveRaw !== 'boolean') {
      throw new InvalidSearchQueryError('caseSensitive must be a boolean')
    }
    caseSensitive = caseSensitiveRaw
  }
  const request: WorkspaceSearchRequest = { workspaceId, query, caseSensitive }
  return { workspaceId: request.workspaceId, query: request.query, caseSensitive }
}

/**
 * Centralized sensitive-file policy.
 *
 * Returns true for likely secret-bearing filenames that automatic search
 * must skip: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
 * `credentials.json`, `credentials.yml`, `credentials.yaml`
 * (case-insensitive). Normal dotfiles (e.g. `.gitignore`) remain
 * searchable. Skipped files stay manual-previewable in Explorer; their
 * contents are never read or exposed by search.
 */
export function isSensitiveFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  if ((SENSITIVE_EXACT_NAMES as readonly string[]).includes(lower)) {
    return true
  }
  if (lower.startsWith(SENSITIVE_DOTENV_PREFIX)) {
    return true
  }
  for (const extension of SENSITIVE_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return true
    }
  }
  return false
}

/**
 * Builds a short line-based preview for one match.
 *
 * Based on the matched line (terminator already removed by the caller),
 * at most MAX_PREVIEW_CHARACTERS code points, rendered as plain text by
 * the UI (never HTML). Short lines return verbatim; long lines return a
 * deterministic window starting ~60 characters before the match so the
 * occurrence stays visible. Unicode-safe via code-point slicing.
 */
export function buildPreview(line: string, column: number): string {
  const characters = Array.from(line)
  if (characters.length <= MAX_PREVIEW_CHARACTERS) {
    return line
  }
  const matchStart = Math.max(0, column - 1)
  const windowStart = Math.min(Math.max(0, matchStart - 60), characters.length - MAX_PREVIEW_CHARACTERS)
  return characters.slice(windowStart, windowStart + MAX_PREVIEW_CHARACTERS).join('')
}

/**
 * Converts a UTF-16 string index into a 1-based Unicode code-point column
 * for display contracts. ASCII results equal index+1; astral characters
 * count as one column each.
 */
export function toDisplayColumn(line: string, utf16Index: number): number {
  return Array.from(line.slice(0, utf16Index)).length + 1
}

/**
 * Finds literal occurrences of the query inside one line.
 *
 * No regular expressions are ever constructed from user input: matching
 * uses String.indexOf only, so special characters stay literal.
 * Case-insensitive mode lowercases both sides deterministically with
 * String.toLowerCase. Returns UTF-16 start indices, non-overlapping, in
 * ascending order.
 */
export function findLiteralOccurrences(line: string, query: string, caseSensitive: boolean): number[] {
  if (query.length === 0) {
    return []
  }
  if (caseSensitive) {
    const indices: number[] = []
    let from = 0
    for (;;) {
      const found = line.indexOf(query, from)
      if (found === -1) {
        return indices
      }
      indices.push(found)
      from = found + query.length
      if (from >= line.length) {
        return indices
      }
    }
  }
  const haystack = line.toLowerCase()
  const needle = query.toLowerCase()
  const indices: number[] = []
  let from = 0
  for (;;) {
    const found = haystack.indexOf(needle, from)
    if (found === -1) {
      return indices
    }
    indices.push(found)
    from = found + needle.length
    if (from >= haystack.length) {
      return indices
    }
  }
}
