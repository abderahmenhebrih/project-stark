import { useEffect, useRef, type ReactElement } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getTerminalApi } from '../../lib/terminal-api'
import { clampTerminalDimensions } from './terminal-state'
import { TERMINAL_SCROLLBACK_LINES } from './terminal-dimensions'

interface TerminalInstanceViewProps {
  /** Opaque main-owned session id (stable per PTY). */
  readonly sessionId: string
  /** True while the PTY is alive (keystrokes/resize flow only then). */
  readonly running: boolean
  /** False for background instances (kept mounted, buffer preserved). */
  readonly visible: boolean
  readonly onRegister: (sessionId: string, term: Terminal) => void
  readonly onUnregister: (sessionId: string) => void
}

/**
 * One owned xterm instance bound to exactly one PTY session.
 *
 * The component stays mounted while its session lives — including
 * while hidden (display:none) — so the PTY process, output buffer,
 * and scroll position survive tab switches. Keystrokes route by
 * construction (this instance's session id only); typing in a split
 * neighbor can never reach this PTY. Disposal happens exactly once
 * on unmount (session removal).
 */
export function TerminalInstanceView({
  sessionId,
  running,
  visible,
  onRegister,
  onUnregister
}: TerminalInstanceViewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef(sessionId)
  const runningRef = useRef(running)
  const resizeFrame = useRef<number | null>(null)
  const lastDims = useRef<{ cols: number; rows: number } | null>(null)

  useEffect(() => {
    sessionRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    runningRef.current = running
  }, [running])

  // Mount exactly one xterm for this session; dispose on unmount.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) {
      return
    }
    let term: Terminal | null = null
    try {
      term = new Terminal({
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
      onRegister(sessionRef.current, term)
      term.onData((data) => {
        if (!runningRef.current) {
          return
        }
        const api = getTerminalApi()
        if (api === undefined) {
          return
        }
        api.write({ sessionId: sessionRef.current, data }).catch(() => {
          // Write failures surface via exit/error paths; keep typing alive.
        })
      })
    } catch {
      term = null
    }
    return () => {
      onUnregister(sessionRef.current)
      try {
        term?.dispose()
      } catch {
        // Best effort during teardown.
      } finally {
        if (terminalRef.current === term) {
          terminalRef.current = null
          fitRef.current = null
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  function fitAndReport(): void {
    const term = terminalRef.current
    const fit = fitRef.current
    if (term === null || fit === null || !runningRef.current) {
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
    api.resize({ sessionId: sessionRef.current, cols: dims.cols, rows: dims.rows }).catch(() => {
      // Resize failures are non-fatal; the shell keeps running.
    })
  }

  // Refit when revealed (hidden containers measure zero) and on
  // container resizes (rAF debounce, single observer, full cleanup).
  // Hidden instances stay mounted (buffer preserved) but observe
  // nothing: a display:none container only ever measures zero, so
  // observing it would churn rAF without ever reporting a resize.
  useEffect(() => {
    if (visible) {
      fitAndReport()
    } else {
      return
    }
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
        fitAndReport()
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
  }, [visible, sessionId])

  return (
    <div
      ref={containerRef}
      className="terminal__xterm"
      role="application"
      aria-label="Terminal"
      style={visible ? undefined : { display: 'none' }}
    />
  )
}
