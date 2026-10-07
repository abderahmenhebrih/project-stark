/**
 * Pure/testable Git output parsers (Stage 12).
 *
 * No Node.js APIs, no Git execution — byte/string in, typed domain
 * out. Malformed input fails safely via GitParseError (never partial
 * silent data, never raw output as contract).
 */

import type { GitBranchInfo, GitFileStatus, GitStatusCode } from '../../shared/git/types'
import { GitParseError } from './errors'

const CONFLICT_PAIRS: ReadonlySet<string> = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

function toStatusCode(char: string): GitStatusCode {
  switch (char) {
    case ' ':
    case 'M':
    case 'A':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
    case 'U':
    case '?':
    case '!':
      return char
    default:
      throw new GitParseError({ cause: `unknown status code '${char}'` })
  }
}

function isConflictPair(pair: string): boolean {
  return CONFLICT_PAIRS.has(pair)
}

/**
 * Parses `git status --porcelain=v1 -z --untracked-files=normal` output.
 *
 * NUL-separated records: ordinary entries are `XY <path>\0`; rename/copy
 * entries are `XY <new>\0<old>\0` (arrow omitted, order reversed, no
 * quoting). Empty output means clean.
 */
export function parsePorcelainV1Z(output: Buffer | string): GitFileStatus[] {
  const text = typeof output === 'string' ? output : output.toString('utf8')
  if (text === '') {
    return []
  }
  // Split on NUL; a well-formed stream ends with exactly one trailing NUL.
  const parts = text.split('\0')
  // Remove the single trailing empty segment produced by the final NUL.
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop()
  }
  const files: GitFileStatus[] = []
  let index = 0
  while (index < parts.length) {
    const record = parts[index]
    if (record === undefined || record.length < 4) {
      throw new GitParseError({ cause: 'short status record' })
    }
    const x = record[0] as string
    const y = record[1] as string
    const separator = record[2] as string
    if (separator !== ' ') {
      throw new GitParseError({ cause: 'status record missing separator' })
    }
    const firstPath = record.slice(3)
    if (firstPath === '') {
      throw new GitParseError({ cause: 'status record missing path' })
    }
    const pair = `${x}${y}`
    const indexStatus = toStatusCode(x as string)
    const worktreeStatus = toStatusCode(y as string)
    const needsSecondPath = x === 'R' || y === 'R' || x === 'C' || y === 'C'
    let relativePath = firstPath
    let originalPath: string | null = null
    if (needsSecondPath) {
      const second = parts[index + 1]
      if (second === undefined || second === '') {
        throw new GitParseError({ cause: 'rename/copy record missing original path' })
      }
      // -z order is reversed: first NUL field is the new path.
      relativePath = firstPath
      originalPath = second
      index += 2
    } else {
      index += 1
    }
    const untracked = pair === '??'
    const conflicted = isConflictPair(pair)
    // Conflicted entries group under CONFLICTS only; staged/unstaged
    // stay false so UI grouping never duplicates them.
    const staged = !untracked && !conflicted && x !== ' '
    const unstaged = !untracked && !conflicted && y !== ' '
    files.push({
      relativePath,
      originalPath,
      indexStatus,
      worktreeStatus,
      staged,
      unstaged,
      untracked,
      conflicted
    })
  }
  return files
}

/** Parses `git symbolic-ref --quiet --short HEAD` (exit 0 → branch). */
export function parseSymbolicRef(exitCode: number | null, stdout: string): string | null {
  if (exitCode !== 0) {
    return null
  }
  const name = stdout.trim()
  if (name === '' || name.includes('\0') || name.includes('\n')) {
    throw new GitParseError({ cause: 'malformed branch name' })
  }
  return name
}

/** Parses `git rev-parse --short=12 HEAD` output (detached hash or null). */
export function parseHeadShort(exitCode: number | null, stdout: string): string | null {
  if (exitCode !== 0) {
    return null
  }
  const head = stdout.trim()
  if (!/^[0-9a-f]{4,64}$/i.test(head)) {
    throw new GitParseError({ cause: 'malformed head hash' })
  }
  return head
}

/** Parses `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`. */
export function parseUpstream(exitCode: number | null, stdout: string): string | null {
  if (exitCode !== 0) {
    return null
  }
  const upstream = stdout.trim()
  if (upstream === '' || upstream.includes('\0') || upstream.includes('\n')) {
    throw new GitParseError({ cause: 'malformed upstream' })
  }
  return upstream
}

/**
 * Parses `git rev-list --left-right --count HEAD...@{upstream}` output
 * (`<ahead>\t<behind>`). Strict integers; malformed fails safely.
 */
export function parseAheadBehind(stdout: string): { ahead: number; behind: number } {
  const trimmed = stdout.trim()
  const match = /^(\d+)\s+(\d+)$/.exec(trimmed)
  if (match === null) {
    throw new GitParseError({ cause: 'malformed ahead/behind counts' })
  }
  const ahead = Number(match[1])
  const behind = Number(match[2])
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
    throw new GitParseError({ cause: 'ahead/behind out of range' })
  }
  return { ahead, behind }
}

/** Combines branch primitives into the public branch contract. */
export function buildBranchInfo(input: {
  readonly symbolicName: string | null
  readonly headShort: string | null
  readonly upstream: string | null
  readonly aheadBehind: { ahead: number; behind: number } | null
}): GitBranchInfo {
  if (input.symbolicName !== null) {
    return {
      kind: 'branch',
      name: input.symbolicName,
      head: input.headShort,
      upstream: input.upstream,
      ahead: input.aheadBehind?.ahead ?? null,
      behind: input.aheadBehind?.behind ?? null
    }
  }
  if (input.headShort !== null) {
    return {
      kind: 'detached',
      name: null,
      head: input.headShort,
      upstream: input.upstream,
      ahead: input.aheadBehind?.ahead ?? null,
      behind: input.aheadBehind?.behind ?? null
    }
  }
  return { kind: 'unborn', name: null, head: null, upstream: null, ahead: null, behind: null }
}
