import { useEffect, useRef, type Dispatch, type ReactElement } from 'react'
import type { ProviderConnectionStatus } from '../../../../shared/providers/types'
import { useApp } from '../../app/app-context'
import { StarkIcon } from '../../components/icons/StarkIcon'
import { AccountSection } from '../account/AccountSection'
import { ProfileSection } from '../profile/ProfileSection'
import { CAPABILITY_ORDER, capabilityLabel, legalModesFor, type CapabilityPanelAction, type CapabilityPanelState } from './capabilities-state'
import { USAGE_ROUTE_KEYS, formatUsageThreshold, usageRouteLabel, type UsagePanelAction, type UsagePanelState } from './usage-state'
import { type HeartPanelAction, type HeartPanelState } from './heart-state'
import { type RecoveryPanelAction, type RecoveryPanelState } from './recovery-state'
import type { ProviderPanelState } from './provider-state'
import './StarkSettingsSurface.css'

export type SettingsSection = 'ai' | 'heart' | 'recovery' | 'permissions' | 'usage' | 'account' | 'profile'

const SECTIONS: readonly { readonly kind: SettingsSection; readonly label: string }[] = [
  { kind: 'ai', label: 'AI & Models' },
  { kind: 'heart', label: 'Heart' },
  { kind: 'recovery', label: 'Recovery' },
  { kind: 'permissions', label: 'Permissions' },
  { kind: 'usage', label: 'Usage' },
  { kind: 'account', label: 'Account' },
  { kind: 'profile', label: 'Profile' }
]

function connectionStatusLabel(status: ProviderConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected.'
    case 'invalid-credential':
      return 'The saved API key was rejected. Check the key and try again.'
    case 'rate-limited':
      return 'The AI provider is rate-limiting requests. Try again shortly.'
    case 'network-error':
      return 'The AI provider could not be reached. Check your connection.'
    case 'timeout':
      return 'The AI provider request timed out. Try again.'
    default:
      return 'The AI provider status is unknown.'
  }
}

interface StarkSettingsSurfaceProps {
  readonly workspaceId: number
  readonly section: SettingsSection
  readonly onSectionChange: (section: SettingsSection) => void
  readonly onClose: () => void
  readonly provider: ProviderPanelState
  readonly apiKeyInput: string
  readonly onApiKeyInputChange: (value: string) => void
  readonly revealKey: boolean
  readonly onToggleRevealKey: () => void
  readonly modelValue: string
  readonly selectedModelMissing: boolean
  readonly useModelDisabled: boolean
  readonly onModelDraftChange: (value: string) => void
  readonly onSaveKey: () => void
  readonly onRemoveKey: () => void
  readonly onTestConnection: () => void
  readonly onRefreshModels: () => void
  readonly onUseModel: () => void
  readonly heart: HeartPanelState
  readonly heartDispatch: Dispatch<HeartPanelAction>
  readonly onSaveHeart: () => void
  readonly recovery: RecoveryPanelState
  readonly recoveryDispatch: Dispatch<RecoveryPanelAction>
  readonly onSaveRecovery: () => void
  readonly usage: UsagePanelState
  readonly usageDispatch: Dispatch<UsagePanelAction>
  readonly onRefreshUsageSummary: () => void
  readonly onSaveUsage: () => void
  readonly capabilities: CapabilityPanelState
  readonly capabilitiesDispatch: Dispatch<CapabilityPanelAction>
  readonly onSaveCapabilities: () => void
}

/**
 * Dedicated settings surface (renderer-only modal). All config state
 * and save handlers stay owned by SessionPanel — this component is
 * presentation only. Account reuses the existing AccountSection;
 * Profile reuses the existing ProfileSection via the app store.
 */
