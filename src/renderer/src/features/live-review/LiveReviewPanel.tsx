import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { DetectPreviewResult, HumanPreviewSummary } from '../../../../shared/project-runtime/types'
import { UiIcon } from '../../components/icons/UiIcon'
import {
  detectPreview,
  getHumanPreview,
  restartHumanPreview,
  startHumanPreview,
  stopHumanPreview,
  subscribeHumanPreviewUpdates
} from '../../lib/runtimes-api'
import { isAllowedLiveReviewUrl, liveReviewUrlError, normalizeLiveReviewInput } from './live-review-url'
import './LiveReviewPanel.css'

interface LiveReviewPanelProps {
  readonly workspaceId: number
  /** Known worker-managed runtime URL (tracked by STARK) used when no human preview owns the pane. */
  readonly initialUrl: string | null
  readonly onClose: () => void
}

type PreviewSource = 'human' | 'worker' | 'external'

/**
 * Human Live Review: Lovable-style working preview workflow for the
 * user's web project (NOT AI code review, NOT transaction Review).
 *
 * Click Live Review → Start preview runs the detected `dev` script
 * through the managed runtime (explicit human consent authorizes
 * exactly that script) → the dev server appears inside STARK with
 * its normal HMR → Refresh/Restart/Stop manage the exact owned
 * process. The session stays mounted beside the preview.
 *
 * - Loopback only (localhost / 127.0.0.1 / ::1 + explicit port).
 * - Renderer-native sandboxed iframe (`allow-scripts
 *   allow-same-origin` so dev-server HMR works; no top navigation,
 *   no preload, no STARK APIs inside). Never an Electron webview
 *   element.
 * - No port scanning: URLs come from real server output or explicit
 *   user input. Stop never kills a server STARK doesn't own.
 * - Bounded failure copy; no infinite retry, no raw stack traces.
 */
