import type { ReactElement } from 'react'
import {
  ArrowUp,
  Blocks,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Ellipsis,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  Info,
  Menu,
  Mic,
  MonitorPlay,
  Paperclip,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Star,
  Terminal,
  TriangleAlert,
  X,
  type LucideIcon
} from 'lucide-react'

/**
 * Professional renderer UI icon system (Lucide).
 *
 * Single icon pack for ALL renderer-owned generic UI glyphs. Named
 * imports only (tree-shaken — never the whole catalog, never remote
 * fetches). Consistent 1.6px-equivalent stroke via `strokeWidth`,
 * compact 16 / normal 18 / toolbar 20-22 sizing at call sites.
 *
 * EXCLUSIONS (never replaced): STARK emblem/wordmark/full lockups,
 * Magma/Frost/Void logo assets, official AI/model/provider icons,
 * extension/vendor artwork, file-type icon assets, Monaco + xterm
 * internals.
 */

export type UiIconName =
  | 'menu'
  | 'explorer'
  | 'explorer-open'
  | 'search'
  | 'plugins'
  | 'git'
  | 'extensions'
  | 'terminal'
  | 'settings'
  | 'usage'
  | 'live'
  | 'context'
  | 'review'
  | 'plus'
  | 'more'
  | 'close'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'arrow-up'
  | 'refresh'
  | 'mic'
  | 'paperclip'
  | 'file'
  | 'check'
  | 'info'
  | 'warning'
  | 'error'

const ICONS: Record<UiIconName, LucideIcon> = {
  menu: Menu,
  explorer: Folder,
  'explorer-open': FolderOpen,
  search: Search,
  plugins: Puzzle,
  git: GitBranch,
  extensions: Blocks,
  terminal: Terminal,
  settings: Settings,
  usage: ChartNoAxesCombined,
  live: MonitorPlay,
  context: Star,
  review: FileText,
  plus: Plus,
  more: Ellipsis,
  close: X,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'chevron-left': ChevronLeft,
  'arrow-up': ArrowUp,
  refresh: RefreshCw,
  mic: Mic,
  paperclip: Paperclip,
  file: FileText,
  check: Check,
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert
}

interface UiIconProps {
  readonly name: UiIconName
  readonly size?: number
  readonly label?: string
  readonly strokeWidth?: number
}

/**
 * Lucide-backed UI icon. Decorative by default (aria-hidden); pass
 * `label` only when the icon alone conveys meaning (callers already
 * set aria-label/title on icon-only buttons).
 */
export function UiIcon({ name, size = 16, label, strokeWidth = 1.8 }: UiIconProps): ReactElement {
  const Glyph = ICONS[name]
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden={label === undefined}
      aria-label={label}
      focusable="false"
    />
  )
}
