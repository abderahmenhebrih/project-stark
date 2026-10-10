import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ExtensionCommand, ExtensionPrompt } from '../../../../shared/extension-management/types'
import {
  acknowledgeAndActivateExtension,
  fireExtensionTrigger,
  invokeExtensionCommand,
  listExtensionCommands,
  listExtensionPrompts,
  onExtensionManagementEvent,
  resolveExtensionPrompt,
  setExtensionTrust
} from '../../lib/stark-api'
import { removeTrustRequest, requestExtensionTrust, subscribeTrustQueue, type TrustRequest } from './extension-trust-bus'
import { requestFormatDocument } from './format-request-bus'

/**
 * Global extension overlays (Steps 8+9): command palette, extension
 * prompts, trust dialogs, and notification toasts.
 *
 * Mounted once at the app root. The palette (Ctrl+Shift+P) lists
 * contributed extension commands and executes them through the
 * owner-aware runtime (demand-driven activation included). Prompts
 * render quick picks / input boxes requested by extensions with
 * bounded resolution. Trust dialogs gate first execution of
 * untrusted extensions. Toasts surface extension messages without
 * ever executing extension HTML (plain React text only).
 */

const MAX_PALETTE_RESULTS = 50
const MAX_TOASTS = 4
const TOAST_DISMISS_MS = 6000

/**
 * STARK built-in palette commands (not extension-contributed): run
 * through renderer-owned flows, never the extension runtime. The
 * Format Document entry fires the open file's existing format
 * handler (trust, stale guards, review pipeline) via the
 * format-request bus.
 */
const BUILT_IN_PALETTE_COMMANDS: readonly ExtensionCommand[] = [
  { command: 'stark.formatDocument', title: 'Format Document', category: 'STARK', extensionId: 'stark.builtin' }
]

function isBuiltInCommand(command: string): boolean {
  return command.startsWith('stark.')
}

interface Toast {
  readonly id: number
  readonly severity: string
  readonly message: string
}

let toastId = 1

