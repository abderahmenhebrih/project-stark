import { useEffect, useState, type ReactElement } from 'react'
import type { SessionUsageSummary, UsageSummary } from '../../../shared/usage/types'
import type { AgentTarget, StarkEffort } from '../../../shared/agent-target/types'
import { STARK_EFFORT_LABELS } from '../../../shared/agent-target/types'
import type { ProviderReadiness } from '../features/sessions/provider-readiness'
import { providerReadinessLabel } from '../features/sessions/provider-readiness'
import { getSessionUsageSummary } from '../lib/usage-api'
import { UiIcon } from '../components/icons/UiIcon'
import './UsageSidebar.css'

interface UsageSidebarProps {
  /** Active session title (actual session metadata). */
  readonly sessionTitle: string
  /** Active session creation timestamp, or null when none selected. */
  readonly sessionCreatedAt: number | null
  readonly selectedSessionId: number | null
  readonly planLabel: string
  readonly agentTarget: AgentTarget
  readonly agentLabel: string
  readonly effort: StarkEffort
  /** Canonical provider readiness — same value as the session banner. */
  readonly providerStatus: ProviderReadiness
  readonly providerModel: string | null
  /** Real local 24h usage summary, or null while unloaded. */
  readonly usageSummary: UsageSummary | null
  readonly onClose: () => void
}

function formatTokens(value: number | null): string {
  if (value === null) {
    return 'Not reported'
  }
  return `${value.toLocaleString('en-US')} tokens`
}

function formatTimestamp(createdAt: number): string {
  try {
    return new Date(createdAt).toLocaleString()
  } catch {
    return ''
  }
}

/**
 * Docked right-side session information panel (Usage destination).
 * Real layout space beside the workarea — never a floating popover.
 * Reads ONLY real mirrored state: session metadata, canonical
 * provider readiness, provider-reported token counts, plan, target,
 * and effort. Anything unknown renders as unavailable/not
 * reported/not tracked: no invented context windows, costs, or
 * token counts. No secrets (summaries carry counts only).
 */
export function UsageSidebar({
  sessionTitle,
  sessionCreatedAt,
  selectedSessionId,
  planLabel,
  agentTarget,
  agentLabel,
  effort,
  providerStatus,
  providerModel,
  usageSummary,
  onClose
}: UsageSidebarProps): ReactElement {
  const [sessionUsage, setSessionUsage] = useState<SessionUsageSummary | null>(null)
  const [sessionUsageError, setSessionUsageError] = useState(false)

  // Per-session usage reloads on session change and after every AI
  // call (the parent refreshes usageSummary when a send settles, so
  // it doubles as the live-update trigger). Existing state only —
  // no polling. The shell keys this panel by session, so state never
  // carries across sessions.
  useEffect(() => {
    if (selectedSessionId === null) {
      return
    }
    let cancelled = false
    getSessionUsageSummary(selectedSessionId).then(
      (summary) => {
        if (!cancelled) {
          setSessionUsage(summary)
          setSessionUsageError(false)
        }
      },
      () => {
        if (!cancelled) {
          setSessionUsage(null)
          setSessionUsageError(true)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [selectedSessionId, usageSummary])

  const contextTokens = sessionUsage?.latestInputTokens ?? null
  const headerStamp = sessionCreatedAt === null ? '' : formatTimestamp(sessionCreatedAt)

  return (
    <aside className="usage-sidebar" aria-label="Usage and session information">
      <div className="usage-sidebar__head">
        <div className="usage-sidebar__title-wrap">
          <p className="usage-sidebar__title" title={sessionTitle}>
            {sessionTitle}
          </p>
          {headerStamp !== '' && (
            <p className="usage-sidebar__stamp">{headerStamp}</p>
          )}
        </div>
        <button
          className="usage-sidebar__close"
          type="button"
          onClick={onClose}
          aria-label="Close usage sidebar"
          title="Close usage sidebar"
        >
          <UiIcon name="close" size={15} />
        </button>
      </div>

      <section className="usage-sidebar__section" aria-label="Context usage">
        <p className="usage-sidebar__label">Context</p>
        <p className="usage-sidebar__big">{contextTokens === null ? 'Not reported' : `${contextTokens.toLocaleString('en-US')} tokens`}</p>
        <p className="usage-sidebar__dim">Limit not reported</p>
      </section>

      <section className="usage-sidebar__section" aria-label="Session usage">
        <p className="usage-sidebar__label">Session</p>
        <dl className="usage-sidebar__rows">
          <div className="usage-sidebar__row">
            <dt>Calls</dt>
            <dd>{sessionUsageError ? 'Not reported' : String(sessionUsage?.calls ?? 0)}</dd>
          </div>
          <div className="usage-sidebar__row">
            <dt>Input tokens</dt>
            <dd>{sessionUsageError ? 'Not reported' : formatTokens(sessionUsage?.inputTokens ?? null)}</dd>
          </div>
          <div className="usage-sidebar__row">
            <dt>Output tokens</dt>
            <dd>{sessionUsageError ? 'Not reported' : formatTokens(sessionUsage?.outputTokens ?? null)}</dd>
          </div>
          <div className="usage-sidebar__row">
            <dt>Total tokens</dt>
            <dd>{sessionUsageError ? 'Not reported' : formatTokens(sessionUsage?.totalTokens ?? null)}</dd>
          </div>
        </dl>
      </section>

      <section className="usage-sidebar__section" aria-label="Cost">
        <p className="usage-sidebar__label">Cost</p>
        <p className="usage-sidebar__dim">Not tracked</p>
      </section>

      <section className="usage-sidebar__section" aria-label="Model and provider">
        <p className="usage-sidebar__label">Model</p>
        <dl className="usage-sidebar__rows">
          <div className="usage-sidebar__row">
            <dt>Plan</dt>
            <dd>{planLabel}</dd>
          </div>
          <div className="usage-sidebar__row">
            <dt>Agent</dt>
            <dd>{agentTarget.kind === 'stark' ? 'STARK' : agentLabel}</dd>
          </div>
          <div className="usage-sidebar__row">
            <dt>Provider</dt>
            <dd>
              {providerStatus === 'ready'
                ? 'OpenAI · Ready'
                : providerStatus === 'free'
                  ? 'STARK · Free'
                  : `STARK · ${providerReadinessLabel(providerStatus)}`}
            </dd>
          </div>
          <div className="usage-sidebar__row">
            <dt>Model</dt>
            <dd>{providerModel ?? 'Not reported'}</dd>
          </div>
          <div className="usage-sidebar__row">
            <dt>Effort</dt>
            <dd>{agentTarget.kind === 'stark' ? STARK_EFFORT_LABELS[effort] : 'Managed by extension'}</dd>
          </div>
        </dl>
      </section>
    </aside>
  )
}
