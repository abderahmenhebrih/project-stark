import type { ReactElement } from 'react'

export type StarkIconName =
  | 'menu'
  | 'explorer'
  | 'search'
  | 'changes'
  | 'git'
  | 'terminal'
  | 'settings'
  | 'context'
  | 'review'
  | 'plus'
  | 'more'
  | 'close'
  | 'chevron-down'
  | 'chevron-right'
  | 'send'
  | 'refresh'

interface StarkIconProps {
  readonly name: StarkIconName
  readonly size?: number
  readonly label?: string
}

const PATHS: Record<StarkIconName, ReactElement> = {
  menu: (
    <>
      <line x1="3" y1="5" x2="13" y2="5" />
      <line x1="3" y1="8" x2="13" y2="8" />
      <line x1="3" y1="11" x2="13" y2="11" />
    </>
  ),
  explorer: (
    <>
      <rect x="3" y="3" width="10" height="10" rx="1.5" />
      <line x1="6.5" y1="3" x2="6.5" y2="13" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="3.5" />
      <line x1="9.8" y1="9.8" x2="13" y2="13" />
    </>
  ),
  changes: (
    <>
      <path d="M4 6.5h7l-2-2" />
      <path d="M12 9.5H5l2 2" />
    </>
  ),
  git: (
    <>
      <circle cx="5" cy="4.5" r="1.5" />
      <circle cx="5" cy="11.5" r="1.5" />
      <circle cx="11" cy="8" r="1.5" />
      <path d="M5 6v4" />
      <path d="M6.2 4.8C8 5.5 8 7 9.6 7.6" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      <path d="M5 6.5l2 1.5-2 1.5" />
      <line x1="8" y1="10" x2="11" y2="10" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2.8v1.6M8 11.6v1.6M2.8 8h1.6M11.6 8h1.6M4.3 4.3l1.1 1.1M10.6 10.6l1.1 1.1M11.7 4.3l-1.1 1.1M5.4 10.6l-1.1 1.1" />
    </>
  ),
  context: (
    <>
      <path d="M8 2.5l1.8 3.6 3.7.6-2.7 2.6.7 3.7-3.5-1.8-3.5 1.8.7-3.7-2.7-2.6 3.7-.6z" />
    </>
  ),
  review: (
    <>
      <rect x="3" y="3" width="10" height="10" rx="1.5" />
      <path d="M5.8 8.2l1.8 1.8 3-3.4" />
    </>
  ),
  plus: (
    <>
      <line x1="8" y1="3.5" x2="8" y2="12.5" />
      <line x1="3.5" y1="8" x2="12.5" y2="8" />
    </>
  ),
  more: (
    <>
      <circle cx="4" cy="8" r="0.4" />
      <circle cx="8" cy="8" r="0.4" />
      <circle cx="12" cy="8" r="0.4" />
    </>
  ),
  close: (
    <>
      <line x1="4.5" y1="4.5" x2="11.5" y2="11.5" />
      <line x1="11.5" y1="4.5" x2="4.5" y2="11.5" />
    </>
  ),
  'chevron-down': (
    <>
      <path d="M4.5 6.5l3.5 3.5 3.5-3.5" />
    </>
  ),
  'chevron-right': (
    <>
      <path d="M6.5 4.5l3.5 3.5-3.5 3.5" />
    </>
  ),
  send: (
    <>
      <path d="M13 3L7 9" />
      <path d="M13 3l-4.5 9-1.5-3.5L3.5 7z" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 2.5v3h-3" />
    </>
  )
}

/**
 * Local STARK SVG icon set (renderer-only, no dependency, no CDN).
 * 16px stroke icons in currentColor; decorative by default, pass
 * `label` only when the icon alone conveys meaning (the callers
 * already set aria-label/title on icon-only buttons).
 */
export function StarkIcon({ name, size = 16, label }: StarkIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label === undefined}
      aria-label={label}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
