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
  return detectEditorLanguageWithOverrides(relativePath, null)
}

/**
 * Override-aware detection: contributed languages map extra file
 * extensions to Monaco ids. Overrides win over built-ins only for
 * exact extension matches; unknown extensions still fall back to
 * plaintext. Pure and bounded.
 */
export function detectEditorLanguageWithOverrides(
  relativePath: string,
  overrides: Readonly<Record<string, string>> | null
): string {
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
  if (overrides !== null) {
    const override = overrides[extension]
    if (typeof override === 'string' && override !== '' && /^[A-Za-z0-9_-]+$/.test(override)) {
      return override
    }
  }
  return EXTENSION_LANGUAGES[extension] ?? 'plaintext'
}

/**
 * Builds the detection override map from contributed languages
 * (extension → language id, bounded, first registration wins).
 */
export function buildLanguageOverrides(
  languages: readonly { id: string; extensions: readonly string[] }[]
): Record<string, string> {
  const overrides: Record<string, string> = {}
  for (const language of languages.slice(0, 128)) {
    if (typeof language.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(language.id)) {
      continue
    }
    for (const extension of language.extensions.slice(0, 32)) {
      if (typeof extension !== 'string') {
        continue
      }
      const key = extension.toLowerCase().replace(/^\./, '')
      if (key === '' || key.length > 32 || overrides[key] !== undefined) {
        continue
      }
      overrides[key] = language.id
    }
  }
  return overrides
}
