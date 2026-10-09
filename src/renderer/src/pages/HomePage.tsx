import type { ReactElement } from 'react'
import { useCallback, useEffect, useReducer, useState } from 'react'
import { APP_TAGLINE } from '../../../shared/constants'
import { useApp } from '../app/app-context'
import { AppChrome } from '../layouts/AppChrome'
import { Explorer } from '../features/explorer/Explorer'
import type { ActivityKind } from '../features/explorer/ActivityRail'
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
 * is active it becomes one calm application surface: a single compact
 * global bar, then a work area of activity rail + contextual sidebar +
 * primary canvas (AI conversation or editor tabs) with a docked
 * terminal drawer, then a thin status strip. The Session panel mounts
 * per workspace so no session state leaks across projects.
 * All pane visibility is renderer-local; nothing persists.
 */
export function HomePage(): ReactElement {
  const { profile, refreshProfile, workspace } = useApp()
  const displayName = profile?.displayName ?? ''
  const active = workspace.current
  const activeId = active?.id ?? null
  const [sessionWorkspace, setSessionWorkspace] = useState(activeId)
  // Stage 16 proposal review handoff: the Session panel reports the
  // newly created pending transaction id; the Explorer opens its
  // existing TransactionReview + DiffEditor. Cleared on workspace
  // switch; the Explorer consumes it once via effect.
  const [reviewTransactionId, setReviewTransactionId] = useState<number | null>(null)
  // Stage 17 Change Set handoff: same pattern for grouped proposals.
  const [reviewChangeSetId, setReviewChangeSetId] = useState<number | null>(null)
  // Explicit context drafts live here so both the Explorer attach
  // actions and the Session composer share one workspace-scoped list.
  // Drafts never leave this boundary except through the validated
  // prepare/send bridges.
  const [contextDrafts, contextDraftsDispatch] = useReducer(
    sessionContextDraftReducer,
    activeId,
    (id) => ({ ...initialSessionContextDraftState(), workspaceId: id })
  )
  // Renderer-local shell state: activity, canvas view, pane visibility.
  const [activity, setActivity] = useState<ActivityKind>('explorer')
  const [canvasView, setCanvasView] = useState<'session' | 'editor'>('session')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [terminalOpen, setTerminalOpen] = useState(false)

  // Stable callbacks for effects inside Explorer (identity must not
  // churn or one-shot review handoffs would refire).
  const handleActivityChange = useCallback((next: ActivityKind) => setActivity(next), [])
  const handleCanvasViewChange = useCallback((view: 'session' | 'editor') => setCanvasView(view), [])
  const handleToggleTerminal = useCallback(() => setTerminalOpen((open) => !open), [])
  const handleToggleSidebar = useCallback(() => setSidebarOpen((open) => !open), [])

  // A new workspace resets shell + review state; panels remount per
  // workspace (key={active.id}) so no session, message, composer, or
  // pagination state carries over.
  if (sessionWorkspace !== activeId) {
    setSessionWorkspace(activeId)
    setActivity('explorer')
    setCanvasView('session')
    setSidebarOpen(true)
    setTerminalOpen(false)
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
    <div className="stage-shell">
      <AppChrome
        workspaceName={active.displayName}
        workspacePath={active.rootPath}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={handleToggleSidebar}
        terminalOpen={terminalOpen}
        onToggleTerminal={handleToggleTerminal}
      />
      <div className="stage-workarea">
        <Explorer
          key={active.id}
          workspaceId={active.id}
          contextDraftsDispatch={contextDraftsDispatch}
          externalReviewTransactionId={reviewTransactionId}
          externalReviewChangeSetId={reviewChangeSetId}
          activity={activity}
          onActivityChange={handleActivityChange}
          canvasView={canvasView}
          onCanvasViewChange={handleCanvasViewChange}
          sidebarOpen={sidebarOpen}
          terminalOpen={terminalOpen}
          onToggleTerminal={handleToggleTerminal}
          sessionNode={
            <SessionPanel
              key={active.id}
              workspaceId={active.id}
              contextDrafts={contextDrafts.drafts}
              contextDraftsDispatch={contextDraftsDispatch}
              contextDraftError={contextDrafts.error}
              onReviewTransaction={(transactionId) => {
                setReviewTransactionId(transactionId)
                setCanvasView('editor')
              }}
              onReviewChangeSet={(changeSetId) => {
                setReviewChangeSetId(changeSetId)
                setCanvasView('editor')
              }}
            />
          }
        />
      </div>
      <div className="workbench-status" role="contentinfo" aria-label="Status bar">
        <span className="workbench-status__workspace" title={active.displayName}>
          {active.displayName}
        </span>
        <span className="workbench-status__divider" aria-hidden="true" />
        <ProfileSection current={profile} onChanged={() => void refreshProfile()} />
        <span className="workbench-status__spacer" aria-hidden="true" />
        <SystemStatus />
      </div>
    </div>
  )
}
