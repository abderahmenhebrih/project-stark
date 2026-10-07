import type { ReactElement } from 'react'
import { APP_TAGLINE } from '../../../shared/constants'
import { useApp } from '../app/app-context'
import { Explorer } from '../features/explorer/Explorer'
import { SystemStatus } from '../features/system-status/SystemStatus'
import { WorkspaceSection } from '../features/workspace/WorkspaceSection'
import './HomePage.css'

/**
 * Main STARK shell. The headline greets the user by their locally
 * stored display name, followed by the workspace state and — once a
 * workspace is active — the read-only explorer; the tagline keeps the
 * product identity.
 */
export function HomePage(): ReactElement {
  const { profile, workspace } = useApp()
  const displayName = profile?.displayName ?? ''
  return (
    <div className="home">
      <h1 className="home__title">Hi {displayName}, I’m STARK. What are we building today?</h1>
      <p className="home__tagline">{APP_TAGLINE}</p>
      <WorkspaceSection />
      {workspace.current !== null && <Explorer key={workspace.current.id} workspaceId={workspace.current.id} />}
      <SystemStatus />
    </div>
  )
}
