import { useState, type ReactElement } from 'react'
import { useApp } from '../../app/app-context'
import { StarkIcon } from '../../components/icons/StarkIcon'
import { chooseWorkspaceWithGuards, openWorkspaceWithGuards } from './workspace-switch'

/**
 * Drawer [...] overflow: the reachable-but-quiet home of workspace
 * switching inside the tools drawer. Offers Open another folder plus
 * the recent-workspace list through the same guarded flows as the
 * welcome surface and the AppChrome project button — no duplicate
 * workspace state, no new persistence. Closes on Escape; the drawer
 * itself still closes on Escape when the menu is shut.
 */
export function DrawerWorkspaceMenu(): ReactElement {
  const { workspace } = useApp()
  const [menuOpen, setMenuOpen] = useState(false)
  const others = workspace.recent.filter((entry) => entry.id !== workspace.current?.id)
  const busy = workspace.choosing || workspace.openingId !== null

  function handleChooseWorkspace(): void {
    setMenuOpen(false)
    void chooseWorkspaceWithGuards(workspace)
  }

  function handleOpenWorkspace(workspaceId: number): void {
    setMenuOpen(false)
    void openWorkspaceWithGuards(workspace, workspaceId)
  }

  return (
    <div className="drawer-menu">
      <button
        className="drawer-menu__toggle"
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-expanded={menuOpen}
        aria-label="Workspace actions"
        title="Workspace actions"
      >
        <StarkIcon name="more" size={16} />
      </button>
      {menuOpen && (
        <div
          className="drawer-menu__list"
          role="menu"
          aria-label="Workspace actions"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setMenuOpen(false)
            }
          }}
        >
          <button
            className="drawer-menu__item"
            type="button"
            role="menuitem"
            onClick={handleChooseWorkspace}
            disabled={workspace.choosing}
          >
            {workspace.choosing ? 'Opening…' : 'Open another folder'}
          </button>
          {others.length > 0 && (
            <>
              <span className="drawer-menu__divider" aria-hidden="true" />
              <p className="drawer-menu__label">Recent workspaces</p>
              {others.map((entry) => (
                <button
                  key={entry.id}
                  className="drawer-menu__item drawer-menu__item--recent"
                  type="button"
                  role="menuitem"
                  title={entry.rootPath}
                  onClick={() => handleOpenWorkspace(entry.id)}
                  disabled={busy}
                >
                  {entry.displayName}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
