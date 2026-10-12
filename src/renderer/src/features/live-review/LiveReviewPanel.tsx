import { useState, type ReactElement } from 'react'
import { UiIcon } from '../../components/icons/UiIcon'
import { isAllowedLiveReviewUrl, liveReviewUrlError, normalizeLiveReviewInput } from './live-review-url'
import './LiveReviewPanel.css'

interface LiveReviewPanelProps {
  /** Known managed-runtime URL (tracked by STARK) used as the default. */
  readonly initialUrl: string | null
  readonly onClose: () => void
}

/**
 * Human Live Review: an integrated localhost reviewer for the user's
 * running app (NOT AI code review, NOT transaction Review).
 *
 * - Loopback only (localhost / 127.0.0.1 / ::1 + explicit port).
 * - Renderer-native sandboxed iframe (`allow-scripts
 *   allow-same-origin` so dev-server HMR works; no top navigation,
 *   no preload, no STARK APIs inside). Never Electron <webview>.
 * - No port scanning: the URL comes from the managed runtime STARK
 *   already tracks or from explicit user input.
 * - Opening this panel never grants the AI preview_inspect
 *   capability (separate human surface; capability rules untouched).
 * - Bounded failure copy; no infinite retry, no raw stack traces.
 */
export function LiveReviewPanel({ initialUrl, onClose }: LiveReviewPanelProps): ReactElement {
  const [draft, setDraft] = useState(initialUrl ?? '')
  const [activeUrl, setActiveUrl] = useState<string | null>(initialUrl && isAllowedLiveReviewUrl(initialUrl) ? initialUrl : null)
  const [error, setError] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  const [frameFailed, setFrameFailed] = useState(false)

  function loadUrl(raw: string): void {
    const normalized = normalizeLiveReviewInput(raw)
    if (!isAllowedLiveReviewUrl(normalized)) {
      setError(liveReviewUrlError(normalized))
      return
    }
    setError(null)
    setFrameFailed(false)
    setActiveUrl(normalized)
    setFrameKey((key) => key + 1)
  }

  return (
    <section className="live-review" aria-label="Live Review">
      <div className="live-review__bar">
        <p className="live-review__title">Live Review</p>
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
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              loadUrl(draft)
            }
          }}
        />
        <button
          className="live-review__btn"
          type="button"
          onClick={() => loadUrl(draft)}
          aria-label="Load preview"
          title="Load preview"
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
          title="Refresh preview"
        >
          <UiIcon name="refresh" size={15} />
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
      {error !== null && (
        <p className="live-review__error" role="alert">
          {error}
        </p>
      )}
      {activeUrl === null ? (
        <div className="live-review__empty" role="status">
          <p className="live-review__empty-text">
            Point Live Review at your running app — loopback only, e.g. http://localhost:3000.
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
            // scripts + same-origin (HMR/fetch to its own server). No
            // top navigation, no forms-to-parent, no STARK bridge. The
            // framed page is treated as untrusted web content.
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
    </section>
  )
}
