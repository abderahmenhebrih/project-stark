import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { CodingSession } from '../../../../shared/sessions/types'
import { StarkIcon } from '../../components/icons/StarkIcon'

interface SessionHeaderBarProps {
  readonly title: string
  readonly sessions: readonly CodingSession[]
  readonly selectedSessionId: number | null
  readonly sessionsLoading: boolean
  readonly onNew: () => void
  readonly onSelect: (sessionId: number) => void
  readonly onOpenSettings: () => void
  readonly onContinueLooplink: () => void
  readonly looplinkActing: boolean
  readonly sendBusy: boolean
}

/**
 * Compact session header: title, New, History popover, overflow menu.
 * History lists actual session titles (existing state.sessions);
 * Looplink continuation lives in the overflow menu, not as a
 * permanent full-width row. Presentational only.
 */
export function SessionHeaderBar({
  title,
  sessions,
  selectedSessionId,
  sessionsLoading,
  onNew,
  onSelect,
  onOpenSettings,
  onContinueLooplink,
  looplinkActing,
  sendBusy
}: SessionHeaderBarProps): ReactElement {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const historyRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!historyOpen && !menuOpen) {
      return
    }
    function handlePointer(event: PointerEvent): void {
      const target = event.target as Node | null
      if (
        target !== null &&
        ((historyRef.current !== null && historyRef.current.contains(target)) ||
          (menuRef.current !== null && menuRef.current.contains(target)))
      ) {
        return
      }
      setHistoryOpen(false)
      setMenuOpen(false)
    }
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setHistoryOpen(false)
        setMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [historyOpen, menuOpen])

  return (
    <div className="session__header">
      <p className="session__eyebrow">Session</p>
      <p className="session__title" title={title}>
        {title}
      </p>
      <button
        className="session__new"
        type="button"
        onClick={onNew}
        disabled={sessionsLoading}
        aria-label="New session"
        title="New session"
      >
        <StarkIcon name="plus" size={15} />
        <span className="session__new-label">New</span>
      </button>
      <div className="session__popover" ref={historyRef}>
        <button
          className="session__icon-btn"
          type="button"
          onClick={() => {
            setHistoryOpen((open) => !open)
            setMenuOpen(false)
          }}
          aria-expanded={historyOpen}
          aria-label="Session history"
          title="Session history"
        >
          <StarkIcon name="chevron-down" size={15} />
          <span className="session__icon-btn-label">History</span>
        </button>
        {historyOpen && (
          <div className="session__popover-body" role="menu" aria-label="Session history">
            {sessions.length === 0 ? (
              <p className="session__hint">No sessions yet.</p>
            ) : (
              <ul className="session__history-list">
                {sessions.map((entry) => (
                  <li key={entry.id}>
                    <button
                      className={
                        entry.id === selectedSessionId
                          ? 'session__history-item session__history-item--active'
                          : 'session__history-item'
                      }
                      type="button"
                      role="menuitem"
                      aria-current={entry.id === selectedSessionId}
                      onClick={() => {
                        onSelect(entry.id)
                        setHistoryOpen(false)
                      }}
                    >
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div className="session__popover" ref={menuRef}>
        <button
          className="session__icon-btn"
          type="button"
          onClick={() => {
            setMenuOpen((open) => !open)
            setHistoryOpen(false)
          }}
          aria-expanded={menuOpen}
          aria-label="Session options"
          title="Session options"
        >
          <StarkIcon name="more" size={15} />
        </button>
        {menuOpen && (
          <div className="session__popover-body" role="menu" aria-label="Session options">
            <button
              className="session__menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                onContinueLooplink()
              }}
              disabled={selectedSessionId === null || looplinkActing || sendBusy}
            >
              {looplinkActing ? 'Preparing…' : 'Continue with Looplink'}
            </button>
            <button
              className="session__menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                onOpenSettings()
              }}
            >
              Settings
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
