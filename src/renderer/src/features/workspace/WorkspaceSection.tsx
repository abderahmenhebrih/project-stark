import type { ReactElement } from 'react'
import { useApp } from '../../app/app-context'
import { chooseWorkspaceWithGuards, openWorkspaceWithGuards } from './workspace-switch'
import './WorkspaceSection.css'

/**
 * First-run workspace state for the welcome shell: open-folder
 * action and the recent list. No file tree, no scanning — display
 * names and stored paths only. Switching shares the Explorer
 * editor's discard guard and the terminal switch guard (see
 * workspace-switch.ts): a declined confirmation keeps the current
 * workspace in place. This section renders only when no workspace is
 * active; the drawer uses its own compact title + overflow menu, and
 * AppChrome carries the primary project-switch affordance.
 */
export function WorkspaceSection(): ReactElement {
  const { workspace } = useApp()

  if (workspace.loading) {
    return (
      <section className="workspace" aria-label="Workspace">
        <p className="workspace__status" role="status">
          Loading workspaces…
        </p>
      </section>
    )
  }

  const others = workspace.recent.filter((entry) => entry.id !== workspace.current?.id)
  const busy = workspace.choosing || workspace.openingId !== null

  function handleChooseWorkspace(): void {
    void chooseWorkspaceWithGuards(workspace)
  }

  function handleOpenWorkspace(workspaceId: number): void {
    void openWorkspaceWithGuards(workspace, workspaceId)
  }

  return (
    <section className="workspace" aria-label="Workspace">
      {workspace.error !== null && (
        <p className="workspace__error" role="alert">
          {workspace.error}
        </p>
      )}
      <button
        className="workspace__primary"
        type="button"
        onClick={handleChooseWorkspace}
        disabled={workspace.choosing}
      >
        {workspace.choosing ? 'Opening…' : 'Open project folder'}
      </button>
      {others.length > 0 && (
        <div className="workspace__recent">
          <p className="workspace__recent-title">Recent</p>
          <ul className="workspace__recent-list">
            {others.map((entry) => (
              <li key={entry.id}>
                <button
                  className="workspace__recent-item"
                  type="button"
                  onClick={() => handleOpenWorkspace(entry.id)}
                  disabled={busy}
                >
                  <span className="workspace__recent-name">{entry.displayName}</span>
                  <span className="workspace__recent-path">{entry.rootPath}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
