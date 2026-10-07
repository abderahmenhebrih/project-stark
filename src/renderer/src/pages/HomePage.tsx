import type { ReactElement } from 'react'
import { APP_NAME, APP_TAGLINE } from '../../../shared/constants'
import { SystemStatus } from '../features/system-status/SystemStatus'
import './HomePage.css'

/**
 * Initial development shell page.
 * Proves Electron + React are wired correctly; not the final UI.
 */
export function HomePage(): ReactElement {
  return (
    <div className="home">
      <h1 className="home__title">{APP_NAME}</h1>
      <p className="home__tagline">{APP_TAGLINE}</p>
      <SystemStatus />
    </div>
  )
}
