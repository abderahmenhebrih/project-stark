import type { ReactElement } from 'react'
import type { SystemStatus as SystemStatusKind } from '../../../shared/types'
import './StatusIndicator.css'

interface StatusIndicatorProps {
  readonly status: SystemStatusKind
  readonly label: string
}

/**
 * Reusable status pill: colored pulse dot plus a short label.
 * Belongs to the shared component layer, not to any single feature.
 */
export function StatusIndicator({ status, label }: StatusIndicatorProps): ReactElement {
  return (
    <span className="status-indicator" data-status={status} role="status">
      <span className="status-indicator__dot" aria-hidden="true" />
      <span className="status-indicator__label">{label}</span>
    </span>
  )
}
