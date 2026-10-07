import { useEffect, useReducer, useRef, type ReactElement } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getTerminalApi } from '../../lib/terminal-api'
import { registerTerminalKillHandler, setTerminalActive } from './terminal-guard'
import { clampTerminalDimensions, initialTerminalState, terminalPanelReducer } from './terminal-state'
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS, TERMINAL_SCROLLBACK_LINES } from './terminal-dimensions'
import './TerminalPanel.css'

interface TerminalPanelProps {
  readonly workspaceId: number
}

function toDisplayError(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'We couldn’t start the terminal.'
}

/**
 * Human-controlled terminal panel (Stage 11).
 *
 * Collapsed by default; only an explicit Start creates a PTY through
 * the narrow terminal bridge. xterm renders locally-bundled output
 * only (no innerHTML), input flows as keystrokes via terminal.write,
 * and Clear affects display only. No auto-spawn, no persistence, no
 * agent access.
 */
export function TerminalPanel({ workspaceId }: TerminalPanelProps): ReactElement {
  const [state, dispatch] = useReducer(terminalPanelReducer, initialTerminalState())
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | null>(null)
  const statusRef = useRef(state.status)
  const workspaceRef = useRef(workspaceId)
  const resizeFrame = useRef<number | null>(null)
  const lastDims = useRef<{ cols: number; rows: number } | null>(null)

  useEffect(() => {
    statusRef.current = state.status
  }, [state.status])

  useEffect(() => {
    workspaceRef.current = workspaceId
  }, [workspaceId])

  // Publish running state for the workspace-switch guard.
  useEffect(() => {
    setTerminalActive(state.status === 'running')
    return () => {
      setTerminalActive(false)
    }
  }, [state.status])

  // Register bounded kill for confirmed workspace switches.
  useEffect(() => {
    registerTerminalKillHandler(async () => {
      const sessionId = sessionRef.current
      if (sessionId === null) {
        return
      }
      const api = getTerminalApi()
      if (api === undefined) {
        return
      }
      try {
        await api.kill({ sessionId })
      } catch {
        // Best effort; the switch proceeds and the panel resets.
      } finally {
        sessionRef.current = null
      }
    })
    return () => {
      registerTerminalKillHandler(null)
    }
  }, [])

  // Reset on workspace change: never carry a session across projects.
  useEffect(() => {
    dispatch({ type: 'workspace-changed' })
    sessionRef.current = null
    lastDims.current = null
    try {
      terminalRef.current?.dispose()
    } catch {
      // Best effort during reset.
    } finally {
      terminalRef.current = null
      fitRef.current = null
    }
  }, [workspaceId])

  // Fixed data/exit subscriptions: only the current session writes.
  useEffect(() => {
    const api = getTerminalApi()
    if (api === undefined) {
      return
    }
    const offData = api.onData((event) => {
      if (sessionRef.current === null || event.sessionId !== sessionRef.current) {
        return
      }
      if (statusRef.current !== 'running' && statusRef.current !== 'exited') {
        return
      }
      try {
        terminalRef.current?.write(event.data)
      } catch {
        // Best effort streaming.
      }
    })
    const offExit = api.onExit((event) => {
      if (sessionRef.current === null || event.sessionId !== sessionRef.current) {
        return
      }
      dispatch({ type: 'exit-received', exit: event })
      try {
        terminalRef.current?.write('\r\n[Terminal exited]\r\n')
      } catch {
        // Best effort.
      }
    })
    return () => {
      offData()
      offExit()
    }
  }, [])

  // Resize observation: fit locally, then send bounded dims (rAF debounce).
  useEffect(() => {
    const container = containerRef.current
    if (container === null || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (resizeFrame.current !== null) {
        cancelAnimationFrame(resizeFrame.current)
      }
      resizeFrame.current = requestAnimationFrame(() => {
        resizeFrame.current = null
        const term = terminalRef.current
        const fit = fitRef.current
        const sessionId = sessionRef.current
        if (term === null || fit === null || sessionId === null || statusRef.current !== 'running') {
          return
        }
        try {
          fit.fit()
        } catch {
          return
        }
        const proposed = fit.proposeDimensions()
        if (proposed === undefined || proposed.cols <= 0 || proposed.rows <= 0) {
          return
        }
        const dims = clampTerminalDimensions(proposed.cols, proposed.rows)
        const last = lastDims.current
        if (last !== null && last.cols === dims.cols && last.rows === dims.rows) {
          return
        }
        lastDims.current = dims
        const api = getTerminalApi()
        if (api === undefined) {
          return
        }
        api.resize({ sessionId, cols: dims.cols, rows: dims.rows }).catch(() => {
          // Resize failures are non-fatal; the shell keeps running.
        })
      })
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      if (resizeFrame.current !== null) {
        cancelAnimationFrame(resizeFrame.current)
        resizeFrame.current = null
      }
    }
  }, [state.status])

  function ensureTerminal(): Terminal | null {
    if (terminalRef.current !== null) {
      return terminalRef.current
    }
    const container = containerRef.current
    if (container === null) {
      return null
    }
    try {
      const term = new Terminal({
        allowTransparency: false,
        convertEol: false,
        cursorBlink: true,
        fontFamily: "'JetBrains Mono','Cascadia Code','Fira Code',Consolas,monospace",
        fontSize: 13,
        scrollback: TERMINAL_SCROLLBACK_LINES,
        theme: {
          background: '#0a0c0a',
          foreground: '#e9f1ea',
          cursor: '#c8ff00',
          selectionBackground: 'rgba(200, 255, 0, 0.25)'
        }
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      terminalRef.current = term
      fitRef.current = fit
      term.onData((data) => {
        const sessionId = sessionRef.current
        if (sessionId === null || statusRef.current !== 'running') {
          return
        }
        const api = getTerminalApi()
        if (api === undefined) {
          return
        }
        api.write({ sessionId, data }).catch(() => {
          // Write failures surface via exit/error paths; keep typing alive.
        })
      })
      return term
    } catch {
      return null
    }
  }

  async function handleStart(): Promise<void> {
    if (state.status === 'starting' || state.status === 'running') {
      return
    }
    const api = getTerminalApi()
    if (api === undefined) {
      dispatch({ type: 'start-failed', message: 'We couldn’t start the terminal.' })
      return
    }
    dispatch({ type: 'start-requested' })
    try {
      const term = ensureTerminal()
      let cols = DEFAULT_TERMINAL_COLS
      let rows = DEFAULT_TERMINAL_ROWS
      const fit = fitRef.current
      if (term !== null && fit !== null) {
        try {
          fit.fit()
          const proposed = fit.proposeDimensions()
          if (proposed !== undefined && proposed.cols > 0 && proposed.rows > 0) {
            const dims = clampTerminalDimensions(proposed.cols, proposed.rows)
            cols = dims.cols
            rows = dims.rows
          }
        } catch {
          // Fall back to defaults when layout is not ready.
        }
      }
      lastDims.current = { cols, rows }
      const session = await api.create({ workspaceId, cols, rows })
      sessionRef.current = session.id
      dispatch({ type: 'start-succeeded', session })
      try {
        term?.clear()
        term?.focus()
      } catch {
        // Best effort.
      }
    } catch (error) {
      sessionRef.current = null
      dispatch({ type: 'start-failed', message: toDisplayError(error) })
    }
  }

  function handleClear(): void {
    try {
      terminalRef.current?.clear()
    } catch {
      // Best effort display-only clear.
    }
  }

  function handleKill(): void {
    const sessionId = sessionRef.current
    if (sessionId === null) {
      dispatch({ type: 'closed' })
      return
    }
    const api = getTerminalApi()
    if (api === undefined) {
      return
    }
    dispatch({ type: 'kill-requested' })
    api.kill({ sessionId }).catch(() => {
      // Kill failures keep the exited UI; the exit event (or guard)
      // resolves the session. Never throw from an explicit control.
    })
  }

  function handleDismiss(): void {
    const sessionId = sessionRef.current
    const api = getTerminalApi()
    if (sessionId !== null && (state.status === 'running' || state.status === 'starting')) {
      api?.kill({ sessionId }).catch(() => {
        // Best effort; dismissal is authoritative.
      })
    }
    sessionRef.current = null
    try {
      terminalRef.current?.dispose()
    } catch {
      // Best effort.
    } finally {
      terminalRef.current = null
      fitRef.current = null
    }
    dispatch({ type: 'closed' })
  }

  const running = state.status === 'running'
  const starting = state.status === 'starting'
  const exited = state.status === 'exited'
  const shellLabel = state.session?.shell ?? ''

  return (
    <section className="terminal" aria-label="Terminal">
      <div className="terminal__bar" role="toolbar" aria-label="Terminal controls">
        <div className="terminal__identity">
          <span className="terminal__title">Terminal</span>
          {running && shellLabel !== '' && <span className="terminal__shell">{shellLabel}</span>}
          {starting && <span className="terminal__status">Starting…</span>}
          {exited && <span className="terminal__status">Terminal exited</span>}
        </div>
        <div className="terminal__actions">
          {state.status === 'closed' ? (
            <button className="terminal__primary" type="button" onClick={() => void handleStart()}>
              Start
            </button>
          ) : (
            <>
              <button className="terminal__secondary" type="button" onClick={handleClear}>
                Clear
              </button>
              {running || starting ? (
                <button className="terminal__secondary" type="button" onClick={handleKill}>
                  Kill
                </button>
              ) : (
                <>
                  <button className="terminal__primary" type="button" onClick={() => void handleStart()}>
                    Start
                  </button>
                  <button className="terminal__secondary" type="button" onClick={handleDismiss}>
                    Close
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {state.error !== null && (
        <p className="terminal__error" role="alert">
          {state.error}
        </p>
      )}
      {state.status !== 'closed' && (
        <div className="terminal__viewport">
          <div ref={containerRef} className="terminal__xterm" role="application" aria-label="Terminal" />
        </div>
      )}
    </section>
  )
}
