import type { ReactElement } from 'react'
import { StarkMark } from '../components/StarkMark'
import './AppChrome.css'

interface AppChromeProps {
  readonly workspaceName: string
  readonly workspacePath: string
  readonly sidebarOpen: boolean
  readonly onToggleSidebar: () => void
  readonly terminalOpen: boolean
  readonly onToggleTerminal: () => void
}

/**
 * Single compact global bar: STARK identity, current workspace
 * identity, and high-value view toggles. The workspace path stays
 * muted metadata (tooltip + title). Renderer-local view state only —
 * no backend, no persistence.
 */
export function AppChrome({
  workspaceName,
  workspacePath,
  sidebarOpen,
  onToggleSidebar,
  terminalOpen,
  onToggleTerminal
}: AppChromeProps): ReactElement {
  return (
    <header className="app-chrome">
      <span className="app-chrome__brand">
        <StarkMark size="bar" />
        <span className="app-chrome__wordmark">STARK</span>
      </span>
      <span className="app-chrome__divider" aria-hidden="true" />
      <span className="app-chrome__identity" title={workspacePath}>
        <span className="app-chrome__workspace">{workspaceName}</span>
      </span>
      <span className="app-chrome__spacer" aria-hidden="true" />
      <div className="app-chrome__controls" role="toolbar" aria-label="View controls">
        <button
          className="app-chrome__control"
          type="button"
          onClick={onToggleSidebar}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          ☰
        </button>
        <button
          className="app-chrome__control"
          type="button"
          onClick={onToggleTerminal}
          aria-pressed={terminalOpen}
          title={terminalOpen ? 'Hide terminal' : 'Show terminal'}
          aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'}
        >
          ⌁
        </button>
      </div>
    </header>
  )
}
