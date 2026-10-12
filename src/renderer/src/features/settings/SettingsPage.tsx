import { useEffect, useRef, type Dispatch, type ReactElement } from 'react'
import type { HeartPanelAction, HeartPanelState } from '../sessions/heart-state'
import type { RecoveryPanelAction, RecoveryPanelState } from '../sessions/recovery-state'
import type { UsagePanelAction, UsagePanelState } from '../sessions/usage-state'
import type { CapabilityPanelAction, CapabilityPanelState } from '../sessions/capabilities-state'
import type { ProviderPanelState } from '../sessions/provider-state'
import type { SettingsSection } from './settings-section'
import { SettingsNav } from './SettingsNav'
import { ModelsSettings } from './sections/ModelsSettings'
import { PermissionsSettings } from './sections/PermissionsSettings'
import { AccountSettings } from './sections/AccountSettings'
import { BillingSettings } from './sections/BillingSettings'
import { StylesSettings } from './sections/StylesSettings'
import { AboutSettings } from './sections/AboutSettings'
import { UiIcon } from '../../components/icons/UiIcon'
import './SettingsPage.css'

export interface SettingsPageBinding {
  readonly workspaceId: number
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
  /**
   * Renderer-local Brain/Heart LoopLink chain configuration (stable
   * model ids only, session-local, workspace-scoped). Owned by
   * SessionPanel like every other panel state; no persistence, no IPC.
   */
  readonly brainChain: readonly string[]
  readonly heartChain: readonly string[]
  /** Entitlement caps from the central product state (Free default 5). */
  readonly maxBrainModels: number
  readonly maxHeartModels: number
  /** Plan display name for LoopLink limit copy (defaults to STARK Free). */
  readonly planLabel: string
  readonly onToggleModel: (chain: 'brain' | 'heart', stableId: string, enable: boolean) => void
  readonly onSwapModel: (chain: 'brain' | 'heart', outgoingId: string, incomingId: string) => void
  readonly onReorderModel: (chain: 'brain' | 'heart', stableId: string, toIndex: number) => void
  readonly capabilities: CapabilityPanelState
  readonly capabilitiesDispatch: Dispatch<CapabilityPanelAction>
  readonly onSaveCapabilities: () => void
  /**
   * Reserved: Heart/Recovery/Usage have no Settings V2 nav home, but
   * their reducers, loaders, APIs, and main-side runtime flows stay
   * intact for the future AI integration pass. Carried (not read) so
   * SessionPanel ownership stays behavior-identical.
   */
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
}

interface SettingsPageProps {
  readonly section: SettingsSection
  readonly onSectionChange: (section: SettingsSection) => void
  readonly onBack: () => void
  readonly binding: SettingsPageBinding
}

/**
 * Settings V2 full-page surface. Rendered into the workarea settings
 * host (NOT a modal, NOT a drawer): no overlay, no backdrop, no
 * dialog role. Pure presentation over SessionPanel-owned state —
 * opening it mounts nothing away and unmounts nothing beneath.
 */
export function SettingsPage({ section, onSectionChange, onBack, binding }: SettingsPageProps): ReactElement {
  const backRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    backRef.current?.focus()
  }, [])

  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onBack()
      }
    }
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [onBack])

  return (
    <div className="settings-page" aria-label="STARK settings">
      <div className="settings-page__head">
        <button
          ref={backRef}
          className="settings-page__back"
          type="button"
          onClick={onBack}
          aria-label="Back to workbench"
          title="Back to workbench"
        >
          <UiIcon name="chevron-left" size={14} />
          <span>Back</span>
        </button>
        <div className="settings-page__heading">
          <p className="settings-page__title">Settings</p>
          <p className="settings-page__copy">Manage STARK models, permissions, account and application preferences.</p>
        </div>
      </div>
      <div className="settings-page__body">
        <SettingsNav section={section} onSectionChange={onSectionChange} />
        <div className="settings-page__content">
          {section === 'models' && (
            <ModelsSettings
              provider={binding.provider}
              apiKeyInput={binding.apiKeyInput}
              onApiKeyInputChange={binding.onApiKeyInputChange}
              revealKey={binding.revealKey}
              onToggleRevealKey={binding.onToggleRevealKey}
              modelValue={binding.modelValue}
              selectedModelMissing={binding.selectedModelMissing}
              useModelDisabled={binding.useModelDisabled}
              onModelDraftChange={binding.onModelDraftChange}
              onSaveKey={binding.onSaveKey}
              onRemoveKey={binding.onRemoveKey}
              onTestConnection={binding.onTestConnection}
              onRefreshModels={binding.onRefreshModels}
              onUseModel={binding.onUseModel}
              brain={binding.brainChain}
              heart={binding.heartChain}
              maxBrainModels={binding.maxBrainModels}
              maxHeartModels={binding.maxHeartModels}
              planLabel={binding.planLabel}
              onToggleModel={binding.onToggleModel}
              onSwapModel={binding.onSwapModel}
              onReorderModel={binding.onReorderModel}
              onNavigateBilling={() => onSectionChange('billing')}
            />
          )}
          {section === 'permissions' && (
            <PermissionsSettings
              workspaceId={binding.workspaceId}
              capabilities={binding.capabilities}
              capabilitiesDispatch={binding.capabilitiesDispatch}
              onSaveCapabilities={binding.onSaveCapabilities}
            />
          )}
          {section === 'account' && <AccountSettings onNavigateBilling={() => onSectionChange('billing')} />}
          {section === 'billing' && <BillingSettings onNavigateAccount={() => onSectionChange('account')} />}
          {section === 'styles' && <StylesSettings />}
          {section === 'about' && <AboutSettings />}
        </div>
      </div>
    </div>
  )
}
