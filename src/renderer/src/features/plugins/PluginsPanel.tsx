import type { ReactElement } from 'react'
import { StarkIcon } from '../../components/icons/StarkIcon'
import './PluginsPanel.css'

/**
 * Plugins placeholder panel (activity surface only).
 *
 * Reserves the feature surface for future connections between STARK
 * and external apps/accounts/services. Intentionally minimal: no
 * provider cards, no Connect controls, no backend of any kind.
 * Presentational only: no IPC, no network, no storage.
 */
export function PluginsPanel(): ReactElement {
  return (
    <div className="plugins-panel" aria-label="Plugins">
      <span className="plugins-panel__icon" aria-hidden="true">
        <StarkIcon name="plugins" size={20} />
      </span>
      <p className="plugins-panel__title">Plugins</p>
      <p className="plugins-panel__copy">Connect STARK to your apps and accounts.</p>
      <p className="plugins-panel__status" role="status">
        Coming later.
      </p>
    </div>
  )
}
