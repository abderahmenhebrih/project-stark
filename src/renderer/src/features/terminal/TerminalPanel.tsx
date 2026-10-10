import { Fragment, useRef, type ReactElement } from 'react'
import type { Terminal } from '@xterm/xterm'
import { StarkIcon } from '../../components/icons/StarkIcon'
import { TerminalInstanceView } from './TerminalInstanceView'
import type { HumanTerminalEntry } from './terminal-state'
import './TerminalPanel.css'

interface TerminalPanelProps {
  readonly sessions: readonly HumanTerminalEntry[]
  readonly activeId: string | null
  readonly visibleIds: readonly string[]
  readonly splitRatio: number | null
  readonly starting: boolean
  readonly onNew: () => void
  readonly onSplitPane: (sessionId: string) => void
  readonly onClearPane: (sessionId: string) => void
  readonly onClosePane: (sessionId: string) => void
  readonly onSplitRatioChange: (ratio: number) => void
  readonly onRegisterInstance: (sessionId: string, term: Terminal) => void
  readonly onUnregisterInstance: (sessionId: string) => void
}

/**
 * Multi-terminal viewport root (human terminals only).
 *
 * Exactly one TerminalInstanceView per live session, keyed by session
 * id in stable creation order — selection changes only toggle CSS
 * visibility, never remount. That is what preserves PTY processes,
 * buffers, scrollback, and command state across switches: unmounting
 * would dispose the xterm and lose everything. Split panes are
 * independent: input routes by construction, killing one never
 * touches the other. Presentational only: session lifecycle lives in
 * the Explorer-owned reducer.
 */
export function TerminalPanel({
  sessions,
  activeId,
  visibleIds,
  splitRatio,
  starting,
  onNew,
  onSplitPane,
  onClearPane,
  onClosePane,
  onSplitRatioChange,
  onRegisterInstance,
  onUnregisterInstance
}: TerminalPanelProps): ReactElement {
  const splitRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ readonly pointerId: number } | null>(null)

  const visibleCount = visibleIds.filter((id) => sessions.some((entry) => entry.id === id)).length
  const split = visibleCount === 2
  const ratio = splitRatio ?? 0.5

  function handleDividerPointerDown(event: React.PointerEvent): void {
    if (event.button !== 0 || !split) {
      return
    }
    dragRef.current = { pointerId: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleDividerPointerMove(event: React.PointerEvent): void {
    const drag = dragRef.current
    const container = splitRef.current
    if (drag === null || drag.pointerId !== event.pointerId || container === null) {
      return
    }
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0) {
      return
    }
    onSplitRatioChange((event.clientX - rect.left) / rect.width)
  }

  function handleDividerPointerEnd(event: React.PointerEvent): void {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) {
      return
    }
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Best effort; the drag is over either way.
    }
  }

  if (sessions.length === 0) {
    return (
      <section className="terminal terminal--empty" aria-label="Terminal">
        <p className="terminal__empty-title">Terminal</p>
        <p className="terminal__empty-copy">{starting ? 'Starting terminal…' : 'No terminals running.'}</p>
        {!starting && (
          <button className="explorer__primary" type="button" onClick={onNew}>
            New terminal
          </button>
        )}
      </section>
    )
  }

  return (
    <section className="terminal" aria-label="Terminal">
      <div ref={splitRef} className={split ? 'terminal-split' : 'terminal-single'}>
        {sessions.map((entry) => {
          // Stable key in creation order: toggling visibility below
          // only flips CSS, so React never remounts (and never
          // disposes) the xterm on selection changes.
          const active = entry.id === activeId
          const visibleIndex = visibleIds.indexOf(entry.id)
          const isVisible = visibleIndex !== -1
          const paneStyle = !isVisible
            ? { display: 'none' }
            : split
              ? {
                  flexGrow: 0,
                  flexShrink: 0,
                  flexBasis: `${(visibleIndex === 0 ? ratio : 1 - ratio) * 100}%`
                }
              : undefined
          return (
            <Fragment key={entry.id}>
              <div
                className={active ? 'terminal-pane terminal-pane--active' : 'terminal-pane'}
                style={paneStyle}
                aria-label={active ? `${entry.title} (active terminal)` : entry.title}
              >
                <div className="terminal-pane__header">
                  <StarkIcon name="terminal" size={14} />
                  <span className="terminal-pane__title">{entry.title}</span>
                  {entry.status !== 'running' && <span className="terminal-pane__meta">{entry.status}</span>}
                  <span className="terminal-pane__spacer" aria-hidden="true" />
                  <button
                    className="terminal-pane__iconbtn"
                    type="button"
                    onClick={() => onSplitPane(entry.id)}
                    disabled={entry.status !== 'running'}
                    aria-label={`Split ${entry.title}`}
                    title={entry.status === 'running' ? `Split ${entry.title}` : 'Start state cannot split'}
                  >
                    Split
                  </button>
                  <button
                    className="terminal-pane__iconbtn"
                    type="button"
                    onClick={() => onClearPane(entry.id)}
                    aria-label={`Clear ${entry.title}`}
                    title={`Clear ${entry.title}`}
                  >
                    Clear
                  </button>
                  <button
                    className="terminal-pane__iconbtn"
                    type="button"
                    onClick={() => onClosePane(entry.id)}
                    aria-label={`Close ${entry.title}`}
                    title={`Close ${entry.title}`}
                  >
                    <StarkIcon name="close" size={12} />
                  </button>
                </div>
                <TerminalInstanceView
                  sessionId={entry.id}
                  running={entry.status === 'running'}
                  visible={isVisible}
                  onRegister={onRegisterInstance}
                  onUnregister={onUnregisterInstance}
                />
              </div>
              {split && visibleIndex === 0 && (
                <div
                  className="terminal-split__divider"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize split terminals"
                  aria-valuenow={Math.round(ratio * 100)}
                  aria-valuemin={20}
                  aria-valuemax={80}
                  tabIndex={0}
                  onPointerDown={handleDividerPointerDown}
                  onPointerMove={handleDividerPointerMove}
                  onPointerUp={handleDividerPointerEnd}
                  onPointerCancel={handleDividerPointerEnd}
                />
              )}
            </Fragment>
          )
        })}
      </div>
    </section>
  )
}
