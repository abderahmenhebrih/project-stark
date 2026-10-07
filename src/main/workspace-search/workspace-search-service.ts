import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import type { WorkspaceSearchMatch, WorkspaceSearchResult } from '../../shared/workspace-search/types'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceNotFoundError, WorkspaceUnavailableError } from '../workspace/errors'
import { IGNORED_DIRECTORY_NAMES } from '../workspace-files/limits'
import {
  MAX_MATCHES_PER_FILE,
  MAX_SEARCH_DURATION_MS,
  MAX_SEARCH_FILE_BYTES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_RESULTS,
  MAX_TOTAL_SEARCH_BYTES
} from './limits'
import {
  buildPreview,
  findLiteralOccurrences,
  isSensitiveFileName,
  parseSearchRequest,
  toDisplayColumn,
  type ParsedSearchRequest
} from './search-file'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface WorkspaceSearchServiceOptions {
  /** Monotonic clock override for deterministic time-budget tests. Defaults to Date.now. */
  readonly now?: () => number
}

function compareNames(a: string, b: string): number {
  if (a < b) {
    return -1
  }
  if (a > b) {
    return 1
  }
  return 0
}

/**
 * Splits decoded text into logical lines without regular expressions.
 * Handles LF, CR, and CRLF; terminators are removed (previews never
 * include them). Implemented with char codes so no control bytes appear
 * in this source file.
 */
export function splitContentLines(content: string): string[] {
  const lines: string[] = []
  let start = 0
  let index = 0
  while (index < content.length) {
    const code = content.charCodeAt(index)
    if (code === 13) {
      lines.push(content.slice(start, index))
      if (index + 1 < content.length && content.charCodeAt(index + 1) === 10) {
        index += 2
      } else {
        index += 1
      }
      start = index
    } else if (code === 10) {
      lines.push(content.slice(start, index))
      index += 1
      start = index
    } else {
      index += 1
    }
  }
  lines.push(content.slice(start))
  return lines
}

/**
 * Bounded literal workspace search.
 *
 * Canonical flow: renderer-supplied workspace id plus query only; the
 * persisted root is resolved in the main process and traversal never
 * leaves it. Sequential depth-first walk in sorted name order (global
 * relative-path order), never following symlinks, skipping generated
 * directories (one canonical set shared with Stage 6 Explorer) and
 * likely secret-bearing files. Safe UTF-8 files only (regular file,
 * size-checked before reading, NUL rejected, strict decoding); any
 * single-file failure skips that file and continues. Global budgets
 * (result cap, file cap, byte cap, time cap) stop the walk with
 * truncated:true — bounded partial success, never a hang, never a throw
 * for budget exhaustion.
 */
export class WorkspaceSearchService {
  private readonly now: () => number

  constructor(
    private readonly repository: WorkspaceRepository,
    options?: WorkspaceSearchServiceOptions
  ) {
    this.now = options?.now ?? Date.now
  }

  async search(rawRequest: unknown): Promise<WorkspaceSearchResult> {
    const parsed: ParsedSearchRequest = parseSearchRequest(rawRequest)
    const workspace = this.repository.findById(parsed.workspaceId)
    if (workspace === undefined) {
      throw new WorkspaceNotFoundError()
    }
    let canonicalRoot: string
    try {
      const rootStats = await lstat(workspace.rootPath)
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new WorkspaceUnavailableError()
      }
      canonicalRoot = await realpath(workspace.rootPath)
    } catch (error) {
      if (error instanceof WorkspaceUnavailableError || error instanceof WorkspaceNotFoundError) {
        throw error
      }
      throw new WorkspaceUnavailableError({ cause: error })
    }

    const startedAt = this.now()
    const matches: WorkspaceSearchMatch[] = []
    let filesScanned = 0
    let filesMatched = 0
    let totalBytes = 0
    let truncated = false

    const timeExceeded = (): boolean => this.now() - startedAt > MAX_SEARCH_DURATION_MS

    const shouldStop = (): boolean =>
      truncated || matches.length >= MAX_SEARCH_RESULTS || filesScanned >= MAX_SEARCH_FILES

