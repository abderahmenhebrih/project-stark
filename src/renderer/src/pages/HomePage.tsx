import type { ReactElement } from 'react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { APP_TAGLINE } from '../../../shared/constants'
import { useApp } from '../app/app-context'
import { AppChrome } from '../layouts/AppChrome'
import { Explorer } from '../features/explorer/Explorer'
import type { ActivityKind } from '../features/explorer/ActivityRail'
import { ProfileSection } from '../features/profile/ProfileSection'
import { SessionPanel } from '../features/sessions/SessionPanel'
import type {
  SessionChromeActions,
  SessionChromeSnapshot
} from '../features/sessions/SessionPanel'
import type { SettingsSection } from '../features/sessions/StarkSettingsSurface'
import {
  initialSessionContextDraftState,
  sessionContextDraftReducer
} from '../features/sessions/session-context-state'
import { SystemStatus } from '../features/system-status/SystemStatus'
import { WorkspaceSection } from '../features/workspace/WorkspaceSection'
import './HomePage.css'

function accountInitialFor(displayName: string): string {
  const trimmed = displayName.trim()
  if (trimmed === '') {
    return 'A'
  }
  const first = trimmed[0]
  return first === undefined ? 'A' : first.toUpperCase()
}

/**
 * Shallow display comparison so mirrored chrome snapshots never cause
 * render loops: identical snapshots keep the previous reference.
 */
function sameChromeSnapshot(
  prev: SessionChromeSnapshot | null,
  next: SessionChromeSnapshot
): boolean {
  if (prev === null) {
    return false
  }
  return (
    prev.title === next.title &&
    prev.selectedSessionId === next.selectedSessionId &&
    prev.sessionsLoading === next.sessionsLoading &&
    prev.looplinkActing === next.looplinkActing &&
    prev.sendBusy === next.sendBusy &&
    prev.creatingSession === next.creatingSession &&
    prev.sessions.length === next.sessions.length &&
    prev.sessions.every(
      (entry, index) =>
        entry.id === next.sessions[index]?.id && entry.title === next.sessions[index]?.title
    )
  )
}

