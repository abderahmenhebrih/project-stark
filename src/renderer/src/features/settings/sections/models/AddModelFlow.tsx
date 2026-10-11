import { useState, type ReactElement } from 'react'
import type { ProviderConnectionStatus } from '../../../../../../shared/providers/types'
import type { ProviderPanelState } from '../../../sessions/provider-state'

export type AddModelChoice = 'api-key' | 'local' | 'upgrade'

interface AddModelFlowProps {
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
  readonly onNavigateBilling: () => void
  readonly onClose: () => void
}

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

/**
 * In-page Add model surface. Exactly three primary choices — Add API
 * key, Link a local model, Upgrade your plan — then one sub-surface
 * at a time. The API-key path re-houses the reviewed OpenAI
 * provider/key/model functionality without behavior or security
 * changes (masked write-only input, explicit save/remove/test/
 * refresh/use, main-side storage). Local linking and hosted plans
 * are honest placeholders: no fake detection, no fake backends, no
 * pricing, no network calls. No IPC or network calls live here; every
 * action arrives via SessionPanel-owned callbacks.
 */
export function AddModelFlow(props: AddModelFlowProps): ReactElement {
  const [choice, setChoice] = useState<AddModelChoice | null>(null)
  const { provider } = props
  const selectedModel = provider.selectedModel

  return (
    <div className="models-addflow" aria-label="Add model">
      <div className="models-addflow__head">
        <p className="models-addflow__title">Add model</p>
        <button className="explorer__secondary" type="button" onClick={props.onClose} aria-label="Close add model">
          Close
        </button>
      </div>
      {choice === null ? (
        <div className="models-addflow__choices" role="group" aria-label="Add model options">
          <button
            className="models-choice"
            type="button"
            onClick={() => setChoice('api-key')}
            aria-label="Add API key"
          >
            <span className="models-choice__title">Add API key</span>
            <span className="models-choice__copy">Use a remote provider with your own key.</span>
          </button>
          <button
            className="models-choice"
            type="button"
            onClick={() => setChoice('local')}
            aria-label="Link a local model"
          >
            <span className="models-choice__title">Link a local model</span>
            <span className="models-choice__copy">Use a model running on this device.</span>
          </button>
          <button
            className="models-choice"
            type="button"
            onClick={() => setChoice('upgrade')}
            aria-label="Upgrade your plan"
          >
            <span className="models-choice__title">Upgrade your plan</span>
            <span className="models-choice__copy">Hosted models with a STARK plan.</span>
          </button>
        </div>
      ) : (
        <div className="models-addflow__panel">
          <button
            className="explorer__secondary"
            type="button"
            onClick={() => setChoice(null)}
            aria-label="Back to add model options"
          >
            Back
          </button>
          {choice === 'api-key' && (
            <section aria-label="Add API key">
              <p className="session__eyebrow">Provider</p>
              <div className="session__settings-row">
                <span className="session__provider-name">{provider.displayName}</span>
              </div>
              {!provider.secureStorageAvailable && (
                <p className="session__error" role="alert">
                  Secure credential storage is not available on this system.
                </p>
              )}
              <label className="session__eyebrow" htmlFor="settings-api-key">
                API key
              </label>
              <div className="session__settings-row">
                <input
                  id="settings-api-key"
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
              <p className="session__eyebrow">Connection</p>
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
              <p className="session__eyebrow">Available models</p>
              <div className="session__settings-row">
                <select
                  id="settings-model-select"
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
          {choice === 'local' && (
            <section aria-label="Link a local model">
              <p className="settings-section__title">Link a local model</p>
              <p className="settings-section__copy">
                Connect a model running on your computer to STARK.
              </p>
              <p className="session__hint" role="note">
                Local model linking is not available yet.
              </p>
            </section>
          )}
          {choice === 'upgrade' && (
            <section aria-label="Upgrade your plan">
              <p className="settings-section__title">Upgrade your plan</p>
              <p className="settings-section__copy">
                Additional hosted models will become available with STARK plans.
              </p>
              <div className="session__settings-row">
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={props.onNavigateBilling}
                  aria-label="View billing settings"
                >
                  View billing
                </button>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
