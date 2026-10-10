import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
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
  readonly onOpenSearch: () => void
  readonly onOpenSettings: () => void
  readonly onOpenAccount: () => void
  readonly accountInitial: string
  /** Active session tab: title mirrored from the SessionPanel reducer. */
  readonly sessionTitle: string
  readonly sessions: readonly SessionChromeSession[]
  readonly selectedSessionId: number | null
  readonly sessionsLoading: boolean
  /** A creation is in flight: + stays disabled until it settles. */
  readonly creatingSession: boolean
  readonly looplinkActing: boolean
  readonly looplinkDisabled: boolean
  readonly onNewSession: () => void
  readonly onSelectSession: (sessionId: number) => void
  /** Closes the visible tab (presentation only — history is preserved). */
  readonly onCloseSession: () => void
  readonly onContinueLooplink: () => void
  /** Guarded workspace-root switch (same flow as “Open another folder”). */
  readonly onSwitchWorkspace: () => void
}

interface SessionOptionsMenuProps {
  /** Anchor rect captured from the ... button when the menu opened. */
  readonly anchor: { readonly left: number; readonly bottom: number; readonly top: number }
  readonly sessions: readonly SessionChromeSession[]
  readonly selectedSessionId: number | null
  readonly looplinkActing: boolean
  readonly looplinkDisabled: boolean
  readonly onSelectSession: (sessionId: number) => void
  readonly onContinueLooplink: () => void
  readonly onClose: () => void
  /** Focus returns here on close (the ... button). */
  readonly returnFocus: () => void
}

/**
 * Session-options dropdown rendered into a document.body portal with
 * fixed positioning from the ... button's bounding rect.
 *
 * Root cause of the previous stacking defect: the menu was absolutely
 * positioned inside the 60–64px header, which carries
 * `overflow: hidden` — the 320px menu was clipped by its own chrome —
 * and its z-index lived inside the header stacking context, so it
 * painted behind/under the session tab. The portal escapes both the
 * clipping container and every chrome/tab stacking context. Layering:
 * above tabs and the tools drawer, below true modal dialogs.
 */
function SessionOptionsMenu({
  anchor,
  sessions,
  selectedSessionId,
  looplinkActing,
  looplinkDisabled,
  onSelectSession,
  onContinueLooplink,
  onClose,
  returnFocus
}: SessionOptionsMenuProps): ReactElement | null {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<{ readonly top: number; readonly left: number } | null>(null)

  // Measure once mounted (and on viewport changes) so the menu stays
  // inside the viewport: flips above the anchor when there is no room
  // below, shifts left when near the right edge.
  useLayoutEffect(() => {
    function place(): void {
      const element = menuRef.current
      const width = element?.offsetWidth ?? 260
      const height = element?.offsetHeight ?? 200
      const margin = 8
      let left = Math.min(anchor.left, window.innerWidth - width - margin)
      left = Math.max(margin, left)
      let top = anchor.bottom + 4
      if (top + height > window.innerHeight - margin) {
        top = anchor.top - height - 4
      }
      top = Math.max(margin, top)
      setPlacement((prev) => (prev !== null && prev.top === top && prev.left === left ? prev : { top, left }))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])

  useEffect(() => {
    function handlePointer(event: PointerEvent): void {
      const target = event.target as Node | null
      if (target !== null && menuRef.current !== null && menuRef.current.contains(target)) {
        return
      }
      onClose()
    }
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey, true)
    // Keyboard accessibility: focus the first action on open.
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('keydown', handleKey, true)
      returnFocus()
    }
  }, [onClose, returnFocus])

  return createPortal(
    <div
      ref={menuRef}
      className="app-chrome__menu app-chrome__menu--portal"
      role="menu"
      aria-label="Session options"
      style={placement === null ? { visibility: 'hidden' } : { top: placement.top, left: placement.left }}
    >
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
                  onClose()
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
          onClose()
          onContinueLooplink()
        }}
        disabled={looplinkDisabled}
      >
        {looplinkActing ? 'Preparing…' : 'Continue with Looplink'}
      </button>
    </div>,
    document.body
  )
}

