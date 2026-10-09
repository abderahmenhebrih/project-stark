import type { ReactElement } from 'react'

export type ActivityKind = 'explorer' | 'search' | 'changes' | 'git'

interface ActivityRailProps {
  readonly activity: ActivityKind
  readonly onSelect: (activity: ActivityKind) => void
}

const ACTIVITIES: readonly { readonly kind: ActivityKind; readonly label: string; readonly icon: string }[] = [
  { kind: 'explorer', label: 'Explorer', icon: '▤' },
  { kind: 'search', label: 'Search', icon: '⌕' },
  { kind: 'changes', label: 'Changes', icon: '⇄' },
  { kind: 'git', label: 'Git', icon: '⎇' }
]

/**
 * Compact icon-first activity rail. The selected activity fills the
 * contextual sidebar; labels are always full (tooltip + caption),
 * the selected state is a lime indicator, never a neon block.
 */
export function ActivityRail({ activity, onSelect }: ActivityRailProps): ReactElement {
  return (
    <nav className="activity-rail" aria-label="Activity">
      <div className="workbench__tabs" role="tablist" aria-label="Explorer views" aria-orientation="vertical">
        {ACTIVITIES.map((entry) => (
          <button
            key={entry.kind}
            className={activity === entry.kind ? 'explorer__tab explorer__tab--active' : 'explorer__tab'}
            type="button"
            role="tab"
            aria-selected={activity === entry.kind}
            title={entry.label}
            aria-label={entry.label}
            onClick={() => onSelect(entry.kind)}
          >
            <span className="explorer__tab-icon" aria-hidden="true">
              {entry.icon}
            </span>
            <span className="explorer__tab-label">{entry.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
