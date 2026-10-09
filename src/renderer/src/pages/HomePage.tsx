import type { ReactElement } from 'react'
import { useEffect, useReducer, useState } from 'react'
import { APP_TAGLINE } from '../../../shared/constants'
import { useApp } from '../app/app-context'
import { Explorer } from '../features/explorer/Explorer'
import { ProfileSection } from '../features/profile/ProfileSection'
import { SessionPanel } from '../features/sessions/SessionPanel'
import {
  initialSessionContextDraftState,
  sessionContextDraftReducer
} from '../features/sessions/session-context-state'
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
  const { profile, refreshProfile, workspace } = useApp()
  const displayName = profile?.displayName ?? ''
  const active = workspace.current
  const activeId = active?.id ?? null
  const [sessionOpen, setSessionOpen] = useState(true)
  const [sessionWorkspace, setSessionWorkspace] = useState(activeId)
  // Stage 16 proposal review handoff: the Session panel reports the
  // newly created pending transaction id; the Explorer opens its
  // existing TransactionReview + DiffEditor. Cleared on workspace
  // switch; the Explorer consumes it once via effect.
  const [reviewTransactionId, setReviewTransactionId] = useState<number | null>(null)
  // Stage 17 Change Set handoff: same pattern for grouped proposals.
  const [reviewChangeSetId, setReviewChangeSetId] = useState<number | null>(null)
  // Explicit context drafts live here so both the Explorer attach
  // actions (left/center) and the Session composer (right) share one
  // workspace-scoped list. Drafts never leave this boundary except
  // through the validated prepare/send bridges.
  const [contextDrafts, contextDraftsDispatch] = useReducer(
    sessionContextDraftReducer,
    activeId,
    (id) => ({ ...initialSessionContextDraftState(), workspaceId: id })
  )

  // A new workspace starts with the Session panel open; the panel
  // itself remounts per workspace (key={active.id}) so no session,
  // message, composer, or pagination state carries over.
  if (sessionWorkspace !== activeId) {
    setSessionWorkspace(activeId)
    setSessionOpen(true)
    setReviewTransactionId(null)
    setReviewChangeSetId(null)
  }

  useEffect(() => {
    if (activeId !== null) {
      contextDraftsDispatch({ type: 'workspace-changed', workspaceId: activeId })
    }
  }, [activeId])

  if (active === null) {
    return (
      <div className="welcome">
        <div className="home">
          <h1 className="home__title">Hi {displayName}, I’m STARK. What are we building today?</h1>
          <p className="home__tagline">{APP_TAGLINE}</p>
          <WorkspaceSection />
          <ProfileSection current={profile} onChanged={() => void refreshProfile()} />
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
        <Explorer
          key={active.id}
          workspaceId={active.id}
          contextDraftsDispatch={contextDraftsDispatch}
          externalReviewTransactionId={reviewTransactionId}
          externalReviewChangeSetId={reviewChangeSetId}
        />
        {sessionOpen ? (
          <aside className="workbench__session" aria-label="Session panel">
            <SessionPanel
              key={active.id}
              workspaceId={active.id}
              onCollapse={() => setSessionOpen(false)}
              contextDrafts={contextDrafts.drafts}
              contextDraftsDispatch={contextDraftsDispatch}
              contextDraftError={contextDrafts.error}
              onReviewTransaction={(transactionId) => setReviewTransactionId(transactionId)}
              onReviewChangeSet={(changeSetId) => setReviewChangeSetId(changeSetId)}
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
        <ProfileSection current={profile} onChanged={() => void refreshProfile()} />
        <SystemStatus />
      </div>
    </div>
  )
}