/**
 * STARK shell with two modes. Without a workspace it is a centered
 * empty-state card (open-folder CTA + recent list). Once a workspace
 * is active it becomes one calm application surface: a single compact
 * global bar, then a work area of primary session pane + contextual
 * secondary workspace pane (review / context / file with a stacked
 * terminal) that extends to the bottom of the content area. A
 * workspace-tools drawer overlays the work area on demand and never
 * consumes a permanent layout column. The Session panel mounts per
 * workspace so no session state leaks across projects. All pane
 * visibility is renderer-local; nothing persists.
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
  // Renderer-local shell state: activity, canvas view, drawer,
  // terminal, and settings visibility. The settings surface is owned
  // here (open/section only) so AppChrome can reach it; all provider,
  // Heart, Recovery, usage, and capability reducers stay owned by
  // SessionPanel.
  const [activity, setActivity] = useState<ActivityKind>('explorer')
  const [canvasView, setCanvasView] = useState<'session' | 'editor'>('session')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('ai')
  // Renderer-local request for the secondary Context tab (e.g. from a
  // composer chip). Consumed once by the Explorer; no persistence.
  const [contextRequest, setContextRequest] = useState(0)
  // Mirrored session-chrome display for the AppChrome tab strip. The
  // SessionPanel reducer stays canonical; actions live in a ref so
  // forwarding them never re-renders.
  const [chromeSession, setChromeSession] = useState<SessionChromeSnapshot | null>(null)
  const sessionActionsRef = useRef<SessionChromeActions | null>(null)

  // Stable callbacks for effects inside Explorer (identity must not
  // churn or one-shot review handoffs would refire).
  const handleActivityChange = useCallback((next: ActivityKind) => setActivity(next), [])
  const handleCanvasViewChange = useCallback((view: 'session' | 'editor') => setCanvasView(view), [])
  const handleToggleTerminal = useCallback(() => setTerminalOpen((open) => !open), [])
  const handleToggleSidebar = useCallback(() => setSidebarOpen((open) => !open), [])
  const handleCloseSidebar = useCallback(() => setSidebarOpen(false), [])
  const handleOpenSidebar = useCallback(() => setSidebarOpen(true), [])
  const handleOpenSearch = useCallback(() => {
    setActivity('search')
    setSidebarOpen(true)
  }, [])
  const handleOpenSettings = useCallback((section: SettingsSection = 'ai') => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])
  const handleCloseSettings = useCallback(() => setSettingsOpen(false), [])
  const handleOpenContext = useCallback(() => setContextRequest((count) => count + 1), [])
  const handleSessionChrome = useCallback(
    (snapshot: SessionChromeSnapshot, actions: SessionChromeActions) => {
      sessionActionsRef.current = actions
      setChromeSession((prev) => (sameChromeSnapshot(prev, snapshot) ? prev : snapshot))
    },
    []
  )
  const handleNewSession = useCallback(() => {
    sessionActionsRef.current?.newSession()
  }, [])
  const handleSelectSession = useCallback((sessionId: number) => {
    sessionActionsRef.current?.selectSession(sessionId)
  }, [])
  const handleCloseSession = useCallback(() => {
    sessionActionsRef.current?.closeSession()
  }, [])
  const handleContinueLooplink = useCallback(() => {
    sessionActionsRef.current?.continueLooplink()
  }, [])
  const handleSwitchWorkspace = useCallback(() => {
    void workspace.chooseWorkspace()
  }, [workspace])

  // A new workspace resets shell + review state; panels remount per
  // workspace (key={active.id}) so no session, message, composer, or
  // pagination state carries over.
  if (sessionWorkspace !== activeId) {
    setSessionWorkspace(activeId)
    setActivity('explorer')
    setCanvasView('session')
    setSidebarOpen(false)
    setTerminalOpen(false)
    setSettingsOpen(false)
    setSettingsSection('ai')
    setChromeSession(null)
    setReviewTransactionId(null)
    setReviewChangeSetId(null)
  }

  useEffect(() => {
    if (activeId !== null) {
      contextDraftsDispatch({ type: 'workspace-changed', workspaceId: activeId })
    }
    sessionActionsRef.current = null
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
        onOpenSearch={handleOpenSearch}
        onOpenSettings={() => handleOpenSettings('ai')}
        onOpenAccount={() => handleOpenSettings('account')}
        accountInitial={accountInitialFor(displayName)}
        sessionTitle={chromeSession?.title ?? 'New session'}
        sessions={chromeSession?.sessions ?? []}
        selectedSessionId={chromeSession?.selectedSessionId ?? null}
        sessionsLoading={chromeSession?.sessionsLoading ?? false}
        creatingSession={chromeSession?.creatingSession ?? false}
        looplinkActing={chromeSession?.looplinkActing ?? false}
        looplinkDisabled={
          chromeSession === null ||
          chromeSession.selectedSessionId === null ||
          chromeSession.looplinkActing ||
          chromeSession.sendBusy
        }
        onNewSession={handleNewSession}
        onSelectSession={handleSelectSession}
        onCloseSession={handleCloseSession}
        onContinueLooplink={handleContinueLooplink}
        onSwitchWorkspace={handleSwitchWorkspace}
      />
      <div className="stage-workarea">
        <Explorer
          key={active.id}
          workspaceId={active.id}
          workspaceName={active.displayName}
          workspaceRootPath={active.rootPath}
          contextDrafts={contextDrafts.drafts}
          contextDraftError={contextDrafts.error}
          contextDraftsDispatch={contextDraftsDispatch}
          externalReviewTransactionId={reviewTransactionId}
          externalReviewChangeSetId={reviewChangeSetId}
          externalContextRequest={contextRequest}
          activity={activity}
          onActivityChange={handleActivityChange}
          canvasView={canvasView}
          onCanvasViewChange={handleCanvasViewChange}
          sidebarOpen={sidebarOpen}
          onCloseSidebar={handleCloseSidebar}
          onOpenSidebar={handleOpenSidebar}
          terminalOpen={terminalOpen}
          onToggleTerminal={handleToggleTerminal}
          sessionNode={
            <SessionPanel
              key={active.id}
              workspaceId={active.id}
              contextDrafts={contextDrafts.drafts}
              contextDraftsDispatch={contextDraftsDispatch}
              contextDraftError={contextDrafts.error}
              settingsOpen={settingsOpen}
              settingsSection={settingsSection}
              onSettingsSectionChange={setSettingsSection}
              onCloseSettings={handleCloseSettings}
              onOpenContext={handleOpenContext}
              onSessionChrome={handleSessionChrome}
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
    </div>
  )
}
