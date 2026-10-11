import type { Dispatch, ReactElement } from 'react'
import type { AgentCapability } from '../../../../../shared/capabilities/types'
import {
  CAPABILITY_ORDER,
  capabilityLabel,
  legalModesFor,
  type CapabilityPanelAction,
  type CapabilityPanelState
} from '../../sessions/capabilities-state'
import { StarkIcon, type StarkIconName } from '../../../components/icons/StarkIcon'
import './PermissionsSettings.css'

interface PermissionsSettingsProps {
  readonly workspaceId: number
  readonly capabilities: CapabilityPanelState
  readonly capabilitiesDispatch: Dispatch<CapabilityPanelAction>
  readonly onSaveCapabilities: () => void
}

/**
 * Capability groups for the dashboard (presentation only — ids, order
 * within groups, and enforcement all stay with CAPABILITY_ORDER and
 * the main-process gate).
 */
const CAPABILITY_GROUPS: readonly { readonly title: string; readonly members: readonly AgentCapability[] }[] = [
  { title: 'Read & inspect', members: ['workspace.read', 'workspace.search', 'git.read', 'runtime.observe', 'preview.inspect'] },
  { title: 'Change & import', members: ['change.propose', 'attachment.import'] },
  { title: 'Execute & generate', members: ['terminal.execute', 'image.generate'] }
]

/** Presentation copy per capability (semantics unchanged from the previous layout). */
const CAPABILITY_COPY: Record<AgentCapability, string> = {
  'workspace.read': 'Allows Worker models to read files in the current workspace.',
  'workspace.search': 'Allows Worker models to search text across workspace files.',
  'git.read': 'Allows Worker models to inspect Git status and diffs.',
  'change.propose': 'Allowing proposals does not allow STARK to apply them. File changes still require review and Accept.',
  'attachment.import': 'Allows the Worker to propose copying a chat attachment into the current project. Human review is still required before writing.',
  'image.generate': 'Allows the Worker to generate images using the configured AI provider. May use provider credits/API quota. Each generation needs your approval.',
  'terminal.execute': 'Terminal execution always requires approval for the exact command.',
  'runtime.observe': 'Allows the Worker to inspect the managed runtime\u2019s status and bounded stdout/stderr logs.',
  'preview.inspect': 'Allows the Worker to inspect bounded rendered content from STARK\u2019s local Live Preview. It does not allow clicking, typing, form submission, or DOM modification.'
}

/** Glyph per capability from the existing local icon set (no new assets). */
const CAPABILITY_ICON: Record<AgentCapability, StarkIconName> = {
  'workspace.read': 'explorer',
  'workspace.search': 'search',
  'git.read': 'git',
  'change.propose': 'review',
  'attachment.import': 'paperclip',
  'image.generate': 'context',
  'terminal.execute': 'terminal',
  'runtime.observe': 'refresh',
  'preview.inspect': 'extensions'
}

/**
 * Capabilities with execution or external-cost effects, per existing
 * enforced semantics (exact-command approval for terminal, provider
 * credits for image generation). Read-only capabilities are never
 * marked. No new classification — presentation emphasis only.
 */
const SENSITIVE_CAPABILITIES: ReadonlySet<AgentCapability> = new Set(['terminal.execute', 'image.generate'])

/**
 * Settings → Permissions dashboard: global kill-switch card plus
 * grouped capability cards with single-choice segmented policies.
 * Visual/layout only — enforcement, ids, legal modes, defaults,
 * persistence, and the explicit-save flow are untouched.
 */
