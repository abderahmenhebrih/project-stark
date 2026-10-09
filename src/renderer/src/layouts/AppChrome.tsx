import { useEffect, useRef, useState, type ReactElement } from 'react'
import { StarkMark } from '../components/StarkMark'
import { STARK_WORDMARK_URL } from '../components/brandAssets'
import { StarkIcon } from '../components/icons/StarkIcon'
import type { SessionChromeSession } from '../features/sessions/SessionPanel'
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
  /** Active session tab: title mirrored from the SessionPanel reducer. */
  readonly sessionTitle: string
  readonly sessions: readonly SessionChromeSession[]
  readonly selectedSessionId: number | null
  readonly sessionsLoading: boolean
  readonly looplinkActing: boolean
  readonly looplinkDisabled: boolean
  readonly onNewSession: () => void
  readonly onSelectSession: (sessionId: number) => void
  readonly onContinueLooplink: () => void
}

/**
 * Single compact desktop chrome row (40–44px): workspace-tools menu,
 * compact STARK identity, de-emphasized workspace name, then the
 * active session tab as the visual centerpiece with a New-session
 * action and a History/Looplink overflow. Flexible empty space
 * follows before the icon-only utilities (search, terminal,
 * settings, account). Renderer-local view state only — session data
 * is mirrored from SessionPanel, which stays the single owner.
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
  accountInitial,
  sessionTitle,
  sessions,
  selectedSessionId,
  sessionsLoading,
  looplinkActing,
  looplinkDisabled,
  onNewSession,
  onSelectSession,
  onContinueLooplink
}: AppChromeProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) {
      return
    }
    function handlePointer(event: PointerEvent): void {
      const target = event.target as Node | null
      if (target !== null && menuRef.current !== null && menuRef.current.contains(target)) {
        return
      }
      setMenuOpen(false)
    }
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [menuOpen])

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
      <span className="app-chrome__brand" aria-label="STARK">
        <StarkMark size="bar" />
        <img className="app-chrome__wordmark" src={STARK_WORDMARK_URL} alt="STARK" />
      </span>
      <span className="app-chrome__divider" aria-hidden="true" />
      <span className="app-chrome__identity" title={workspacePath}>
        <span className="app-chrome__workspace">{workspaceName}</span>
      </span>
      <span className="app-chrome__divider" aria-hidden="true" />
      <div className="app-chrome__tabs" role="tablist" aria-label="Active session">
        <div
          className="app-chrome__tab"
          role="tab"
          aria-selected="true"
          aria-label={`Active session: ${sessionTitle}`}
          title={sessionTitle}
        >
          <span className="app-chrome__tab-dot" aria-hidden="true" />
          <span className="app-chrome__tab-title">{sessionTitle}</span>
        </div>
      </div>
      <button
        className="app-chrome__newtab"
        type="button"
        onClick={onNewSession}
        disabled={sessionsLoading}
        aria-label="New session"
        title="New session"
      >
        <StarkIcon name="plus" size={15} />
      </button>
      <div className="app-chrome__popover" ref={menuRef}>
        <button
          className="app-chrome__control"
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-label="Session options"
          title="Session options"
        >
          <StarkIcon name="more" size={17} />
        </button>
        {menuOpen && (
          <div className="app-chrome__menu" role="menu" aria-label="Session options">
            <p className="app-chrome__menu-label">Session history</p>
            {sessions.length === 0 ? (
              <p className="app-chrome__menu-empty">No sessions yet.</p>
            ) : (
              <ul className="app-chrome__history-list">
                {sessions.map((entry) => (
                  <li key={entry.id}>
                    <button
                      className={
                        entry.id === selectedSessionId
                          ? 'app-chrome__history-item app-chrome__history-item--active'
                          : 'app-chrome__history-item'
                      }
                      type="button"
                      role="menuitem"
                      aria-current={entry.id === selectedSessionId}
                      onClick={() => {
                        onSelectSession(entry.id)
                        setMenuOpen(false)
                      }}
                    >
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <span className="app-chrome__menu-divider" aria-hidden="true" />
            <button
              className="app-chrome__menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                onContinueLooplink()
              }}
              disabled={looplinkDisabled}
            >
              {looplinkActing ? 'Preparing…' : 'Continue with Looplink'}
            </button>
          </div>
        )}
      </div>
      <span className="app-chrome__spacer" aria-hidden="true" />
      <div className="app-chrome__controls" role="toolbar" aria-label="View controls">
        <button
          className="app-chrome__control"
          type="button"
          onClick={onOpenSearch}
          aria-label="Search workspace"
          title="Search workspace"
        >
          <StarkIcon name="search" size={17} />
        </button>
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
