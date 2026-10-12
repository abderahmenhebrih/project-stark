import { useState, type ReactElement } from 'react'
import type { ProviderPanelState } from '../../sessions/provider-state'
import { canEnterChain, deriveModelLibrary, findLibraryModel } from './models/model-library'
import { ModelCard } from './models/ModelCard'
import { AddModelCard } from './models/AddModelCard'
import { AddModelFlow } from './models/AddModelFlow'
import { BrainChain } from './models/BrainChain'
import { HeartChain } from './models/HeartChain'
import './models/ModelsSettings.css'

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
  /** Disconnects the optional OpenAI BYOK provider (with confirmation). */
  readonly onDisconnect: () => void
  readonly onTestConnection: () => void
  readonly onRefreshModels: () => void
  readonly onUseModel: () => void
  readonly brain: readonly string[]
  readonly heart: readonly string[]
  /** Entitlement caps from the central product state (Free default 5). */
  readonly maxBrainModels?: number
  readonly maxHeartModels?: number
  /** Plan display name for LoopLink limit copy (defaults to STARK Free). */
  readonly planLabel?: string
  readonly onToggleModel: (chain: 'brain' | 'heart', stableId: string, enable: boolean) => void
  readonly onSwapModel: (chain: 'brain' | 'heart', outgoingId: string, incomingId: string) => void
  readonly onReorderModel: (chain: 'brain' | 'heart', stableId: string, toIndex: number) => void
  readonly onNavigateBilling: () => void
  /** Current STARK Free composer selection (stable builtin id). */
  readonly starkModel: string
  /** Selects a STARK Free model for the composer. */
  readonly onSelectStarkModel: (stableId: string) => void
}

/**
 * Settings → Models V2: visual Model Library (the 15 STARK Free
 * built-ins, then user-added, then the grid-native Add model card
 * with the in-page three-choice flow), then the side-by-side Brain
 * and Heart LoopLink rosters. No paid plan catalog is rendered yet —
 * the plan group below stays mounted but empty until Billing defines
 * the real Magma/Frost/Void entries.
 *
 * Each LoopLink shows the FULL eligible roster (enabled first in
 * active order, then available in catalog order) with Free-default
 * actives preconfigured. Toggles enable/disable, the grip drags
 * enabled rows, and the limit dialog offers switch-or-upgrade at the
 * entitlement cap.
 *
 * The library derives from the model catalog plus provider source
 * truth — never fake models. Discovered provider models populate the
 * Connected provider group automatically after a key is saved (no
 * manual model entry); only compatible models become runnable, and a
 * disappeared selection renders Unavailable instead of routing
 * silently. Locked plan entries stay out of the roster (with their
 * Billing upgrade route on the library cards); retained active ids
 * missing from the library render as Unavailable and are kept, so
 * removing a key never strands a dangling reference.
 * Roster order drives real runtime execution — STARK routes
 * inference through these LoopLinks in order (Brain chain for
 * Brain-owned phases, Heart chain for Worker phases) with bounded
 * failover. Chain snapshots travel with each AI request;
 * renderer/session-local and resets on workspace switch (schema
 * stays v19).
 */
