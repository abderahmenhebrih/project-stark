import type { ReactElement } from 'react'
import { StarkIcon, type StarkIconName } from '../../components/icons/StarkIcon'

export type ActivityKind = 'explorer' | 'search' | 'changes' | 'git' | 'extensions'

interface ActivityRailProps {
  readonly activity: ActivityKind
  readonly onSelect: (activity: ActivityKind) => void
  /** Terminal visibility (owned by the existing terminal manager in the workspace pane). */
  readonly terminalOpen: boolean
  /** Invokes the EXISTING terminal open/toggle behavior — no second terminal implementation. */
  readonly onToggleTerminal: () => void
}

const ACTIVITIES: readonly { readonly kind: ActivityKind; readonly label: string; readonly icon: StarkIconName }[] = [
  { kind: 'explorer', label: 'Explorer', icon: 'explorer' },
  { kind: 'search', label: 'Search', icon: 'search' },
  { kind: 'changes', label: 'Changes', icon: 'changes' },
  { kind: 'git', label: 'Git', icon: 'git' },
  { kind: 'extensions', label: 'Extensions', icon: 'extensions' }
]

/**
 * Activity selector for the workspace tools drawer. Labels stay
 * visible beside large icons; the selected activity fills the drawer
 * body with a lime indicator, never a neon block. The Terminal item
 * sits directly below Extensions and invokes the existing
 * terminal open/toggle behavior (same manager, same terminal, same
 * workspace pane) — the drawer never becomes a fake terminal
 * sidebar.
 */
export function ActivityRail({ activity, onSelect, terminalOpen, onToggleTerminal }: ActivityRailProps): ReactElement {
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
        <button
          className={terminalOpen ? 'explorer__tab explorer__tab--active' : 'explorer__tab'}
          type="button"
          aria-pressed={terminalOpen}
          title="Terminal"
          aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'}
          onClick={onToggleTerminal}
        >
          <span className="explorer__tab-icon" aria-hidden="true">
            <StarkIcon name="terminal" size={20} />
          </span>
          <span className="explorer__tab-label">Terminal</span>
        </button>
      </div>
    </nav>
  )
}
