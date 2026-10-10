import type { ReactElement } from 'react'
import type { ProviderConnectionStatus } from '../../../../../shared/providers/types'
import type { ProviderPanelState } from '../../sessions/provider-state'

interface ModelsSettingsProps {
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
 * Settings → Models: the existing provider/key/model configuration,
 * re-housed from the old modal without backend or behavior changes.
 * One provider subsection per configured provider (today: the single
 * configured provider), so multi-provider UI can extend this shape.
 */
export function ModelsSettings(props: ModelsSettingsProps): ReactElement {
  const { provider } = props
  const selectedModel = provider.selectedModel
  return (
    <section aria-label="Models">
      <p className="settings-section__title">Models</p>
      <p className="settings-section__copy">Configure the AI providers and models STARK can use.</p>
      <div className="settings-provider">
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
      </div>
    </section>
  )
}