export function ModelsSettings(props: ModelsSettingsProps): ReactElement {
  const [addOpen, setAddOpen] = useState(false)
  const [confirmDisconnectOpen, setConfirmDisconnectOpen] = useState(false)
  const library = deriveModelLibrary(props.provider)
  const builtIn = library.filter((entry) => entry.origin === 'built-in')
  const userModels = library.filter((entry) => entry.origin === 'api' || entry.origin === 'local')
  const planModels = library.filter((entry) => entry.origin === 'plan')

  function handleToggle(chain: 'brain' | 'heart', stableId: string, enable: boolean): void {
    if (!enable) {
      props.onToggleModel(chain, stableId, false)
      return
    }
    const entry = findLibraryModel(library, stableId)
    if (entry === undefined || !canEnterChain(entry)) {
      return
    }
    props.onToggleModel(chain, stableId, true)
  }

  return (
    <section aria-label="Models" className="models-page">
      <p className="settings-section__title">Models</p>
      <p className="settings-section__copy">Model library, Brain Chain and Heart Chain configuration.</p>
      <div className="models-library__head">
        <p className="session__eyebrow">Model Library</p>
        {library.length === 0 ? (
          <p className="models-empty" role="note">
            No models added yet.
          </p>
        ) : null}
      </div>
      <div className="models-grid" aria-label="Model library">
        {builtIn.length > 0 ? <p className="models-grid__label">STARK Free</p> : null}
        {builtIn.map((entry) => (
          <ModelCard
            key={entry.stableId}
            model={entry}
            selected={entry.stableId === props.starkModel}
            onSelect={() => props.onSelectStarkModel(entry.stableId)}
          />
        ))}
        {userModels.length > 0 || props.provider.configured ? (
          <p className="models-grid__label">Connected providers · {props.provider.displayName}</p>
        ) : null}
        {userModels.map((entry) => (
          <ModelCard key={entry.stableId} model={entry} />
        ))}
        {props.provider.configured && userModels.length === 0 ? (
          <div className="models-grid__discovery" role="status" aria-label="Provider model discovery">
            <p className="models-grid__discovery-copy">
              {props.provider.modelsError !== null
                ? 'Could not load models. Your saved key is kept.'
                : props.provider.loadingModels
                  ? 'Loading models…'
                  : 'No compatible models found for this provider.'}
            </p>
            <button
              className="explorer__secondary"
              type="button"
              onClick={props.onRefreshModels}
              disabled={props.provider.loadingModels}
            >
              {props.provider.loadingModels ? 'Loading…' : 'Retry'}
            </button>
          </div>
        ) : null}
        {planModels.length > 0 ? <p className="models-grid__label">Available with STARK plans</p> : null}
        {planModels.map((entry) => (
          <ModelCard key={entry.stableId} model={entry} onUpgrade={props.onNavigateBilling} />
        ))}
        <AddModelCard onOpen={() => setAddOpen(true)} />
      </div>
      {props.provider.configured ? (
        <div className="session__settings-row" role="status" aria-label="OpenAI connection">
          <span className="session__hint" role="note">
            OpenAI · Connected
          </span>
          <button
            className="explorer__secondary"
            type="button"
            onClick={props.onRefreshModels}
            disabled={props.provider.loadingModels}
            aria-label="Refresh OpenAI models"
          >
            {props.provider.loadingModels ? 'Loading…' : 'Refresh models'}
          </button>
          <button
            className="explorer__secondary"
            type="button"
            onClick={() => setConfirmDisconnectOpen(true)}
            aria-label="Disconnect OpenAI"
          >
            Disconnect
          </button>
        </div>
      ) : null}
      {confirmDisconnectOpen ? (
        <div
          className="session__confirm"
          role="alertdialog"
          aria-label="Disconnect OpenAI?"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setConfirmDisconnectOpen(false)
            }
          }}
        >
          <p className="session__confirm-title">Disconnect OpenAI?</p>
          <p className="session__confirm-copy">
            Your saved OpenAI API key and discovered OpenAI models will be removed from this device. STARK Free
            models will remain available.
          </p>
          <div className="session__confirm-actions">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => setConfirmDisconnectOpen(false)}
            >
              Cancel
            </button>
            <button
              className="explorer__primary"
              type="button"
              onClick={() => {
                setConfirmDisconnectOpen(false)
                props.onDisconnect()
              }}
              aria-label="Confirm disconnect OpenAI"
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : null}
      {addOpen ? (
        <AddModelFlow
          provider={props.provider}
          apiKeyInput={props.apiKeyInput}
          onApiKeyInputChange={props.onApiKeyInputChange}
          revealKey={props.revealKey}
          onToggleRevealKey={props.onToggleRevealKey}
          modelValue={props.modelValue}
          selectedModelMissing={props.selectedModelMissing}
          useModelDisabled={props.useModelDisabled}
          onModelDraftChange={props.onModelDraftChange}
          onSaveKey={props.onSaveKey}
          onRemoveKey={props.onRemoveKey}
          onTestConnection={props.onTestConnection}
          onRefreshModels={props.onRefreshModels}
          onUseModel={props.onUseModel}
          onNavigateBilling={props.onNavigateBilling}
          onClose={() => setAddOpen(false)}
        />
      ) : null}
      <div className="models-looplinks">
        <BrainChain
          chain={props.brain}
          library={library}
          maxModels={props.maxBrainModels}
          planLabel={props.planLabel}
          onToggle={(stableId, enable) => handleToggle('brain', stableId, enable)}
          onSwap={(outgoingId, incomingId) => props.onSwapModel('brain', outgoingId, incomingId)}
          onReorder={(stableId, toIndex) => props.onReorderModel('brain', stableId, toIndex)}
          onNavigateBilling={props.onNavigateBilling}
        />
        <HeartChain
          chain={props.heart}
          library={library}
          maxModels={props.maxHeartModels}
          planLabel={props.planLabel}
          onToggle={(stableId, enable) => handleToggle('heart', stableId, enable)}
          onSwap={(outgoingId, incomingId) => props.onSwapModel('heart', outgoingId, incomingId)}
          onReorder={(stableId, toIndex) => props.onReorderModel('heart', stableId, toIndex)}
          onNavigateBilling={props.onNavigateBilling}
        />
      </div>
      <p className="session__hint" role="note">
        Routing active · models are tried in order.
      </p>
    </section>
  )
}