export function LiveReviewPanel({ workspaceId, initialUrl, onClose }: LiveReviewPanelProps): ReactElement {
  const [detection, setDetection] = useState<DetectPreviewResult | null>(null)
  const [detectionError, setDetectionError] = useState<string | null>(null)
  const [preview, setPreview] = useState<HumanPreviewSummary | null>(null)
  const [source, setSource] = useState<PreviewSource | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [manualUrl, setManualUrl] = useState<string | null>(null)
  const [manualError, setManualError] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  const [frameFailed, setFrameFailed] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Adopt current truth on mount: an already-running human preview
  // wins; otherwise a known worker-managed URL is used as-is; else
  // detection decides between Start and an honest no-script message.
  useEffect(() => {
    let cancelled = false
    getHumanPreview({ workspaceId }).then(
      (current) => {
        if (cancelled || !mountedRef.current) {
          return
        }
        if (current !== null && (current.state === 'starting' || current.state === 'running')) {
          setPreview(current)
          setSource('human')
          return
        }
        if (current !== null) {
          setPreview(current)
          setSource('human')
        }
        if (initialUrl !== null && isAllowedLiveReviewUrl(initialUrl)) {
          if (current === null) {
            setSource('worker')
            setManualUrl(initialUrl)
          }
          return
        }
        detectPreview({ workspaceId }).then(
          (result) => {
            if (!cancelled && mountedRef.current) {
              setDetection(result)
            }
          },
          (error: unknown) => {
            if (!cancelled && mountedRef.current) {
              setDetectionError(error instanceof Error && error.message !== '' ? error.message : 'We couldn’t inspect this project.')
            }
          }
        )
      },
      () => {
        if (!cancelled && mountedRef.current) {
          detectPreview({ workspaceId }).then(
            (result) => {
              if (!cancelled && mountedRef.current) {
                setDetection(result)
              }
            },
            () => {}
          )
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [workspaceId, initialUrl])

  // Main-pushed human-preview updates (log flushes, URL discovery,
  // exits) — no polling.
  useEffect(
    () =>
      subscribeHumanPreviewUpdates((event) => {
        if (event.workspaceId !== workspaceId || !mountedRef.current) {
          return
        }
        if (event.preview !== null) {
          setPreview(event.preview)
          setSource('human')
          setBusy(false)
          if (event.preview.url !== null) {
            setFrameFailed(false)
          }
        } else if (source === 'human') {
          setPreview(null)
        }
      }),
    [workspaceId, source]
  )

  const humanActive = preview !== null && source === 'human' && (preview.state === 'starting' || preview.state === 'running')
  const humanOwned = preview !== null && source === 'human'
  const workerView = source === 'worker' && manualUrl !== null
  const externalView = source === 'external' && manualUrl !== null
  const activeUrl = humanOwned && preview.url !== null ? preview.url : workerView || externalView ? manualUrl : null

  const handleStart = useCallback(() => {
    setBusy(true)
    setActionError(null)
    startHumanPreview({ workspaceId }).then(
      (result) => {
        if (!mountedRef.current) {
          return
        }
        setBusy(false)
        if (result.status === 'started' || result.status === 'active') {
          if (result.preview !== null) {
            setPreview(result.preview)
          }
          setSource('human')
          setManualUrl(null)
          return
        }
        if (result.status === 'no-preview') {
          setActionError('No runnable preview script was found. Add a `dev` script to package.json.')
          return
        }
        setActionError(result.preview?.error ?? 'We couldn’t start the live preview.')
        if (result.preview !== null) {
          setPreview(result.preview)
          setSource('human')
        }
      },
      (error: unknown) => {
        if (mountedRef.current) {
          setBusy(false)
          setActionError(error instanceof Error && error.message !== '' ? error.message : 'We couldn’t start the live preview.')
        }
      }
    )
  }, [workspaceId])

  const handleStop = useCallback(() => {
    if (!humanOwned) {
      return
    }
    setBusy(true)
    setActionError(null)
    stopHumanPreview({ workspaceId }).then(
      (result) => {
        if (!mountedRef.current) {
          return
        }
        setBusy(false)
        if (result !== null) {
          setPreview(result)
        }
      },
      (error: unknown) => {
        if (mountedRef.current) {
          setBusy(false)
          setActionError(error instanceof Error && error.message !== '' ? error.message : 'We couldn’t stop the live preview.')
        }
      }
    )
  }, [workspaceId, humanOwned])

  const handleRestart = useCallback(() => {
    if (!humanOwned) {
      return
    }
    setBusy(true)
    setActionError(null)
    setFrameFailed(false)
    restartHumanPreview({ workspaceId }).then(
      (result) => {
        if (!mountedRef.current) {
          return
        }
        setBusy(false)
        if (result.preview !== null) {
          setPreview(result.preview)
          setSource('human')
          setFrameKey((key) => key + 1)
        } else if (result.status === 'no-preview') {
          setActionError('No runnable preview script was found. Add a `dev` script to package.json.')
        }
      },
      (error: unknown) => {
        if (mountedRef.current) {
          setBusy(false)
          setActionError(error instanceof Error && error.message !== '' ? error.message : 'We couldn’t restart the live preview.')
        }
      }
    )
  }, [workspaceId, humanOwned])

  function loadManualUrl(raw: string): void {
    const normalized = normalizeLiveReviewInput(raw)
    if (!isAllowedLiveReviewUrl(normalized)) {
      setManualError(liveReviewUrlError(normalized))
      return
    }
    setManualError(null)
    setFrameFailed(false)
    setManualUrl(normalized)
    setSource('external')
    setFrameKey((key) => key + 1)
  }

  const statusLabel =
    source === 'human' && preview !== null
      ? preview.state === 'starting'
        ? 'Starting preview…'
        : preview.state === 'running'
          ? preview.url === null
            ? 'Preview process is running, but STARK could not detect its URL.'
            : 'Running'
          : preview.state === 'failed'
            ? 'Preview failed'
            : 'Preview stopped'
      : source === 'worker'
        ? 'Running (managed runtime)'
        : source === 'external'
          ? 'External local server'
          : 'Idle'

  const scriptLine =
    source === 'human' && preview !== null
      ? `${preview.packageManager} run ${preview.script}`
      : detection !== null && detection.script !== null
        ? `${detection.packageManager ?? 'npm'} run ${detection.script}`
        : null

  return (
    <section className="live-review" aria-label="Live Review">
      <div className="live-review__bar">
        <p className="live-review__title">Live Review</p>
        {humanActive ? (
          <button
            className="live-review__btn"
            type="button"
            onClick={handleStop}
            disabled={busy}
            aria-label="Stop preview"
            title="Stop the STARK-owned preview process"
          >
            <UiIcon name="stop" size={15} />
            <span>Stop</span>
          </button>
        ) : (
          <button
            className="live-review__btn"
            type="button"
            onClick={handleStart}
            disabled={busy || source === 'worker'}
            aria-label="Start preview"
            title={scriptLine === null ? 'Start preview' : `Start preview (${scriptLine})`}
          >
            <UiIcon name="play" size={15} />
            <span>{busy ? 'Starting…' : 'Start preview'}</span>
          </button>
        )}
        <input
          className="live-review__input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="http://localhost:3000"
          aria-label="Localhost URL"
          title="Localhost URL (loopback only)"
          value={draft}
          disabled={humanActive}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              loadManualUrl(draft)
            }
          }}
        />
        <button
          className="live-review__btn"
          type="button"
          onClick={() => loadManualUrl(draft)}
          disabled={humanActive}
          aria-label="Load preview URL"
          title="Load preview URL"
        >
          <UiIcon name="live" size={15} />
          <span>Load</span>
        </button>
        <button
          className="live-review__iconbtn"
          type="button"
          onClick={() => {
            if (activeUrl !== null) {
              setFrameFailed(false)
              setFrameKey((key) => key + 1)
            }
          }}
          disabled={activeUrl === null}
          aria-label="Refresh preview"
          title="Refresh preview (reloads the page, keeps the server running)"
        >
          <UiIcon name="refresh" size={15} />
        </button>
        <button
          className="live-review__iconbtn"
          type="button"
          onClick={handleRestart}
          disabled={!humanOwned || busy}
          aria-label="Restart preview"
          title="Restart preview (restarts the owned server)"
        >
          <UiIcon name="restart" size={15} />
        </button>
        <button
          className="live-review__iconbtn"
          type="button"
          onClick={onClose}
          aria-label="Close Live Review"
          title="Close Live Review"
        >
          <UiIcon name="close" size={15} />
        </button>
      </div>
      <p className="live-review__status" role="status">
        {statusLabel}
        {scriptLine !== null && ` · ${scriptLine}`}
        {activeUrl !== null && ` · ${activeUrl}`}
      </p>
      {actionError !== null && (
        <p className="live-review__error" role="alert">
          {actionError}
        </p>
      )}
      {manualError !== null && (
        <p className="live-review__error" role="alert">
          {manualError}
        </p>
      )}
      {detectionError !== null && (
        <p className="live-review__error" role="alert">
          {detectionError}
        </p>
      )}
      {source === 'human' && preview !== null && preview.state === 'failed' && preview.error !== null && (
        <p className="live-review__error" role="alert">
          {preview.error}
        </p>
      )}
      {source === null && detection !== null && detection.script === null && (
        <p className="live-review__empty-text" role="status">
          {detection.reason === 'no-package-json'
            ? 'No package.json was found in this project, so there is nothing to preview.'
            : detection.reason === 'invalid-manifest'
              ? 'This project’s package.json could not be read, so there is nothing to preview.'
              : 'No runnable preview script was found. Add a `dev` script to package.json.'}
        </p>
      )}
      {source === 'external' && (
        <p className="live-review__note" role="status">
          External local server — STARK did not start it and will not stop it.
        </p>
      )}
      {activeUrl === null ? (
        <div className="live-review__empty" role="status">
          <p className="live-review__empty-text">
            {source === 'human' && preview?.state === 'starting'
              ? 'Starting the dev server… its address will appear here.'
              : 'Start the preview or enter a localhost URL above.'}
          </p>
        </div>
      ) : (
        <div className="live-review__frame-wrap">
          <iframe
            key={frameKey}
            className="live-review__frame"
            title="Live Review — localhost preview"
            src={activeUrl}
            // Narrowest permissions compatible with dev-server rendering:
            // scripts + same-origin (HMR/fetch/WebSocket to its own
            // server). No top navigation, no forms-to-parent, no STARK
            // bridge. The framed page is treated as untrusted content
            // and the dev server owns all hot updates.
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            onError={() => setFrameFailed(true)}
          />
          {frameFailed && (
            <p className="live-review__error" role="alert">
              {`Nothing is running at ${activeUrl}. Start your dev server and press Refresh.`}
            </p>
          )}
        </div>
      )}
      {source === 'human' && preview !== null && (
        <details className="live-review__logs">
          <summary>Runtime logs</summary>
          <pre className="live-review__log-body" aria-label="Runtime logs">
            {`${preview.stdoutTail.slice(-4000)}${preview.stderrTail === '' ? '' : `\n${preview.stderrTail.slice(-4000)}`}`.trim() === ''
              ? 'No output yet.'
              : `${preview.stdoutTail.slice(-4000)}${preview.stderrTail === '' ? '' : `\n${preview.stderrTail.slice(-4000)}`}`}
            {preview.logsTruncated && '\n… (older output truncated)'}
          </pre>
        </details>
      )}
    </section>
  )
}
