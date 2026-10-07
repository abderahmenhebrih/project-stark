import type { ReactElement } from 'react'
import { useState } from 'react'
import { APP_TAGLINE } from '../../../shared/constants'
import { useApp } from '../app/app-context'
import { Explorer } from '../features/explorer/Explorer'
import { SessionPanel } from '../features/sessions/SessionPanel'
import { SystemStatus } from '../features/system-status/SystemStatus'
import { WorkspaceSection } from '../features/workspace/WorkspaceSection'
import './HomePage.css'

/**
 * STARK shell with two modes. Without a workspace it is a centered
 * empty-state card (open-folder CTA + recent list). Once a workspace
 * is active it becomes a bounded desktop workbench: a compact header
 * row (subtle greeting + current project) above a flex main area
 * where the left sidebar (Explorer/Search/Changes/Git), the center
 * Monaco editor, and the right STARK Session panel are siblings that
 * own the remaining viewport height. The Session panel defaults open
 * and collapses to a slim rail toggle; it remounts per workspace so
 * no session state leaks across projects.
 */
export function HomePage(): ReactElement {
  const { profile, workspace } = useApp()
  const displayName = profile?.displayName ?? ''
  const active = workspace.current
  const activeId = active?.id ?? null
  const [sessionOpen, setSessionOpen] = useState(true)
  const [sessionWorkspace, setSessionWorkspace] = useState(activeId)

  // A new workspace starts with the Session panel open; the panel
  // itself remounts per workspace (key={active.id}) so no session,
  // message, composer, or pagination state carries over.
  if (sessionWorkspace !== activeId) {
    setSessionWorkspace(activeId)
    setSessionOpen(true)
  }

  if (active === null) {
    return (
      <div className="welcome">
        <div className="home">
          <h1 className="home__title">Hi {displayName}, I’m STARK. What are we building today?</h1>
          <p className="home__tagline">{APP_TAGLINE}</p>
          <WorkspaceSection />
          <SystemStatus />
        </div>
      </div>
    )
  }

  return (
    <div className="workbench-root">
      <div className="workbench-top">
        <p className="workbench-greeting">
          STARK · {displayName} · {active.displayName}
        </p>
        <div className="workbench-workspace">
          <WorkspaceSection />
        </div>
      </div>
      <div className="workbench-main">
        <Explorer key={active.id} workspaceId={active.id} />
        {sessionOpen ? (
          <aside className="workbench__session" aria-label="Session panel">
            <SessionPanel
              key={active.id}
              workspaceId={active.id}
              onCollapse={() => setSessionOpen(false)}
            />
          </aside>
        ) : (
          <button
            className="workbench__session-toggle"
            type="button"
            onClick={() => setSessionOpen(true)}
            aria-label="Show session panel"
            aria-expanded={false}
          >
            Session
          </button>
        )}
      </div>
      <div className="workbench-status">
        <SystemStatus />
      </div>
    </div>
  )
}
