import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { matchWatcherPattern } from './extension-watchers'
import type { WorkspaceFileAccess } from './extension-runtime-service'

/**
 * Workspace-owned file access for extension cooperation (Step 8,
 * main-side).
 *
 * Serves the runtime's findFiles / openDocument / fs reads from the
 * CURRENT workspace root only. Every path is containment-checked
 * (resolved candidate must stay strictly under the root); reads are
 * regular files only (symlinks rejected via lstat); listings and
 * reads are bounded. Nothing here writes — writes stay in the
 * human-review pipeline.
 */

/** Maximum root entries scanned per findFiles call. */
export const WORKSPACE_ACCESS_MAX_ENTRIES = 1024

/** Maximum bytes served per read. */
export const WORKSPACE_ACCESS_MAX_BYTES = 1024 * 1024

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp',
  c: 'cpp',
  h: 'cpp',
  php: 'php',
  sql: 'sql',
  sh: 'shell',
  ps1: 'powershell',
  xml: 'xml',
  vue: 'vue'
}

function languageIdForPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  const basename = normalized.split('/').pop() ?? ''
  const dot = basename.lastIndexOf('.')
  if (dot <= 0 || dot === basename.length - 1) {
    return 'plaintext'
  }
  return EXTENSION_LANGUAGES[basename.slice(dot + 1)] ?? 'plaintext'
}

function containedPath(root: string, relativePath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath === '' || relativePath.length > 1024) {
    return null
  }
  if (relativePath.includes('\0') || relativePath.includes('..')) {
    return null
  }
  if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
    return null
  }
  const resolved = resolve(root, relativePath)
  const rootLower = resolve(root).toLowerCase()
  const candidateLower = resolved.toLowerCase()
  if (candidateLower !== rootLower && !candidateLower.startsWith(rootLower + sep)) {
    return null
  }
  if (candidateLower === rootLower) {
    return null
  }
  return resolved
}

export interface WorkspaceAccessOptions {
  readonly workspaceRootProvider: () => string | null
}

/** Builds the bounded workspace file seam (pure wiring, testable). */
export function createWorkspaceFileAccess(options: WorkspaceAccessOptions): WorkspaceFileAccess {
  return {
    listFiles(pattern: string, maxResults: number): string[] {
      const root = options.workspaceRootProvider()
      if (root === null) {
        return []
      }
      let entries: string[]
      try {
        entries = readdirSync(root)
      } catch {
        return []
      }
      const out: string[] = []
      const limit = Math.max(1, Math.min(100, Math.floor(maxResults)))
      for (const entry of entries.slice(0, WORKSPACE_ACCESS_MAX_ENTRIES)) {
        if (out.length >= limit) {
          break
        }
        if (entry === '' || entry.startsWith('.')) {
          continue
        }
        if (matchWatcherPattern(pattern, entry)) {
          out.push(`file:${join(root, entry).replace(/\\/g, '/')}`)
        }
      }
      return out
    },
    readFile(relativePath: string, maxBytes: number): { text: string; languageId: string } | null {
      const root = options.workspaceRootProvider()
      if (root === null) {
        return null
      }
      const resolved = containedPath(root, relativePath)
      if (resolved === null) {
        return null
      }
      try {
        const stats = lstatSync(resolved)
        if (stats.isSymbolicLink() || !stats.isFile()) {
          return null
        }
        if (stats.size > Math.min(maxBytes, WORKSPACE_ACCESS_MAX_BYTES)) {
          return null
        }
        const text = readFileSync(resolved, 'utf8')
        if (Buffer.byteLength(text, 'utf8') > Math.min(maxBytes, WORKSPACE_ACCESS_MAX_BYTES)) {
          return null
        }
        return { text, languageId: languageIdForPath(relativePath) }
      } catch {
        return null
      }
    },
    statFile(relativePath: string): { type: number } | null {
      const root = options.workspaceRootProvider()
      if (root === null) {
        return null
      }
      const resolved = containedPath(root, relativePath)
      if (resolved === null) {
        return null
      }
      try {
        const stats = lstatSync(resolved)
        if (stats.isSymbolicLink()) {
          return null
        }
        if (stats.isDirectory()) {
          return { type: 2 }
        }
        if (stats.isFile()) {
          return { type: 1 }
        }
        return null
      } catch {
        return null
      }
    }
  }
}