/**
 * Single desktop chrome row (60–64px): workspace-tools menu,
 * STARK identity, clickable workspace name (secondary-brand accent,
 * same guarded switch flow as “Open another folder”), then the
 * active session tab as the visual centerpiece with a New-session
 * action, a presentation-only close affordance, and a
 * History/Looplink overflow. Flexible empty space follows before the
 * icon-only utilities (search, settings, account). The terminal lives
 * on the activity rail below Extensions — never in this bar.
 * Renderer-local view state only — session data is mirrored from
 * SessionPanel, which stays the single owner.
 */
export function AppChrome({
  workspaceName,
  workspacePath,
  sidebarOpen,
  onToggleSidebar,
  onOpenSearch,
  onOpenSettings,
  onOpenAccount,
  accountInitial,
  sessionTitle,
  sessions,
  selectedSessionId,
  sessionsLoading,
  creatingSession,
  looplinkActing,
  looplinkDisabled,
  onNewSession,
  onSelectSession,
  onCloseSession,
  onContinueLooplink,
  onSwitchWorkspace
}: AppChromeProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const optionsButtonRef = useRef<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<{ readonly left: number; readonly bottom: number; readonly top: number } | null>(null)

  function openMenu(): void {
    const rect = optionsButtonRef.current?.getBoundingClientRect()
    if (rect !== undefined) {
      setAnchor({ left: rect.left, bottom: rect.bottom, top: rect.top })
    } else {
      setAnchor({ left: 8, bottom: 64, top: 8 })
    }
    setMenuOpen(true)
  }

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
  }, [])

  const returnFocusToOptions = useCallback(() => {
    optionsButtonRef.current?.focus()
  }, [])

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
        <StarkIcon name="menu" size={22} />
      </button>
      <span className="app-chrome__brand" aria-label="STARK">
        <StarkMark size="bar" />
        <img className="app-chrome__wordmark" src={STARK_WORDMARK_URL} alt="STARK" />
      </span>
      <span className="app-chrome__divider" aria-hidden="true" />
      <button
        className="app-chrome__identity"
        type="button"
        onClick={onSwitchWorkspace}
        title={`${workspacePath} — switch project`}
        aria-label={`Switch project (current: ${workspaceName})`}
      >
        <span className="app-chrome__workspace">{workspaceName}</span>
      </button>
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
          <button
            className="app-chrome__tab-close"
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onCloseSession()
            }}
            aria-label="Close session"
            title="Close session"
          >
            <StarkIcon name="close" size={13} />
          </button>
        </div>
      </div>
      <button
        className="app-chrome__newtab"
        type="button"
        onClick={onNewSession}
        disabled={sessionsLoading || creatingSession}
        aria-label="New session"
        title="New session"
      >
        <StarkIcon name="plus" size={19} />
      </button>
      <div className="app-chrome__popover">
        <button
          ref={optionsButtonRef}
          className="app-chrome__control"
          type="button"
          onClick={() => (menuOpen ? closeMenu() : openMenu())}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label="Session options"
          title="Session options"
        >
          <StarkIcon name="more" size={22} />
        </button>
      </div>
      {menuOpen && anchor !== null && (
        <SessionOptionsMenu
          anchor={anchor}
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          looplinkActing={looplinkActing}
          looplinkDisabled={looplinkDisabled}
          onSelectSession={onSelectSession}
          onContinueLooplink={onContinueLooplink}
          onClose={closeMenu}
          returnFocus={returnFocusToOptions}
        />
      )}
      <span className="app-chrome__spacer" aria-hidden="true" />
      <div className="app-chrome__controls" role="toolbar" aria-label="View controls">
        <button
          className="app-chrome__control"
          type="button"
          onClick={onOpenSearch}
          aria-label="Search workspace"
          title="Search workspace"
        >
          <StarkIcon name="search" size={22} />
        </button>
        <button
          className="app-chrome__control"
          type="button"
          onClick={onOpenSettings}
          aria-label="Open settings"
          title="Settings"
        >
          <StarkIcon name="settings" size={22} />
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
