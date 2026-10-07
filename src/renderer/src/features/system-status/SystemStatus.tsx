import type { ReactElement } from 'react'
import { SYSTEM_READY_LABEL } from '../../../../shared/constants'
import { StatusIndicator } from '../../components/StatusIndicator'
import { useAppInfo } from '../../hooks/useAppInfo'
import './SystemStatus.css'

/**
 * System-status feature module.
 * Composes the reusable StatusIndicator with live metadata
 * from the main process. Future feature modules (sessions,
 * providers, agents, …) follow this same directory pattern.
 */
export function SystemStatus(): ReactElement {
  const { appInfo } = useAppInfo()
  const ready = appInfo !== null && appInfo.platform !== 'browser'

  return (
    <section className="system-status" aria-label="System status">
      <StatusIndicator status={appInfo === null ? 'starting' : 'ready'} label={ready ? SYSTEM_READY_LABEL : 'Starting…'} />
      {appInfo !== null && (
        <p className="system-status__meta">
          v{appInfo.version} · {appInfo.platform} · Electron {appInfo.electron}
        </p>
      )}
    </section>
  )
}
