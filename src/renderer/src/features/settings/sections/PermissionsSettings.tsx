import type { Dispatch, ReactElement } from 'react'
import {
  CAPABILITY_ORDER,
  capabilityLabel,
  legalModesFor,
  type CapabilityPanelAction,
  type CapabilityPanelState
} from '../../sessions/capabilities-state'

interface PermissionsSettingsProps {
  readonly workspaceId: number
  readonly capabilities: CapabilityPanelState
  readonly capabilitiesDispatch: Dispatch<CapabilityPanelAction>
  readonly onSaveCapabilities: () => void
}

/**
 * Settings → Permissions: the existing workspace capability
 * configuration, re-housed without enforcement or behavior changes.
 * Only genuinely enforced modes are offered (terminal execution
 * always requires exact-command approval; proposals still require
 * review and Accept). Detailed per-integration controls will appear
 * here as STARK integrations expand.
 */
export function PermissionsSettings(props: PermissionsSettingsProps): ReactElement {
  const { workspaceId, capabilities } = props
  return (
    <section aria-label="Permissions">
      <p className="settings-section__title">Permissions</p>
      <p className="settings-section__copy">Control what STARK is allowed to access and do.</p>
      <div className="session__settings-row">
        <span className="session__eyebrow">Agent Permissions</span>
        <span className="session__hint">{capabilities.draft.enabled ? 'Enabled' : 'Disabled'}</span>
      </div>
      <p className="session__hint" role="note">
        Permissions only control whether future STARK Worker tools may request an action. They do not bypass
        Workspace security or human review.
      </p>
      <div className="session__settings-row">
        <span className="session__eyebrow">Workspace Agent Capabilities</span>
      </div>
      <div className="session__composer-row" role="group" aria-label="Workspace agent capabilities">
        <button
          className="explorer__secondary"
          type="button"
          onClick={() => props.capabilitiesDispatch({ type: 'enabled-toggled', workspaceId, enabled: false })}
          aria-pressed={!capabilities.draft.enabled}
        >
          Disabled
        </button>
        <button
          className="explorer__secondary"
          type="button"
          onClick={() => props.capabilitiesDispatch({ type: 'enabled-toggled', workspaceId, enabled: true })}
          aria-pressed={capabilities.draft.enabled}
        >
          Enabled
        </button>
      </div>
      <div aria-disabled={!capabilities.draft.enabled}>
        {CAPABILITY_ORDER.map((capability) => (
          <div key={capability}>
            <p className="session__eyebrow">{capabilityLabel(capability)}</p>
            <div className="session__composer-row" role="group" aria-label={`${capability} permission`}>
              {legalModesFor(capability).map((mode) => (
                <button
                  key={mode}
                  className="explorer__secondary"
                  type="button"
                  onClick={() => props.capabilitiesDispatch({ type: 'mode-selected', workspaceId, capability, mode })}
                  aria-pressed={capabilities.draft.modes[capability] === mode}
                  disabled={!capabilities.draft.enabled}
                >
                  {mode === 'deny' ? 'Deny' : mode === 'ask' ? 'Ask' : 'Allow'}
                </button>
              ))}
            </div>
            {capability === 'terminal.execute' && (
              <p className="session__hint" role="note">
                Terminal execution always requires approval for the exact command.
              </p>
            )}
            {capability === 'change.propose' && (
              <p className="session__hint" role="note">
                Allowing proposals does not allow STARK to apply them. File changes still require review and Accept.
              </p>
            )}
            {capability === 'attachment.import' && (
              <p className="session__hint" role="note">
                Allows AI to propose copying a chat attachment into the current project. Human review is still required before writing.
              </p>
            )}
            {capability === 'image.generate' && (
              <p className="session__hint" role="note">
                Allows AI to generate images using the configured AI provider. May use provider credits/API quota. Each generation needs your approval.
              </p>
            )}
            {capability === 'runtime.observe' && (
              <p className="session__hint" role="note">
                Allows the Worker to inspect the managed runtime&apos;s status and bounded stdout/stderr logs.
              </p>
            )}
            {capability === 'preview.inspect' && (
              <p className="session__hint" role="note">
                Allows the Worker to inspect bounded rendered content from STARK&apos;s local Live Preview. It does not allow clicking, typing, form submission, or DOM modification.
              </p>
            )}
          </div>
        ))}
      </div>
      <p className="session__hint" role="note">
        STARK must ask before each future action.
      </p>
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
      <p className="session__hint" role="note">
        Detailed permission controls will appear here as STARK integrations expand.
      </p>
    </section>
  )
}
