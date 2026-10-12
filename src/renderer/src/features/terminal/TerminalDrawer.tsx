import type { ReactElement } from 'react'
import { UiIcon } from '../../components/icons/UiIcon'
import type { HumanTerminalEntry } from './terminal-state'

interface TerminalDrawerProps {
  readonly sessions: readonly HumanTerminalEntry[]
  readonly activeId: string | null
  /** A creation is in flight (New stays available; no double spawn). */
  readonly starting: boolean
  readonly atCap: boolean
  /** Calm notice (cap reached, spawn failure). */
  readonly notice: string | null
  readonly onNew: () => void
  readonly onSplit: () => void
  readonly onDuplicate: () => void
  readonly onSelect: (sessionId: string) => void
  readonly onKill: (sessionId: string) => void
}

/**
 * Terminal management drawer (activity surface only): New/Split/
 * Duplicate actions plus the open-terminal list with active
 * selection. Every control performs its real action — no dead
 * buttons. Human terminals only; worker/runtime processes never
 * appear here. No PTY, xterm, or IPC in this file.
 */
export function TerminalDrawer({
  sessions,
  activeId,
  starting,
  atCap,
  notice,
  onNew,
  onSplit,
  onDuplicate,
  onSelect,
  onKill
}: TerminalDrawerProps): ReactElement {
  const canManage = activeId !== null && sessions.some((entry) => entry.id === activeId && entry.status === 'running')
  return (
    <div className="terminal-drawer" aria-label="Terminal management">
      <button
        className="terminal-drawer__new"
        type="button"
        onClick={onNew}
        disabled={atCap}
        aria-label="New terminal"
        title={atCap ? 'Too many terminals are open' : 'New terminal'}
      >
        <UiIcon name="plus" size={14} />
        <span>New terminal</span>
      </button>
      <p className="terminal-drawer__section" aria-hidden="true">
        Actions
      </p>
      <div className="terminal-drawer__actions" role="group" aria-label="Terminal actions">
        <button
          className="terminal-drawer__action"
          type="button"
          onClick={onSplit}
          disabled={!canManage}
          aria-label="Split terminal"
          title={canManage ? 'Split terminal' : 'Start a terminal first'}
        >
          Split terminal
        </button>
        <button
          className="terminal-drawer__action"
          type="button"
          onClick={onDuplicate}
          disabled={!canManage}
          aria-label="Duplicate terminal"
          title={canManage ? 'Duplicate terminal' : 'Start a terminal first'}
        >
          Duplicate terminal
        </button>
      </div>
      {starting && (
        <p className="terminal-drawer__status" role="status">
          Starting terminal…
        </p>
      )}
      {notice !== null && (
        <p className="terminal-drawer__notice" role="status">
          {notice}
        </p>
      )}
      <p className="terminal-drawer__section" aria-hidden="true">
        Open terminals
      </p>
      {sessions.length === 0 && !starting ? (
        <p className="terminal-drawer__empty">No terminals running.</p>
      ) : (
        <ul className="terminal-drawer__list" aria-label="Open terminals">
          {sessions.map((entry) => {
            const active = entry.id === activeId
            return (
              <li key={entry.id} className="terminal-drawer__row-wrap">
                <button
                  className={active ? 'terminal-drawer__row terminal-drawer__row--active' : 'terminal-drawer__row'}
                  type="button"
                  onClick={() => onSelect(entry.id)}
                  aria-label={active ? `${entry.title} (active terminal)` : `Switch to ${entry.title}`}
                  aria-current={active}
                  title={entry.title}
                >
                  <span className="terminal-drawer__indicator" aria-hidden="true" />
                  <UiIcon name="terminal" size={14} />
                  <span className="terminal-drawer__title">{entry.title}</span>
                  {entry.status !== 'running' && <span className="terminal-drawer__meta">{entry.status}</span>}
                </button>
                <button
                  className="terminal-drawer__kill"
                  type="button"
                  onClick={() => onKill(entry.id)}
                  aria-label={`Close ${entry.title}`}
                  title={`Close ${entry.title}`}
                >
                  <UiIcon name="close" size={12} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
