import type { ReactElement, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { DrawerWorkspaceMenu } from '../features/workspace/DrawerWorkspaceMenu'
import { ActivityRail, type ActivityKind } from '../features/explorer/ActivityRail'
import { StarkIcon } from '../components/icons/StarkIcon'

interface WorkspaceToolsDrawerProps {
  readonly open: boolean
  readonly activity: ActivityKind
  readonly onActivityChange: (activity: ActivityKind) => void
  readonly onClose: () => void
  readonly children: ReactNode
  /** Terminal visibility for the rail item below Extensions. */
  readonly terminalOpen: boolean
  /** Existing terminal open/toggle behavior, forwarded to the rail. */
  readonly onToggleTerminal: () => void
}

const ACTIVITY_TITLES: Record<ActivityKind, string> = {
  explorer: 'Explorer',
  search: 'Search',
  changes: 'Changes',
  git: 'Git',
  extensions: 'Extensions'
}

/**
 * Workspace tools drawer: an overlay floating above the workspace
 * work area (never a permanent layout column). A compact VS Code-style
 * title row names the active activity with a workspace-actions
 * overflow and close; the activity selector and the contextual tool
 * content owned by the Explorer (tree / search / changes / git /
 * extensions) sit side by side below. Closes via the close button or
 * Escape; Escape handling lives on the drawer so editor and composer
 * shortcuts are unaffected.
 */
export function WorkspaceToolsDrawer({
  open,
  activity,
  onActivityChange,
  onClose,
  children,
  terminalOpen,
  onToggleTerminal
}: WorkspaceToolsDrawerProps): ReactElement | null {
  const drawerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (open) {
      drawerRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
  }, [open ])

  if (!open) {
    return null
  }

  function handleKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <aside
      ref={drawerRef}
      className="workspace-tools-drawer"
      aria-label="Workspace tools"
      onKeyDown={handleKeyDown}
    >
      <div className="workspace-tools-drawer__head">
        <p className="workspace-tools-drawer__title">{ACTIVITY_TITLES[activity]}</p>
        <DrawerWorkspaceMenu />
        <button
          className="workspace-tools-drawer__close"
          type="button"
          onClick={onClose}
          aria-label="Close workspace tools"
          title="Close workspace tools"
        >
          <StarkIcon name="close" size={16} />
        </button>
      </div>
      <div className="workspace-tools-drawer__body">
        <ActivityRail activity={activity} onSelect={onActivityChange} terminalOpen={terminalOpen} onToggleTerminal={onToggleTerminal} />
        <div className="workspace-tools-drawer__content">{children}</div>
      </div>
    </aside>
  )
}
