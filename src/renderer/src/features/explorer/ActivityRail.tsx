import type { ReactElement } from 'react'
import { StarkIcon, type StarkIconName } from '../../components/icons/StarkIcon'

export type ActivityKind = 'explorer' | 'search' | 'changes' | 'git'

interface ActivityRailProps {
  readonly activity: ActivityKind
  readonly onSelect: (activity: ActivityKind) => void
}

const ACTIVITIES: readonly { readonly kind: ActivityKind; readonly label: string; readonly icon: StarkIconName }[] = [
  { kind: 'explorer', label: 'Explorer', icon: 'explorer' },
  { kind: 'search', label: 'Search', icon: 'search' },
  { kind: 'changes', label: 'Changes', icon: 'changes' },
  { kind: 'git', label: 'Git', icon: 'git' }
]

/**
 * Activity selector for the workspace tools drawer. Labels stay
 * visible beside large icons; the selected activity fills the drawer
 * body with a lime indicator, never a neon block.
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
              <StarkIcon name={entry.icon} size={20} />
            </span>
            <span className="explorer__tab-label">{entry.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
