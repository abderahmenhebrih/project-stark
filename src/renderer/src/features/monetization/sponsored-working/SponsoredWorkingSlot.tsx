/**
 * STARK sponsored-working slot (Free-tier monetization surface).
 *
 * Observational only: renders a compact, calm, clearly labeled sponsor
 * line inside the existing AI working surface while STARK is genuinely
 * working, and disappears immediately when the run ends. Never delays
 * completion, streaming, tool results, cancellation, navigation,
 * Settings, or terminal input. Never inside chat messages, code,
 * terminal, or the editor. No popups, modals, banners, media, or
 * attention-stealing animation.
 *
 * Rendering consumes trusted structured text only (SponsorCreative).
 * No HTML sinks, no scripts, no iframes, no remote content.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { AiRunId, AiRunState, MonetizationEntitlement } from './sponsor-types'
import { isGenuinelyWorking } from './sponsor-lifecycle'
import { buildSponsorContext, type SponsorProvider } from './sponsor-provider'
import {
  createBoundedViewabilityTimer,
  getSharedRunImpressionLedger,
  readAppFocused,
  readAppVisible,
  shouldShowSponsor,
  SPONSOR_VIEWABLE_MIN_MS
} from './sponsor-viewability'
import {
  buildSponsorTelemetryEvent,
  NoopSponsorTelemetrySink,
  type SponsorTelemetrySink
} from './sponsor-telemetry'
import './SponsoredWorkingSlot.css'

export interface SponsoredWorkingSlotProps {
  /** Opaque run correlation key (Brain + Heart legs share one run id). */
  readonly runId: AiRunId
  /** Sponsor-observable AI activity state (observed, never controlled). */
  readonly aiState: AiRunState
  /** Narrow entitlement: Free eligible, paid ad-free. */
  readonly entitlement: MonetizationEntitlement
  /** Narrow provider (production: NullSponsorProvider → renders nothing). */
  readonly provider: SponsorProvider
  /** Local sink (production default: no-op, no upload). */
  readonly sink?: SponsorTelemetrySink
  /** Test/QA overrides; production reads document visibility + focus. */
  readonly visibleOverride?: boolean
  /** Test/QA overrides; production reads window focus. */
  readonly focusedOverride?: boolean
}

const SHARED_SINK_FALLBACK = new NoopSponsorTelemetrySink()

function subscribeAppPresence(callback: () => void): () => void {
  document.addEventListener('visibilitychange', callback)
  window.addEventListener('focus', callback)
  window.addEventListener('blur', callback)
  return () => {
    document.removeEventListener('visibilitychange', callback)
    window.removeEventListener('focus', callback)
    window.removeEventListener('blur', callback)
  }
}

function getVisibleSnapshot(): boolean {
  return readAppVisible()
}

function getFocusedSnapshot(): boolean {
  return readAppFocused()
}

function getServerSnapshot(): boolean {
  return true
}

/**
 * Single sponsored-working placement. Mount near the existing
 * "STARK is thinking…" / "Brain is working…" status; the slot itself
 * returns null unless every display condition holds. Pass key={runId}
 * so each run gets a fresh per-mount counted flag.
 */
export function SponsoredWorkingSlot({
  runId,
  aiState,
  entitlement,
  provider,
  sink = SHARED_SINK_FALLBACK,
  visibleOverride,
  focusedOverride
}: SponsoredWorkingSlotProps): ReactElement | null {
  // Whitelisted context only — no prompt/code/workspace data can reach here.
  const creative = useMemo(() => provider.getCreative(buildSponsorContext()), [provider])

  // Renderer-safe visibility/focus signals only (external store, no
  // polling). No mouse, keystroke, cursor, file, or repo activity tracking.
  const liveVisible = useSyncExternalStore(subscribeAppPresence, getVisibleSnapshot, getServerSnapshot)
  const liveFocused = useSyncExternalStore(subscribeAppPresence, getFocusedSnapshot, getServerSnapshot)
  const appVisible = visibleOverride ?? liveVisible
  const appFocused = focusedOverride ?? liveFocused

  const [viewable, setViewable] = useState(false)
  const [countedThisMount, setCountedThisMount] = useState(false)
  const renderStartedAtRef = useRef<number>(0)

  const frequencyCapExceeded = getSharedRunImpressionLedger().hasCounted(runId) && !countedThisMount

  const show = shouldShowSponsor({
    entitlement,
    aiState,
    appVisible,
    appFocused,
    creative,
    frequencyCapExceeded
  })

  // Observational viewability: one bounded timer per eligible mount.
  // Interruption, unmount, or run end cancels it — nothing counts.
  useEffect(() => {
    if (!show || creative === null) {
      return
    }
    renderStartedAtRef.current = Date.now()
    sink.record(
      buildSponsorTelemetryEvent(
        'sponsor_rendered',
        { runId, creativeId: creative.id, at: Date.now(), viewableDurationMs: 0 },
        false
      )
    )
    const ledger = getSharedRunImpressionLedger()
    const creativeId = creative.id
    const timer = createBoundedViewabilityTimer(() => {
      // Idempotent per-run counting: StrictMode/remount/tab-switch safe.
      const newlyCounted = ledger.markCounted(runId)
      setCountedThisMount(true)
      setViewable(true)
      const durationMs = Date.now() - renderStartedAtRef.current
      if (newlyCounted) {
        sink.record(
          buildSponsorTelemetryEvent(
            'sponsor_viewable',
            { runId, creativeId, at: Date.now(), viewableDurationMs: durationMs },
            true
          )
        )
      }
    })
    timer.start()
    return () => {
      timer.cancel()
      const durationMs = Date.now() - renderStartedAtRef.current
      sink.record(
        buildSponsorTelemetryEvent(
          'sponsor_hidden',
          { runId, creativeId, at: Date.now(), viewableDurationMs: durationMs },
          ledger.hasCounted(runId)
        )
      )
    }
  }, [show, creative, runId, sink])

  // AI completion always wins: no minimum advertising duration, no hold.
  if (!isGenuinelyWorking(aiState)) {
    return null
  }
  if (!show || creative === null) {
    return null
  }

  return (
    <div
      className="sponsor-slot"
      role="complementary"
      aria-label={`${creative.disclosureLabel}: ${creative.sponsorName}`}
      data-testid="sponsored-working-slot"
      data-run-id={runId}
      data-viewable={viewable ? 'true' : 'false'}
      data-viewable-min-ms={SPONSOR_VIEWABLE_MIN_MS}
    >
      <span className="sponsor-slot__label">{creative.disclosureLabel}</span>
      <span className="sponsor-slot__separator" aria-hidden="true">
        {' · '}
      </span>
      <span className="sponsor-slot__name">{creative.sponsorName}</span>
      <span className="sponsor-slot__message">{creative.message}</span>
    </div>
  )
}