function Palette({ onClose }: { readonly onClose: () => void }): ReactElement {
  const [input, setInput] = useState('')
  const [commands, setCommands] = useState<readonly ExtensionCommand[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let cancelled = false
    listExtensionCommands().then(
      (result) => {
        if (!cancelled) {
          setCommands(result)
        }
      },
      () => {
        if (!cancelled) {
          setCommands([])
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const query = input.trim().toLowerCase()
  const pool = [...BUILT_IN_PALETTE_COMMANDS, ...commands]
  const results = (query === '' ? pool : pool.filter((command) => `${command.title} ${command.command} ${command.category ?? ''}`.toLowerCase().includes(query))).slice(0, MAX_PALETTE_RESULTS)

  function handleRun(command: ExtensionCommand): void {
    if (running !== null) {
      return
    }
    if (isBuiltInCommand(command.command)) {
      // Built-in: renderer-owned flow (never the extension runtime).
      requestFormatDocument()
      onClose()
      return
    }
    setRunning(command.command)
    setError(null)
    invokeExtensionCommand(command.command, []).then(
      () => {
        setRunning(null)
        onClose()
      },
      (failure: unknown) => {
        setRunning(null)
        const message = failure instanceof Error ? failure.message : 'Command failed'
        if (message.includes('permission')) {
          // Untrusted owner: surface the trust dialog, then retry once.
          requestExtensionTrust({
            namespace: command.extensionId.split('.')[0] ?? '',
            name: command.extensionId.split('.')[0] !== undefined ? command.extensionId.slice(command.extensionId.indexOf('.') + 1, command.extensionId.lastIndexOf('@')) : '',
            version: command.extensionId.slice(command.extensionId.lastIndexOf('@') + 1),
            displayName: command.extensionId
          })
          setError('That extension needs permission before it can run. Grant it in the dialog, then run again.')
          return
        }
        setError(message)
      }
    )
  }

  return (
    <div className="ext-overlay__backdrop" onClick={onClose} role="presentation">
      <div
        className="ext-overlay__palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="ext-overlay__palette-input"
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onClose()
            }
            if (event.key === 'Enter' && results.length > 0 && results[0] !== undefined) {
              handleRun(results[0])
            }
          }}
          placeholder="Type a command…"
          aria-label="Command palette"
          autoComplete="off"
          spellCheck={false}
        />
        {error !== null && (
          <p className="ext-overlay__palette-error" role="alert">
            {error}
          </p>
        )}
        <ul className="ext-overlay__palette-list" aria-label="Extension commands">
          {results.map((command) => (
            <li key={command.command}>
              <button
                className="ext-overlay__palette-item"
                type="button"
                disabled={running !== null}
                onClick={() => handleRun(command)}
              >
                <span className="ext-overlay__palette-title">{command.title}</span>
                <span className="ext-overlay__palette-meta">
                  {command.category !== null ? `${command.category} · ` : ''}
                  {command.command}
                  {running === command.command ? ' · Running…' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {results.length === 0 && <p className="ext-overlay__palette-empty">No extension commands found.</p>}
      </div>
    </div>
  )
}

function PromptModal({ prompt, onDone }: { readonly prompt: ExtensionPrompt; readonly onDone: () => void }): ReactElement {
  const [value, setValue] = useState(prompt.value ?? '')
  const [selection, setSelection] = useState<string | null>(null)

  function resolve(resolution: { selected?: unknown; value?: string; cancelled?: boolean }): void {
    resolveExtensionPrompt({ promptId: prompt.promptId, ...resolution }).then(
      () => onDone(),
      () => onDone()
    )
  }

  if (prompt.kind === 'quickPick') {
    return (
      <div className="ext-overlay__backdrop" role="presentation">
        <div className="ext-overlay__prompt" role="dialog" aria-label={prompt.placeHolder ?? 'Choose an option'}>
          {prompt.placeHolder !== undefined && <p className="ext-overlay__prompt-title">{prompt.placeHolder}</p>}
          <ul className="ext-overlay__prompt-list">
            {(prompt.items ?? []).map((item) => (
              <li key={item}>
                <button
                  className={selection === item ? 'ext-overlay__prompt-item ext-overlay__prompt-item--selected' : 'ext-overlay__prompt-item'}
                  type="button"
                  onClick={() => {
                    setSelection(item)
                    resolve({ selected: prompt.canPickMany === true ? [item] : item })
                  }}
                >
                  {item}
                </button>
              </li>
            ))}
          </ul>
          <button className="ext-overlay__secondary" type="button" onClick={() => resolve({ cancelled: true })}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="ext-overlay__backdrop" role="presentation">
      <div className="ext-overlay__prompt" role="dialog" aria-label={prompt.prompt ?? 'Extension input'}>
        {prompt.prompt !== undefined && <p className="ext-overlay__prompt-title">{prompt.prompt}</p>}
        <input
          className="ext-overlay__prompt-input"
          type={prompt.password === true ? 'password' : 'text'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              resolve({ value })
            }
            if (event.key === 'Escape') {
              resolve({ cancelled: true })
            }
          }}
          placeholder={prompt.placeHolder ?? ''}
          aria-label={prompt.prompt ?? 'Extension input'}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        <div className="ext-overlay__prompt-actions">
          <button className="ext-overlay__secondary" type="button" onClick={() => resolve({ cancelled: true })}>
            Cancel
          </button>
          <button className="ext-overlay__primary" type="button" onClick={() => resolve({ value })}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

function TrustDialog({ request, onDone }: { readonly request: TrustRequest; readonly onDone: () => void }): ReactElement {
  const [persist, setPersist] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  function handleRun(): void {
    if (busy) {
      return
    }
    setBusy(true)
    setFailed(false)
    const identity = { namespace: request.namespace, name: request.name, version: request.version }
    const grant = persist ? setExtensionTrust(identity, true).then(() => undefined) : Promise.resolve()
    grant.then(
      () => {
        acknowledgeAndActivateExtension(identity).then(
          () => {
            setBusy(false)
            removeTrustRequest(request.key)
            onDone()
          },
          () => {
            setBusy(false)
            setFailed(true)
          }
        )
      },
      () => {
        setBusy(false)
        setFailed(true)
      }
    )
  }

  return (
    <div className="ext-overlay__backdrop" role="presentation">
      <div className="ext-overlay__prompt" role="alertdialog" aria-label={`Run ${request.displayName}?`}>
        <p className="ext-overlay__prompt-title">STARK is about to run {request.displayName}.</p>
        <p className="ext-overlay__prompt-copy">VS Code extensions can execute code on your computer.</p>
        <p className="ext-overlay__prompt-copy ext-overlay__prompt-copy--dim">
          This extension runs third-party Node.js code with your user permissions.
        </p>
        <label className="ext-overlay__trust-row">
          <input type="checkbox" checked={persist} onChange={(event) => setPersist(event.target.checked)} />
          Trust this extension
        </label>
        {failed && (
          <p className="ext-overlay__palette-error" role="alert">
            That extension could not be activated.
          </p>
        )}
        <div className="ext-overlay__prompt-actions">
          <button
            className="ext-overlay__secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              removeTrustRequest(request.key)
              onDone()
            }}
          >
            Cancel
          </button>
          <button className="ext-overlay__primary" type="button" disabled={busy} onClick={handleRun}>
            {busy ? 'Running…' : 'Run extension'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ExtensionOverlays(): ReactElement | null {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [prompts, setPrompts] = useState<readonly ExtensionPrompt[]>([])
  const [trustRequests, setTrustRequests] = useState<readonly TrustRequest[]>([])
  const [toasts, setToasts] = useState<readonly Toast[]>([])

  const refreshPrompts = useCallback((): void => {
    listExtensionPrompts().then(
      (result) => setPrompts(result),
      () => {}
    )
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'P' || event.key === 'p')) {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useEffect(() => subscribeTrustQueue((requests) => setTrustRequests(requests)), [])

  useEffect(() => {
    // Startup trigger (once per mount): only extensions explicitly
    // declaring onStartupFinished are considered; untrusted ones
    // surface as trust requests instead of auto-running.
    let cancelled = false
    fireExtensionTrigger({ kind: 'startup' }).then(
      (outcome) => {
        if (cancelled) {
          return
        }
        for (const id of outcome.needsTrust) {
          const at = id.lastIndexOf('@')
          const head = id.slice(0, at)
          const dot = head.indexOf('.')
          requestExtensionTrust({
            namespace: head.slice(0, dot),
            name: head.slice(dot + 1),
            version: id.slice(at + 1),
            displayName: head
          })
        }
      },
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    refreshPrompts()
    const unsubscribe = onExtensionManagementEvent((event) => {
      if (event.kind === 'prompt') {
        refreshPrompts()
        return
      }
      if (event.kind === 'notification') {
        const message = typeof event.payload['message'] === 'string' ? event.payload['message'] : ''
        const severity = typeof event.payload['severity'] === 'string' ? event.payload['severity'] : 'info'
        if (message === '') {
          return
        }
        const id = toastId++
        setToasts((current) => [...current, { id, severity, message: message.slice(0, 512) }].slice(-MAX_TOASTS))
        setTimeout(() => {
          setToasts((current) => current.filter((toast) => toast.id !== id))
        }, TOAST_DISMISS_MS)
      }
    })
    return unsubscribe
  }, [refreshPrompts])

  const activePrompt = prompts.length > 0 ? prompts[0] : undefined
  const activeTrust = trustRequests.length > 0 ? trustRequests[0] : undefined

  if (!paletteOpen && activePrompt === undefined && activeTrust === undefined && toasts.length === 0) {
    return null
  }

  return (
    <>
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
      {activePrompt !== undefined && <PromptModal prompt={activePrompt} onDone={refreshPrompts} />}
      {activeTrust !== undefined && <TrustDialog request={activeTrust} onDone={() => {}} />}
      {toasts.length > 0 && (
        <div className="ext-overlay__toasts" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <p key={toast.id} className={`ext-overlay__toast ext-overlay__toast--${toast.severity}`}>
              {toast.message}
            </p>
          ))}
        </div>
      )}
    </>
  )
}
