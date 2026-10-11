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
 * truth — never fake models. Locked plan entries stay out of the
 * roster (with their Billing upgrade route on the library cards);
 * retained active ids missing from the library render as Unavailable
 * and are kept, so removing a key never strands a dangling reference.
 * Roster order is configuration for the upcoming AI integration
 * pass — STARK does not route inference through these LoopLinks yet.
 * No IPC, no network, no storage calls live here; chain state is
 * renderer/session-local and resets on workspace switch (schema
 * stays v19).
 */
export function ModelsSettings(props: ModelsSettingsProps): ReactElement {
  const [addOpen, setAddOpen] = useState(false)
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
        {builtIn.length > 0 ? <p className="models-grid__label">Included with STARK Free</p> : null}
        {builtIn.map((entry) => (
          <ModelCard key={entry.stableId} model={entry} />
        ))}
        {userModels.length > 0 ? <p className="models-grid__label">Your models</p> : null}
        {userModels.map((entry) => (
          <ModelCard key={entry.stableId} model={entry} />
        ))}
        {planModels.length > 0 ? <p className="models-grid__label">Available with STARK plans</p> : null}
        {planModels.map((entry) => (
          <ModelCard key={entry.stableId} model={entry} onUpgrade={props.onNavigateBilling} />
        ))}
        <AddModelCard onOpen={() => setAddOpen(true)} />
      </div>
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
        LoopLinks configure order for the upcoming AI integration. STARK does not route inference through them yet.
      </p>
    </section>
  )
}
