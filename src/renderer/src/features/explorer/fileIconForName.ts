/**
 * Pure presentation mapping from a file name to a file-icon kind.
 * No filesystem reads, no MIME sniffing, no backend — the renderer
 * only differentiates rows it already displays. Basename rules run
 * before extension rules so manifests resolve to their specific
 * icons; extension matching is case-insensitive. Anything
 * unrecognized falls back to the generic document icon.
 *
 * The kind literals intentionally avoid importing the TSX icon module
 * or SVG assets, so this helper stays compilable in every tsconfig
 * (including the non-JSX test project). The kind-to-asset-URL map
 * lives in `fileIconAssets.ts`, which is only bundled with the
 * renderer. Every kind must have exactly one local asset there.
 */
export type FileIconKind =
  | 'markdown'
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'package'
  | 'git'
  | 'config'
  | 'document'

export function getFileIconKind(fileName: string): FileIconKind {
  const base = fileName.split('/').pop() ?? fileName
  const lower = base.toLowerCase()
  if (lower === 'package.json' || lower === 'package-lock.json') {
    return 'package'
  }
  if (lower === 'tsconfig.json' || (lower.startsWith('tsconfig.') && lower.endsWith('.json'))) {
    return 'typescript'
  }
  if (lower === '.gitignore' || lower === '.gitattributes') {
    return 'git'
  }
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) {
    return 'config'
  }
  if (base.startsWith('.') && base.indexOf('.', 1) === -1) {
    return 'config'
  }
  const dot = base.lastIndexOf('.')
  if (dot === -1) {
    return 'document'
  }
  const extension = base.slice(dot + 1).toLowerCase()
  switch (extension) {
    case 'md':
    case 'markdown':
    case 'mdx':
    case 'mdown':
      return 'markdown'
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript'
    case 'ts':
    case 'mts':
    case 'cts':
    case 'tsx':
      return 'typescript'
    case 'json':
    case 'jsonc':
      return 'json'
    case 'tsbuildinfo':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'cfg':
    case 'conf':
      return 'config'
    default:
      return 'document'
  }
}
