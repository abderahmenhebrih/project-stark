import type { ReactElement } from 'react'
import { StarkIcon } from '../../components/icons/StarkIcon'
import { productionEntitlements, type AccountEntitlements } from '../billing/entitlements'
import './PluginsPanel.css'

interface PluginsPanelProps {
  /** Central product entitlements (production default: Free). */
  readonly entitlements?: AccountEntitlements
  /** Route to Settings → Billing (provided by the shell). */
  readonly onNavigateBilling?: () => void
}

/**
 * Plugins activity panel (product discovery surface only).
 *
 * Free shows the upgrade path with a route to Billing; paid/funded
 * entitlements show the reserved future placeholder. No integrations,
 * no Connect controls, no backend of any kind. Presentational only:
 * no IPC, no network, no storage.
 */
export function PluginsPanel({ entitlements, onNavigateBilling }: PluginsPanelProps): ReactElement {
  const effective = entitlements ?? productionEntitlements()
  return (
    <div className="plugins-panel" aria-label="Plugins">
      <span className="plugins-panel__icon" aria-hidden="true">
        <StarkIcon name="plugins" size={20} />
      </span>
      <p className="plugins-panel__title">Plugins</p>
      {effective.pluginsEnabled ? (
        <>
          <p className="plugins-panel__copy">Connect STARK to your apps and accounts.</p>
          <p className="plugins-panel__status" role="status">
            Coming later.
          </p>
        </>
      ) : (
        <>
          <p className="plugins-panel__copy">Plugins are available with STARK Magma, Frost, or funded Void.</p>
          {onNavigateBilling === undefined ? null : (
            <button className="explorer__secondary" type="button" onClick={onNavigateBilling}>
              View Billing
            </button>
          )}
        </>
      )}
    </div>
  )
}