export function StarkSettingsSurface(props: StarkSettingsSurfaceProps): ReactElement {
  const { workspaceId, section, onSectionChange, onClose } = props
  const { provider, heart, recovery, usage, capabilities } = props
  const { profile, refreshProfile } = useApp()
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [onClose])

  const selectedModel = provider.selectedModel

  return (
    <div className="stark-settings-overlay" role="presentation">
      <div className="stark-settings" role="dialog" aria-modal="true" aria-label="STARK settings">
        <div className="stark-settings__head">
          <p className="stark-settings__title">Settings</p>
          <button
            ref={closeRef}
            className="stark-settings__close"
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close settings"
          >
            <StarkIcon name="close" size={16} />
          </button>
        </div>
        <div className="stark-settings__body">
          <nav className="stark-settings__nav" aria-label="Settings sections">
            {SECTIONS.map((entry) => (
              <button
                key={entry.kind}
                className={
                  section === entry.kind ? 'stark-settings__nav-item stark-settings__nav-item--active' : 'stark-settings__nav-item'
                }
                type="button"
                aria-current={section === entry.kind}
                onClick={() => onSectionChange(entry.kind)}
              >
                {entry.label}
              </button>
            ))}
          </nav>
          <div className="stark-settings__content">
            {section === 'ai' && (
              <section aria-label="AI and models">
                <div className="session__settings-row">
                  <span className="session__eyebrow">Provider</span>
                  <span className="session__provider-name">{provider.displayName}</span>
                </div>
                {!provider.secureStorageAvailable && (
                  <p className="session__error" role="alert">
                    Secure credential storage is not available on this system.
                  </p>
                )}
                <label className="session__eyebrow" htmlFor="session-api-key">
                  API key
                </label>
                <div className="session__settings-row">
                  <input
                    id="session-api-key"
                    className="session__field"
                    type={props.revealKey ? 'text' : 'password'}
                    value={props.apiKeyInput}
                    onChange={(event) => props.onApiKeyInputChange(event.target.value)}
                    placeholder="Paste OpenAI API key…"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="OpenAI API key"
                  />
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={props.onToggleRevealKey}
                    aria-label={props.revealKey ? 'Hide typed key' : 'Reveal typed key'}
                  >
                    {props.revealKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <div className="session__settings-row">
                  <button
                    className="explorer__primary"
                    type="button"
                    onClick={props.onSaveKey}
                    disabled={props.apiKeyInput.trim() === '' || !provider.secureStorageAvailable}
                  >
                    Save key
                  </button>
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={props.onRemoveKey}
                    disabled={!provider.configured}
                  >
                    Remove key
                  </button>
                  <span className="session__hint">{provider.configured ? 'Configured' : 'Not configured'}</span>
                </div>
                {provider.error !== null && (
                  <p className="session__error" role="alert">
                    {provider.error}
                  </p>
                )}
                <div className="session__settings-row">
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={props.onTestConnection}
                    disabled={!provider.configured || provider.connectionPhase === 'testing'}
                  >
                    {provider.connectionPhase === 'testing' ? 'Testing…' : 'Test connection'}
                  </button>
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={props.onRefreshModels}
                    disabled={!provider.configured || provider.loadingModels}
                  >
                    {provider.loadingModels ? 'Loading…' : 'Refresh models'}
                  </button>
                </div>
                {provider.connectionPhase === 'done' && provider.connectionStatus !== null && (
                  <p className="session__status" role="status">
                    Connection: {connectionStatusLabel(provider.connectionStatus)}
                  </p>
                )}
                {provider.connectionPhase === 'error' && provider.connectionError !== null && (
                  <p className="session__error" role="alert">
                    {provider.connectionError}
                  </p>
                )}
                <label className="session__eyebrow" htmlFor="session-model-select">
                  Model
                </label>
                <div className="session__settings-row">
                  <select
                    id="session-model-select"
                    className="session__select"
                    value={props.modelValue}
                    onChange={(event) => props.onModelDraftChange(event.target.value)}
                    disabled={!provider.configured || (provider.models.length === 0 && provider.selectedModel === null)}
                    aria-label="Available models"
                  >
                    {props.modelValue === '' && <option value="">Select a model…</option>}
                    {props.selectedModelMissing && selectedModel !== null ? (
                      <option key={selectedModel} value={selectedModel}>
                        {selectedModel}
                      </option>
                    ) : null}
                    {provider.models.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.id}
                      </option>
                    ))}
                  </select>
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={props.onUseModel}
                    disabled={props.useModelDisabled}
                  >
                    Use model
                  </button>
                </div>
                {provider.modelsError !== null && (
                  <p className="session__error" role="alert">
                    {provider.modelsError}
                  </p>
                )}
              </section>
            )}
            {section === 'heart' && (
              <section aria-label="Heart routing">
                <div className="session__settings-row">
                  <span className="session__eyebrow">Heart routing</span>
                  <span className="session__hint">
                    {heart.config === null ? 'Not configured' : heart.config.workerMode === 'fixed' ? 'Fixed' : 'Auto-Swap'}
                  </span>
                </div>
                <p className="session__eyebrow">Brain model</p>
                <div className="session__settings-row">
                  <select
                    className="session__select"
                    value={heart.draft.brain.providerId}
                    onChange={(event) =>
                      props.heartDispatch({
                        type: 'draft-edited',
                        workspaceId,
                        field: { scope: 'brain' },
                        providerId: event.target.value,
                        model: heart.draft.brain.model
                      })
                    }
                    aria-label="Brain provider"
                  >
                    <option value="openai">openai</option>
                  </select>
                  <input
                    className="session__field"
                    value={heart.draft.brain.model}
                    onChange={(event) =>
                      props.heartDispatch({
                        type: 'draft-edited',
                        workspaceId,
                        field: { scope: 'brain' },
                        providerId: heart.draft.brain.providerId,
                        model: event.target.value
                      })
                    }
                    placeholder="Brain model…"
                    aria-label="Brain model"
                    list="heart-model-options"
                  />
                </div>
                <div className="session__composer-row" role="group" aria-label="Worker routing mode">
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => props.heartDispatch({ type: 'mode-selected', workspaceId, mode: 'fixed' })}
                    aria-pressed={heart.draft.workerMode === 'fixed'}
                  >
                    Fixed
                  </button>
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => props.heartDispatch({ type: 'mode-selected', workspaceId, mode: 'auto_swap' })}
                    aria-pressed={heart.draft.workerMode === 'auto_swap'}
                  >
                    Auto-Swap
                  </button>
                </div>
                <p className="session__hint" role="note">
                  Auto-Swap lets STARK Brain request a task profile. Heart maps that profile to one of your configured
                  models. It does not retry failed models automatically.
                </p>
                {heart.draft.workerMode === 'fixed' ? (
                  <>
                    <p className="session__eyebrow">Worker model (Fixed)</p>
                    <div className="session__settings-row">
                      <select
                        className="session__select"
                        value={heart.draft.workerFixed.providerId}
                        onChange={(event) =>
                          props.heartDispatch({
                            type: 'draft-edited',
                            workspaceId,
                            field: { scope: 'workerFixed' },
                            providerId: event.target.value,
                            model: heart.draft.workerFixed.model
                          })
                        }
                        aria-label="Fixed worker provider"
                      >
                        <option value="openai">openai</option>
                      </select>
                      <input
                        className="session__field"
                        value={heart.draft.workerFixed.model}
                        onChange={(event) =>
                          props.heartDispatch({
                            type: 'draft-edited',
                            workspaceId,
                            field: { scope: 'workerFixed' },
                            providerId: heart.draft.workerFixed.providerId,
                            model: event.target.value
                          })
                        }
                        placeholder="Worker model…"
                        aria-label="Fixed worker model"
                        list="heart-model-options"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <p className="session__eyebrow">Default Worker model</p>
                    <div className="session__settings-row">
                      <select
                        className="session__select"
                        value={heart.draft.workerDefault.providerId}
                        onChange={(event) =>
                          props.heartDispatch({
                            type: 'draft-edited',
                            workspaceId,
                            field: { scope: 'workerDefault' },
                            providerId: event.target.value,
                            model: heart.draft.workerDefault.model
                          })
                        }
                        aria-label="Default worker provider"
                      >
                        <option value="openai">openai</option>
                      </select>
                      <input
                        className="session__field"
                        value={heart.draft.workerDefault.model}
                        onChange={(event) =>
                          props.heartDispatch({
                            type: 'draft-edited',
                            workspaceId,
                            field: { scope: 'workerDefault' },
                            providerId: heart.draft.workerDefault.providerId,
                            model: event.target.value
                          })
                        }
                        placeholder="Default worker model…"
                        aria-label="Default worker model"
                        list="heart-model-options"
                      />
                    </div>
                    {(Object.keys(heart.draft.workerRoutes) as ('general' | 'coding' | 'reasoning' | 'fast')[]).map(
                      (profile) => (
                        <div key={profile}>
                          <p className="session__eyebrow">{profile[0]?.toUpperCase() + profile.slice(1)} override (optional)</p>
                          <div className="session__settings-row">
                            <select
                              className="session__select"
                              value={heart.draft.workerRoutes[profile].providerId}
                              onChange={(event) =>
                                props.heartDispatch({
                                  type: 'draft-edited',
                                  workspaceId,
                                  field: { scope: 'route', profile },
                                  providerId: event.target.value,
                                  model: heart.draft.workerRoutes[profile].model
                                })
                              }
                              aria-label={`${profile} worker provider`}
                            >
                              <option value="openai">openai</option>
                            </select>
                            <input
                              className="session__field"
                              value={heart.draft.workerRoutes[profile].model}
                              onChange={(event) =>
                                props.heartDispatch({
                                  type: 'draft-edited',
                                  workspaceId,
                                  field: { scope: 'route', profile },
                                  providerId: heart.draft.workerRoutes[profile].providerId,
                                  model: event.target.value
                                })
                              }
                              placeholder={`${profile} model… (optional)`}
                              aria-label={`${profile} worker model`}
                              list="heart-model-options"
                            />
                          </div>
                        </div>
                      )
                    )}
                  </>
                )}
                <datalist id="heart-model-options">
                  {provider.models.map((entry) => (
                    <option key={entry.id} value={entry.id} />
                  ))}
                </datalist>
                {heart.loading && (
                  <p className="session__status" role="status">
                    Loading Heart…
                  </p>
                )}
                {heart.loadError !== null && (
                  <p className="session__error" role="alert">
                    {heart.loadError}
                  </p>
                )}
                {heart.saveError !== null && (
                  <p className="session__error" role="alert">
                    {heart.saveError}
                  </p>
                )}
                {heart.notice !== null && (
                  <p className="session__status" role="status">
                    {heart.notice}
                  </p>
                )}
                <div className="session__settings-row">
                  <button
                    className="explorer__primary"
                    type="button"
                    onClick={props.onSaveHeart}
                    disabled={heart.saving}
                  >
                    {heart.saving ? 'Saving…' : 'Save Heart'}
                  </button>
                </div>
              </section>
            )}
            {section === 'recovery' && (
              <section aria-label="Continuity recovery">
                <div className="session__settings-row">
                  <span className="session__eyebrow">Continuity Recovery</span>
                </div>
                <div className="session__composer-row" role="group" aria-label="Continuity recovery mode">
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => props.recoveryDispatch({ type: 'mode-selected', workspaceId, mode: 'off' })}
                    aria-pressed={recovery.draft.mode === 'off'}
                  >
                    Off
                  </button>
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => props.recoveryDispatch({ type: 'mode-selected', workspaceId, mode: 'handoff' })}
                    aria-pressed={recovery.draft.mode === 'handoff'}
                  >
                    Handoff only
                  </button>
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => props.recoveryDispatch({ type: 'mode-selected', workspaceId, mode: 'auto_once' })}
                    aria-pressed={recovery.draft.mode === 'auto_once'}
                  >
                    Auto once
                  </button>
                </div>
                <p className="session__hint" role="note">
                  {recovery.draft.mode === 'handoff'
                    ? 'Create a Looplink recovery session after a recoverable provider failure, but do not call another model automatically.'
                    : recovery.draft.mode === 'auto_once'
                      ? 'Create one Looplink recovery session and make one attempt using your Recovery models. STARK will not retry or create another automatic handoff if that attempt fails.'
                      : 'Recovery is off. Provider failures surface normally.'}
                </p>
                {(['ask', 'brain', 'worker'] as const).map((scope) => (
                  <div key={scope}>
                    <p className="session__eyebrow">
                      {scope === 'ask' ? 'Ask Recovery' : scope === 'brain' ? 'Brain Recovery' : 'Worker Recovery'}
                    </p>
                    <div className="session__settings-row">
                      <select
                        className="session__select"
                        value={recovery.draft[scope].providerId}
                        onChange={(event) =>
                          props.recoveryDispatch({
                            type: 'draft-edited',
                            workspaceId,
                            field: { scope },
                            providerId: event.target.value,
                            model: recovery.draft[scope].model
                          })
                        }
                        aria-label={`${scope} recovery provider`}
                      >
                        <option value="openai">openai</option>
                      </select>
                      <input
                        className="session__field"
                        value={recovery.draft[scope].model}
                        onChange={(event) =>
                          props.recoveryDispatch({
                            type: 'draft-edited',
                            workspaceId,
                            field: { scope },
                            providerId: recovery.draft[scope].providerId,
                            model: event.target.value
                          })
                        }
                        placeholder={`${scope} recovery model…`}
                        aria-label={`${scope} recovery model`}
                        list="recovery-model-options"
                      />
                    </div>
                  </div>
                ))}
                <datalist id="recovery-model-options">
                  {provider.models.map((entry) => (
                    <option key={entry.id} value={entry.id} />
                  ))}
                </datalist>
                {recovery.loading && (
                  <p className="session__status" role="status">
                    Loading recovery…
                  </p>
                )}
                {recovery.loadError !== null && (
                  <p className="session__error" role="alert">
                    {recovery.loadError}
                  </p>
                )}
                {recovery.saveError !== null && (
                  <p className="session__error" role="alert">
                    {recovery.saveError}
                  </p>
                )}
                {recovery.notice !== null && (
                  <p className="session__status" role="status">
                    {recovery.notice}
                  </p>
                )}
                <div className="session__settings-row">
                  <button
                    className="explorer__primary"
                    type="button"
                    onClick={props.onSaveRecovery}
                    disabled={recovery.saving}
                  >
                    {recovery.saving ? 'Saving…' : 'Save Recovery'}
                  </button>
                </div>
              </section>
            )}
            {section === 'permissions' && (
              <section aria-label="Agent permissions">
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
              </section>
            )}
            {section === 'usage' && (
              <section aria-label="Usage and threshold routing">
                <div className="session__settings-row">
                  <span className="session__eyebrow">Usage &amp; Threshold Routing</span>
                  <span className="session__hint">{usage.draft.thresholdRoutingEnabled ? 'On' : 'Off'}</span>
                </div>
                <p className="session__hint" role="note">
                  STARK tracks only provider calls made by STARK. It does not query provider billing or quota APIs and
                  cannot see usage generated outside STARK.
                </p>
                <p className="session__hint" role="note">
                  Token counts are shown only when the provider reports them.
                </p>
                <div className="session__composer-row" role="group" aria-label="Threshold routing">
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => props.usageDispatch({ type: 'routing-toggled', workspaceId, enabled: false })}
                    aria-pressed={!usage.draft.thresholdRoutingEnabled}
                  >
                    Off
                  </button>
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => props.usageDispatch({ type: 'routing-toggled', workspaceId, enabled: true })}
                    aria-pressed={usage.draft.thresholdRoutingEnabled}
                  >
                    On
                  </button>
                </div>
                <p className="session__hint" role="note">
                  When a base Heart model reaches your local routing threshold, STARK may use the configured alternate
                  before making the provider call.
                </p>
                <p className="session__hint" role="note">
                  This does not retry failed models and is not a provider quota guarantee.
                </p>
                <p className="session__hint" role="note">
                  If no alternate is configured, STARK continues using the normal Heart route.
                </p>
                <div className="session__settings-row">
                  <span className="session__eyebrow">Local usage — last 24 hours</span>
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={props.onRefreshUsageSummary}
                    disabled={usage.summaryLoading}
                    aria-label="Refresh usage"
                  >
                    {usage.summaryLoading ? 'Refreshing…' : 'Refresh usage'}
                  </button>
                </div>
                {usage.summary !== null && (
                  <ul className="session__context-list" aria-label="Local usage summary">
                    {usage.summary.models.map((entry) => (
                      <li key={`${entry.providerId}/${entry.model}`}>
                        <p className="session__hint" role="note">
                          {entry.providerId} / {entry.model} · {entry.calls24h} calls ·{' '}
                          {entry.tokenTelemetryComplete && entry.totalTokens24h !== null
                            ? `${entry.totalTokens24h} tokens`
                            : 'Token telemetry incomplete'}{' '}
                          · {entry.rateLimitFailures24h} rate-limit failures · {formatUsageThreshold(entry)} ·{' '}
                          {entry.thresholdReached ? 'Threshold reached' : 'Below threshold'}
                        </p>
                        {!entry.tokenTelemetryComplete && (
                          <p className="session__hint" role="note">
                            Token threshold cannot be evaluated completely because this provider/model did not report token
                            usage for every observed call.
                          </p>
                        )}
                      </li>
                    ))}
                    {usage.summary.truncated && (
                      <li>
                        <p className="session__hint" role="note">
                          Showing the first {usage.summary.models.length} provider/model rows.
                        </p>
                      </li>
                    )}
                  </ul>
                )}
                {usage.summaryError !== null && (
                  <p className="session__error" role="alert">
                    {usage.summaryError}
                  </p>
                )}
                <div className="session__settings-row">
                  <span className="session__eyebrow">Local routing thresholds</span>
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => props.usageDispatch({ type: 'limit-added', workspaceId })}
                    aria-label="Add usage limit"
                  >
                    Add limit
                  </button>
                </div>
                {usage.draft.limits.map((entry, index) => (
                  <div key={index}>
                    <div className="session__settings-row">
                      <select
                        className="session__select"
                        value={entry.providerId}
                        onChange={(event) =>
                          props.usageDispatch({
                            type: 'limit-edited',
                            workspaceId,
                            index,
                            limit: { ...entry, providerId: event.target.value }
                          })
                        }
                        aria-label={`Usage limit ${index + 1} provider`}
                      >
                        <option value="openai">openai</option>
                      </select>
                      <input
                        className="session__field"
                        value={entry.model}
                        onChange={(event) =>
                          props.usageDispatch({
                            type: 'limit-edited',
                            workspaceId,
                            index,
                            limit: { ...entry, model: event.target.value }
                          })
                        }
                        placeholder="Model…"
                        aria-label={`Usage limit ${index + 1} model`}
                        list="usage-model-options"
                      />
                      <button
                        className="explorer__secondary"
                        type="button"
                        onClick={() => props.usageDispatch({ type: 'limit-removed', workspaceId, index })}
                        aria-label={`Remove usage limit ${index + 1}`}
                      >
                        Remove
                      </button>
                    </div>
                    <div className="session__settings-row">
                      <input
                        className="session__field"
                        value={entry.maxCalls}
                        onChange={(event) =>
                          props.usageDispatch({
                            type: 'limit-edited',
                            workspaceId,
                            index,
                            limit: { ...entry, maxCalls: event.target.value }
                          })
                        }
                        placeholder="Max STARK calls / 24h…"
                        aria-label={`Usage limit ${index + 1} max calls`}
                      />
                      <input
                        className="session__field"
                        value={entry.maxTokens}
                        onChange={(event) =>
                          props.usageDispatch({
                            type: 'limit-edited',
                            workspaceId,
                            index,
                            limit: { ...entry, maxTokens: event.target.value }
                          })
                        }
                        placeholder="Max reported tokens / 24h…"
                        aria-label={`Usage limit ${index + 1} max tokens`}
                      />
                      <input
                        className="session__field"
                        value={entry.switchAt}
                        onChange={(event) =>
                          props.usageDispatch({
                            type: 'limit-edited',
                            workspaceId,
                            index,
                            limit: { ...entry, switchAt: event.target.value }
                          })
                        }
                        placeholder="Switch at %…"
                        aria-label={`Usage limit ${index + 1} switch percent`}
                      />
                    </div>
                  </div>
                ))}
                <div className="session__settings-row">
                  <span className="session__eyebrow">Threshold alternates</span>
                </div>
                {USAGE_ROUTE_KEYS.map((routeKey) => (
                  <div key={routeKey}>
                    <p className="session__eyebrow">{usageRouteLabel(routeKey)}</p>
                    <div className="session__settings-row">
                      <select
                        className="session__select"
                        value={usage.draft.alternates[routeKey].providerId}
                        onChange={(event) =>
                          props.usageDispatch({
                            type: 'alternate-edited',
                            workspaceId,
                            routeKey,
                            alternate: { ...usage.draft.alternates[routeKey], providerId: event.target.value }
                          })
                        }
                        aria-label={`${usageRouteLabel(routeKey)} alternate provider`}
                      >
                        <option value="openai">openai</option>
                      </select>
                      <input
                        className="session__field"
                        value={usage.draft.alternates[routeKey].model}
                        onChange={(event) =>
                          props.usageDispatch({
                            type: 'alternate-edited',
                            workspaceId,
                            routeKey,
                            alternate: { ...usage.draft.alternates[routeKey], model: event.target.value }
                          })
                        }
                        placeholder={`${usageRouteLabel(routeKey)} alternate model…`}
                        aria-label={`${usageRouteLabel(routeKey)} alternate model`}
                        list="usage-model-options"
                      />
                    </div>
                  </div>
                ))}
                <datalist id="usage-model-options">
                  {provider.models.map((entry) => (
                    <option key={entry.id} value={entry.id} />
                  ))}
                </datalist>
                {usage.loading && (
                  <p className="session__status" role="status">
                    Loading usage…
                  </p>
                )}
                {usage.loadError !== null && (
                  <p className="session__error" role="alert">
                    {usage.loadError}
                  </p>
                )}
                {usage.saveError !== null && (
                  <p className="session__error" role="alert">
                    {usage.saveError}
                  </p>
                )}
                {usage.notice !== null && (
                  <p className="session__status" role="status">
                    {usage.notice}
                  </p>
                )}
                <div className="session__settings-row">
                  <button
                    className="explorer__primary"
                    type="button"
                    onClick={props.onSaveUsage}
                    disabled={usage.saving}
                  >
                    {usage.saving ? 'Saving…' : 'Save usage routing'}
                  </button>
                </div>
              </section>
            )}
            {section === 'account' && (
              <div className="stark-settings__account">
                <AccountSection />
              </div>
            )}
            {section === 'profile' && (
              <div className="stark-settings__profile">
                <ProfileSection current={profile} onChanged={() => void refreshProfile()} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
