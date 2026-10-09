import type { ReactElement } from 'react'
import { StarkMark } from '../components/StarkMark'
import { StarkIcon } from '../components/icons/StarkIcon'
import './AppChrome.css'

interface AppChromeProps {
  readonly workspaceName: string
  readonly workspacePath: string
  readonly sidebarOpen: boolean
  readonly onToggleSidebar: () => void
  readonly terminalOpen: boolean
  readonly onToggleTerminal: () => void
  readonly onOpenSearch: () => void
  readonly onOpenSettings: () => void
  readonly onOpenAccount: () => void
  readonly accountInitial: string
}

/**
 * Single compact global bar (40px): workspace-tools trigger, STARK
 * identity, workspace name, centered workspace-search shortcut, then
 * icon-first terminal / settings / account controls. Renderer-local
 * view state only — no backend, no persistence.
 */
export function AppChrome({
  workspaceName,
  workspacePath,
  sidebarOpen,
  onToggleSidebar,
  terminalOpen,
  onToggleTerminal,
  onOpenSearch,
  onOpenSettings,
  onOpenAccount,
  accountInitial
}: AppChromeProps): ReactElement {
  return (
    <header className="app-chrome">
      <button
        className="app-chrome__control"
        type="button"
        onClick={onToggleSidebar}
        aria-pressed={sidebarOpen}
        aria-label={sidebarOpen ? 'Hide workspace tools' : 'Show workspace tools'}
        title={sidebarOpen ? 'Hide workspace tools' : 'Show workspace tools'}
      >
        <StarkIcon name="menu" size={17} />
      </button>
      <span className="app-chrome__brand">
        <StarkMark size="bar" />
        <span className="app-chrome__wordmark">STARK</span>
      </span>
      <span className="app-chrome__divider" aria-hidden="true" />
      <span className="app-chrome__identity" title={workspacePath}>
        <span className="app-chrome__workspace">{workspaceName}</span>
      </span>
      <button
        className="app-chrome__search"
        type="button"
        onClick={onOpenSearch}
        aria-label="Search workspace"
        title="Search workspace"
      >
        <StarkIcon name="search" size={15} />
        <span className="app-chrome__search-text">Search workspace…</span>
      </button>
      <span className="app-chrome__spacer" aria-hidden="true" />
      <div className="app-chrome__controls" role="toolbar" aria-label="View controls">
        <button
          className="app-chrome__control"
          type="button"
          onClick={onToggleTerminal}
          aria-pressed={terminalOpen}
          aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'}
          title={terminalOpen ? 'Hide terminal' : 'Show terminal'}
        >
          <StarkIcon name="terminal" size={17} />
        </button>
        <button
          className="app-chrome__control"
          type="button"
          onClick={onOpenSettings}
          aria-label="Open settings"
          title="Settings"
        >
          <StarkIcon name="settings" size={17} />
        </button>
        <button
          className="app-chrome__account"
          type="button"
          onClick={onOpenAccount}
          aria-label="Open account settings"
          title="Account"
        >
          {accountInitial}
        </button>
      </div>
    </header>
  )
}
