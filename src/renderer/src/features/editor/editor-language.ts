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

/**
 * Monaco-bundled language ids: the grammars registered by
 * `monaco-editor/basic-languages/monaco.contribution` (which
 * `loadMonaco` imports), plus `json` which registers through its own
 * language-feature contribution (`monaco-editor/language/json/
 * monaco.contribution` — there is no basic-languages JSON
 * definition). Extension-contributed overrides win only for ids in
 * this set: an unknown id would create a model Monaco cannot
 * tokenize, silently rendering the file unhighlighted. Kept in sync
 * with the installed Monaco package by editor-language.test.ts
 * (strict both-directions check), so this is a guard set — not a
 * second mapping system.
 */
export const KNOWN_MONACO_LANGUAGE_IDS: ReadonlySet<string> = new Set([
  'abap', 'apex', 'azcli', 'bat', 'bicep', 'cameligo', 'clojure',
  'coffee', 'cpp', 'csharp', 'csp', 'css', 'cypher', 'dart',
  'dockerfile', 'ecl', 'elixir', 'flow9', 'fsharp', 'freemarker2',
  'go', 'graphql', 'handlebars', 'hcl', 'html', 'ini', 'java',
  'javascript', 'julia', 'kotlin', 'less', 'lexon', 'lua', 'liquid',
  'm3', 'markdown', 'mdx', 'mips', 'msdax', 'mysql', 'objective-c',
  'pascal', 'pascaligo', 'perl', 'pgsql', 'php', 'pla', 'postiats',
  'powerquery', 'powershell', 'protobuf', 'pug', 'python', 'qsharp',
  'r', 'razor', 'redis', 'redshift', 'restructuredtext', 'ruby',
  'rust', 'sb', 'scala', 'scheme', 'scss', 'shell', 'solidity',
  'sophia', 'sparql', 'sql', 'st', 'swift', 'systemverilog', 'tcl',
  'twig', 'typescript', 'typespec', 'vb', 'wgsl', 'xml', 'yaml',
  // Registered by the JSON language-feature contribution (see above).
  'json'
])

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
    // Overrides win only for ids Monaco actually bundles: anything
    // else would build an untokenizable model (all-default
    // foreground) for a known file type. Unknown ids fall through to
    // the built-in mapping below.
    if (typeof override === 'string' && override !== '') {
      const candidate = override.toLowerCase()
      if (KNOWN_MONACO_LANGUAGE_IDS.has(candidate)) {
        return candidate
      }
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
