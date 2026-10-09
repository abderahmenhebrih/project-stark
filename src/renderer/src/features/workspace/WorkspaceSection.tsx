import type { ReactElement } from 'react'
import { useState } from 'react'
import { useApp } from '../../app/app-context'
import { StarkIcon } from '../../components/icons/StarkIcon'
import { FOLDER_ICON_URL } from '../explorer/fileIconAssets'
import { confirmDiscardUnsavedDraft } from '../explorer/editor-guard'
import {
  closeActiveTerminalForSwitch,
  confirmCloseTerminalAndSwitch,
  hasActiveTerminal
} from '../terminal/terminal-guard'
import './WorkspaceSection.css'

/**
 * Workspace state for the main shell: open-folder action, current
 * workspace display, and the recent list. No file tree, no scanning —
 * display names and stored paths only. Switching workspaces shares the
 * Explorer editor's discard guard and the terminal switch guard: a
 * declined confirmation keeps the current workspace (and its dirty
 * draft / running terminal) in place. An accepted terminal prompt
 * kills the session with bounded cleanup before switching, and no
 * terminal is ever re-created automatically in the new workspace.
 *
 * When `onClosePanel` is provided (drawer usage), the compact header
 * renders a project identity row with an overflow menu plus a
 * full-width folder action; otherwise it renders the standalone form.
 */
export function WorkspaceSection({ onClosePanel }: { readonly onClosePanel?: () => void }): ReactElement {
  const { workspace } = useApp()
  const [menuOpen, setMenuOpen] = useState(false)

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
    if (hasActiveTerminal() && !confirmCloseTerminalAndSwitch()) {
      return
    }
    void (async () => {
      await closeActiveTerminalForSwitch()
      await workspace.chooseWorkspace()
    })()
  }

  function handleOpenWorkspace(workspaceId: number): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    if (hasActiveTerminal() && !confirmCloseTerminalAndSwitch()) {
      return
    }
    void (async () => {
      await closeActiveTerminalForSwitch()
      await workspace.openWorkspace(workspaceId)
    })()
  }

  return (
    <section className={workspace.current === null ? 'workspace' : 'workspace workspace--compact'} aria-label="Workspace">
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
        <div className="workspace__current workspace__current--compact">
          <div className="workspace__identity-row">
            <span className="workspace__project-icon" aria-hidden="true">
              <img src={FOLDER_ICON_URL} alt="" draggable={false} />
            </span>
            <div className="workspace__identity">
              <p className="workspace__name" title={workspace.current.displayName}>{workspace.current.displayName}</p>
              <p className="workspace__path" title={workspace.current.rootPath}>{workspace.current.rootPath}</p>
            </div>
            {onClosePanel !== undefined && (
              <div className="workspace__menu">
                <button
                  className="workspace__menu-toggle"
                  type="button"
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-expanded={menuOpen}
                  aria-label="Workspace options"
                  title="Workspace options"
                >
                  <StarkIcon name="more" size={16} />
                </button>
                {menuOpen && (
                  <div
                    className="workspace__menu-list"
                    role="menu"
                    aria-label="Workspace options"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation()
                        setMenuOpen(false)
                      }
                    }}
                  >
                    <button
                      className="workspace__menu-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        handleChooseWorkspace()
                      }}
                      disabled={workspace.choosing}
                    >
                      Open another folder
                    </button>
                    <button
                      className="workspace__menu-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        onClosePanel()
                      }}
                    >
                      Close panel
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          <button
            className="workspace__folder-btn"
            type="button"
          onClick={handleChooseWorkspace}
            disabled={workspace.choosing}
          >
            <span className="workspace__folder-btn-icon" aria-hidden="true">
              <img src={FOLDER_ICON_URL} alt="" draggable={false} />
            </span>
            <span className="workspace__folder-btn-label">{workspace.choosing ? 'Opening…' : 'Open another folder'}</span>
          </button>
        </div>
      )}
      {others.length > 0 &&
        (workspace.current === null ? (
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
        ) : (
        <details className="workspace__recent workspace__recent--collapsible">
          <summary className="workspace__recent-toggle">Recent ({others.length})</summary>
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
        </details>
        ))}
    </section>
  )
}
