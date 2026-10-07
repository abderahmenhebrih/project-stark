import type { ReactElement } from 'react'
import { useApp } from '../../app/app-context'
import { confirmDiscardUnsavedDraft } from '../explorer/editor-guard'
import './WorkspaceSection.css'

/**
 * Workspace state for the main shell: open-folder action, current
 * workspace display, and the recent list. No file tree, no scanning —
 * display names and stored paths only. Switching workspaces shares the
 * Explorer editor's discard guard: a declined confirmation keeps the
 * current workspace (and its dirty draft) in place.
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
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    void workspace.chooseWorkspace()
  }

  function handleOpenWorkspace(workspaceId: number): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    void workspace.openWorkspace(workspaceId)
  }

  return (
    <section className="workspace" aria-label="Workspace">
      {workspace.error !== null && (
        <p className="workspace__error" role="alert">
          {workspace.error}
        </p>
      )}
      {workspace.current === null ? (
        <button
          className="workspace__primary"
          type="button"
            onClick={handleChooseWorkspace}
            disabled={workspace.choosing}
        >
          {workspace.choosing ? 'Opening…' : 'Open project folder'}
        </button>
      ) : (
        <div className="workspace__current">
          <p className="workspace__name">{workspace.current.displayName}</p>
          <p className="workspace__path">{workspace.current.rootPath}</p>
          <button
            className="workspace__secondary"
            type="button"
          onClick={handleChooseWorkspace}
            disabled={workspace.choosing}
          >
            {workspace.choosing ? 'Opening…' : 'Open another folder'}
          </button>
        </div>
      )}
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