export function PermissionsSettings(props: PermissionsSettingsProps): ReactElement {
  const { workspaceId, capabilities } = props
  const enabled = capabilities.draft.enabled
  const counts = { deny: 0, ask: 0, allow: 0 }
  for (const capability of CAPABILITY_ORDER) {
    counts[capabilities.draft.modes[capability]] += 1
  }
  const configured = counts.ask + counts.allow
  return (
    <section aria-label="Permissions" className="permissions-page">
      <p className="settings-section__title">Permissions</p>
      <p className="settings-section__copy">Control what STARK agents can access and do.</p>
      <div className="permissions-global">
        <div className="permissions-global__text">
          <p className="permissions-global__title">Agent Permissions</p>
          <p className="permissions-global__copy">Enable or disable Worker capability requests for this workspace.</p>
          <p className="session__hint" role="note">
            Permissions only control whether future STARK Worker tools may request an action. They do not bypass
            Workspace security or human review.
          </p>
          <p className="permissions-global__summary" role="status">
            {enabled
              ? `${String(configured)} of ${String(CAPABILITY_ORDER.length)} capabilities configured · ${String(counts.ask)} Ask · ${String(counts.deny)} Deny · ${String(counts.allow)} Allow`
              : 'Agent permissions Disabled'}
          </p>
        </div>
        <div className="permissions-segment" role="group" aria-label="Agent Permissions">
          <button
            className={'permissions-segment__option' + (!enabled ? ' permissions-segment__option--selected' : '')}
            type="button"
            onClick={() => props.capabilitiesDispatch({ type: 'enabled-toggled', workspaceId, enabled: false })}
            aria-pressed={!enabled}
          >
            Disabled
          </button>
          <button
            className={'permissions-segment__option' + (enabled ? ' permissions-segment__option--selected' : '')}
            type="button"
            onClick={() => props.capabilitiesDispatch({ type: 'enabled-toggled', workspaceId, enabled: true })}
            aria-pressed={enabled}
          >
            Enabled
          </button>
        </div>
      </div>
      <div aria-disabled={!enabled} className={enabled ? undefined : 'permissions-grid--muted'}>
        {CAPABILITY_GROUPS.map((group) => (
          <section key={group.title} aria-label={group.title} className="permissions-group">
            <p className="permissions-group__title">{group.title}</p>
            <div className="permissions-grid" role="group" aria-label="Workspace Agent Capabilities">
              {group.members.map((capability) => {
                const selected = capabilities.draft.modes[capability]
                return (
                  <article
                    key={capability}
                    aria-label={`${capabilityLabel(capability)} permission`}
                    className={
                      'permissions-card' +
                      (SENSITIVE_CAPABILITIES.has(capability) ? ' permissions-card--sensitive' : '')
                    }
                  >
                    <div className="permissions-card__head">
                      <span className="permissions-card__icon" aria-hidden="true">
                        <StarkIcon name={CAPABILITY_ICON[capability]} size={16} />
                      </span>
                      <span className="permissions-card__name">{capabilityLabel(capability)}</span>
                      {SENSITIVE_CAPABILITIES.has(capability) ? (
                        <span className="permissions-card__flag">Sensitive</span>
                      ) : null}
                    </div>
                    <p className="permissions-card__copy">{CAPABILITY_COPY[capability]}</p>
                    <div
                      className="permissions-segment permissions-segment--policy"
                      role="radiogroup"
                      aria-label={`${capabilityLabel(capability)} policy`}
                    >
                      {legalModesFor(capability).map((mode) => (
                        <button
                          key={mode}
                          className={
                            'permissions-segment__option permissions-segment__option--' +
                            mode +
                            (selected === mode ? ' permissions-segment__option--selected' : '')
                          }
                          type="button"
                          role="radio"
                          aria-checked={selected === mode}
                          onClick={() =>
                            props.capabilitiesDispatch({ type: 'mode-selected', workspaceId, capability, mode })
                          }
                          disabled={!enabled}
                        >
                          {mode === 'deny' ? 'Deny' : mode === 'ask' ? 'Ask' : 'Allow'}
                        </button>
                      ))}
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ))}
      </div>
      {!enabled && (
        <p className="session__hint" role="note">
          Enable Agent Permissions to use these capability policies.
        </p>
      )}
      {capabilities.loading && (
        <p className="session__status" role="status">
          Loading permissions…
        </p>
      )}
      {capabilities.loadError !== null && (
        <p className="session__error" role="alert">
          {capabilities.loadError}
        </p>
      )}
      {capabilities.saveError !== null && (
        <p className="session__error" role="alert">
          {capabilities.saveError}
        </p>
      )}
      {capabilities.notice !== null && (
        <p className="session__status" role="status">
          {capabilities.notice}
        </p>
      )}
      <div className="session__settings-row">
        <button
          className="explorer__primary"
          type="button"
          onClick={props.onSaveCapabilities}
          disabled={capabilities.saving}
        >
          {capabilities.saving ? 'Saving…' : 'Save permissions'}
        </button>
      </div>
    </section>
  )
}