    const processFile = async (absolutePath: string, relativePath: string): Promise<boolean> => {
      if (timeExceeded()) {
        truncated = true
        return true
      }
      if (matches.length >= MAX_SEARCH_RESULTS || filesScanned >= MAX_SEARCH_FILES) {
        truncated = true
        return true
      }
      const fileName = relativePath.includes('/') ? relativePath.slice(relativePath.lastIndexOf('/') + 1) : relativePath
      if (isSensitiveFileName(fileName)) {
        return false
      }
      let size: number
      try {
        const stats = await lstat(absolutePath)
        if (stats.isSymbolicLink() || !stats.isFile()) {
          return false
        }
        size = stats.size
      } catch {
        return false
      }
      if (size > MAX_SEARCH_FILE_BYTES) {
        return false
      }
      if (totalBytes + size > MAX_TOTAL_SEARCH_BYTES) {
        truncated = true
        return true
      }
      let buffer: Buffer
      try {
        buffer = await readFile(absolutePath)
      } catch {
        return false
      }
      if (buffer.byteLength > MAX_SEARCH_FILE_BYTES) {
        return false
      }
      if (totalBytes + buffer.byteLength > MAX_TOTAL_SEARCH_BYTES) {
        truncated = true
        return true
      }
      totalBytes += buffer.byteLength
      filesScanned += 1
      if (buffer.includes(0)) {
        return false
      }
      let content: string
      try {
        content = UTF8_DECODER.decode(buffer)
      } catch {
        return false
      }
      const lines = splitContentLines(content)
      let matchesInFile = 0
      let matchedThisFile = false
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (matches.length >= MAX_SEARCH_RESULTS) {
          truncated = true
          return true
        }
        if (timeExceeded()) {
          truncated = true
          return true
        }
        const line = lines[lineIndex] ?? ''
        if (line.length === 0) {
          continue
        }
        if (!containsQuery(line, parsed.query, parsed.caseSensitive)) {
          continue
        }
        const occurrences = findLiteralOccurrences(line, parsed.query, parsed.caseSensitive)
        for (const utf16Start of occurrences) {
          if (matchesInFile >= MAX_MATCHES_PER_FILE) {
            break
          }
          if (matches.length >= MAX_SEARCH_RESULTS) {
            truncated = true
            return true
          }
          const column = toDisplayColumn(line, utf16Start)
          matches.push({
            relativePath,
            line: lineIndex + 1,
            column,
            preview: buildPreview(line, column)
          })
          matchesInFile += 1
          matchedThisFile = true
        }
        if (matchesInFile >= MAX_MATCHES_PER_FILE) {
          break
        }
      }
      if (matchedThisFile) {
        filesMatched += 1
      }
      if (matches.length >= MAX_SEARCH_RESULTS) {
        truncated = true
        return true
      }
      if (filesScanned >= MAX_SEARCH_FILES) {
        truncated = true
        return true
      }
      return false
    }

    const visitDirectory = async (absolutePath: string, relativePath: string): Promise<boolean> => {
      if (timeExceeded()) {
        truncated = true
        return true
      }
      if (shouldStop()) {
        truncated = true
        return true
      }
      let dirents: Dirent[]
      try {
        const stats = await lstat(absolutePath)
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          return false
        }
        dirents = await readdir(absolutePath, { withFileTypes: true })
      } catch {
        return false
      }
      const sorted = [...dirents].sort((a, b) => compareNames(a.name, b.name))
      for (const dirent of sorted) {
        if (timeExceeded() || shouldStop()) {
          truncated = true
          return true
        }
        if (dirent.isSymbolicLink()) {
          continue
        }
        const childRelative = relativePath === '' ? dirent.name : `${relativePath}/${dirent.name}`
        const childAbsolute = join(absolutePath, dirent.name)
        if (dirent.isDirectory()) {
          if (IGNORED_DIRECTORY_NAMES.includes(dirent.name)) {
            continue
          }
          const stop = await visitDirectory(childAbsolute, childRelative)
          if (stop) {
            return true
          }
        } else if (dirent.isFile()) {
          const stop = await processFile(childAbsolute, childRelative)
          if (stop) {
            return true
          }
        } else {
          continue
        }
      }
      return false
    }

    await visitDirectory(canonicalRoot, '')
    matches.sort(
      (a, b) =>
        compareNames(a.relativePath, b.relativePath) || a.line - b.line || a.column - b.column
    )
    return {
      workspaceId: workspace.id,
      query: parsed.query,
      matches,
      filesScanned,
      filesMatched,
      truncated
    }
  }
}

/**
 * Fast pre-check before full occurrence enumeration: avoids allocating
 * occurrence arrays for lines that cannot match. Uses indexOf only —
 * never regex built from user input.
 */
function containsQuery(line: string, query: string, caseSensitive: boolean): boolean {
  if (caseSensitive) {
    return line.indexOf(query) !== -1
  }
  return line.toLowerCase().indexOf(query.toLowerCase()) !== -1
}
