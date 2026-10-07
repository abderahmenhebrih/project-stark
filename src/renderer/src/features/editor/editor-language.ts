/**
 * Deterministic workspace-relative-path → Monaco language mapper.
 *
 * Pure string matching only: never reads project contents, never
 * touches the filesystem, never installs language servers. Unknown
 * extensions fall back to plaintext. Matching is case-insensitive so
 * `README.MD` and `readme.md` behave identically.
 */

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  py: 'python',
  java: 'java',
  // Monaco ships one C-family grammar id: C sources share the cpp id.
  c: 'cpp',
  h: 'cpp',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  php: 'php',
  sql: 'sql',
  sh: 'shell',
  ps1: 'powershell',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml'
}

const BASENAME_LANGUAGES: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile'
}

/** Monaco language id for a workspace-relative path, or 'plaintext'. */
export function detectEditorLanguage(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  const segments = normalized.split('/')
  const basename = segments[segments.length - 1] ?? ''
  const special = BASENAME_LANGUAGES[basename]
  if (special !== undefined) {
    return special
  }
  const dot = basename.lastIndexOf('.')
  if (dot <= 0 || dot === basename.length - 1) {
    return 'plaintext'
  }
  const extension = basename.slice(dot + 1)
  return EXTENSION_LANGUAGES[extension] ?? 'plaintext'
}
