import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactElement, type ReactNode } from 'react'
import {
  acceptChangeTransaction,
  createFileChange,
  getChangeTransaction,
  listRecentChangeTransactions,
  rejectChangeTransaction,
  rollbackChangeTransaction
} from '../../lib/changes-api'
import { normalizeChangeTransactionError } from '../../lib/change-transaction-error'
import { getGitDiff } from '../../lib/git-api'
import {
  prepareContextExcerpt,
  prepareContextFile,
  prepareContextSearchMatch
} from '../../lib/session-context-api'
import { normalizeContextError } from '../../lib/session-context-error'
import { getChangeSet, listRecentChangeSets } from '../../lib/change-sets-api'
import { getWorkspaceFilesApi } from '../../lib/stark-api'
import type { WorkspaceSearchMatch } from '../../../../shared/workspace-search/types'
import type { SessionContextDraft } from '../../../../shared/context/types'
import { ChangesPanel } from '../changes/ChangesPanel'
import type { ActivityKind } from './ActivityRail'
import { StarkMark } from '../../components/StarkMark'
import { STARK_WORDMARK_URL } from '../../components/brandAssets'
import { StarkIcon } from '../../components/icons/StarkIcon'
import { WorkspaceToolsDrawer } from '../../layouts/WorkspaceToolsDrawer'
import { WorkspaceSecondaryPane, type SecondaryTabKind } from '../workspace/WorkspaceSecondaryPane'
import { ContextTab } from '../sessions/ContextTab'
import { ChangeSetPanel } from '../changes/ChangeSetPanel'
import { ChangeSetReview } from '../changes/ChangeSetReview'
import { changeSetPanelReducer, initialChangeSetPanelState } from '../changes/change-set-state'
import { TransactionReview } from '../changes/TransactionReview'
import { changesReducer, initialChangesState } from '../changes/changes-state'
import { CodeEditor, type EditorSelection } from '../editor/CodeEditor'
import { EditorToolbar } from '../editor/EditorToolbar'
import { buildDocumentUri } from '../editor/editor-document'
import { classifyEol, isEditableEol, MIXED_EOL_MESSAGE } from '../editor/editor-eol'
import { toEditorFocus, type EditorFocus } from '../editor/editor-focus'
import { detectEditorLanguage } from '../editor/editor-language'
import { GitDiffViewer } from '../git/GitDiffViewer'
import { GitPanel } from '../git/GitPanel'
import { gitDiffReducer, initialGitDiffState } from '../git/git-state'
import { SearchPanel } from '../search/SearchPanel'
import type { SessionContextDraftAction } from '../sessions/session-context-state'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { confirmDiscardUnsavedDraft, setUnsavedDraft } from './editor-guard'
import {
  applyDraftChange,
  createEditorState,
  isEditorDirty,
  markEditorSaveFailed,
  markEditorSaving,
  type EditorState
} from './editor-state'
import { explorerReducer, initialExplorerState, type ExplorerState } from './explorer-state'
import { FILE_ICON_URLS, FOLDER_ICON_URL, FOLDER_OPEN_ICON_URL } from './fileIconAssets'
import { getFileIconKind } from './fileIconForName'
import './Explorer.css'

interface TreeNodeProps {
  readonly path: string
  readonly state: ExplorerState
  readonly onToggle: (path: string) => void
  readonly onSelectFile: (path: string) => void
  readonly onAttachFile: (path: string) => void
}

function TreeNode({ path, state, onToggle, onSelectFile, onAttachFile }: TreeNodeProps): ReactElement | null {
  const entries = state.entries[path]
  const loading = state.loading.includes(path)
  const error = state.errors[path] ?? null
  if (entries === undefined && !loading && error === null) {
    return null
  }
  return (
    <ul className="explorer__branch" aria-label={path === '' ? 'Workspace root' : path}>
      {(entries ?? []).map((entry) => (
        <li key={entry.relativePath} className="explorer__node">
          {entry.kind === 'directory' ? (
            <button
              className="explorer__row explorer__row--directory"
              type="button"
              aria-expanded={state.expanded.includes(entry.relativePath)}
              onClick={() => onToggle(entry.relativePath)}
            >
              <span className="explorer__chevron" aria-hidden="true">
                <StarkIcon
                  name={state.expanded.includes(entry.relativePath) ? 'chevron-down' : 'chevron-right'}
                  size={13}
                />
              </span>
              <span className="explorer__folder-icon" aria-hidden="true">
                <img
                  src={state.expanded.includes(entry.relativePath) ? FOLDER_OPEN_ICON_URL : FOLDER_ICON_URL}
                  alt=""
                  draggable={false}
                />
              </span>
              <span className="explorer__name">{entry.name}</span>
            </button>
          ) : entry.kind === 'file' ? (
            <span
              className={
                state.selectedPath === entry.relativePath
                  ? 'explorer__file-row explorer__file-row--selected'
                  : 'explorer__file-row'
              }
            >
              <button
                className="explorer__row explorer__row--file"
                type="button"
                onClick={() => onSelectFile(entry.relativePath)}
                aria-current={state.selectedPath === entry.relativePath}
              >
                <span className="explorer__file-icon" aria-hidden="true">
                  <img src={FILE_ICON_URLS[getFileIconKind(entry.name)]} alt="" draggable={false} />
                </span>
                <span className="explorer__name">{entry.name}</span>
              </button>
              <button
                className="explorer__attach"
                type="button"
                onClick={() => onAttachFile(entry.relativePath)}
                aria-label={`Attach ${entry.relativePath} to chat`}
                title="Attach to context"
              >
                <StarkIcon name="plus" size={13} />
              </button>
            </span>
          ) : (
            <span className="explorer__row explorer__row--static">
              <span className="explorer__chevron" aria-hidden="true" />
              <span className="explorer__name">{entry.name}</span>
              <span className="explorer__badge">link</span>
            </span>
          )}
          {entry.kind === 'directory' && state.expanded.includes(entry.relativePath) && (
            <div className="explorer__children">
              <TreeNode path={entry.relativePath} state={state} onToggle={onToggle} onSelectFile={onSelectFile} onAttachFile={onAttachFile} />
            </div>
          )}
        </li>
      ))}
      {loading && (
        <li className="explorer__node">
          <p className="explorer__status" role="status">
            Loading…
          </p>
        </li>
      )}
      {error !== null && (
        <li className="explorer__node">
          <p className="explorer__error" role="alert">
            {error}
          </p>
        </li>
      )}
    </ul>
  )
}

function fileBasename(relativePath: string): string {
  const parts = relativePath.split('/')
  const last = parts[parts.length - 1]
  return last === undefined || last === '' ? relativePath : last
}

interface SecondaryUiState {
  readonly tab: SecondaryTabKind
  readonly contextPinned: boolean
  readonly splitPct: number | null
}

type SecondaryUiAction =
  | { readonly type: 'open-tab'; readonly tab: SecondaryTabKind }
  | { readonly type: 'pin-context' }
  | { readonly type: 'unpin-context' }
  | { readonly type: 'set-split'; readonly pct: number | null }
  | { readonly type: 'reset' }

function secondaryUiReducer(state: SecondaryUiState, action: SecondaryUiAction): SecondaryUiState {
  switch (action.type) {
    case 'open-tab':
      return state.tab === action.tab ? state : { ...state, tab: action.tab }
    case 'pin-context':
      return state.contextPinned && state.tab === 'context'
        ? state
        : { ...state, contextPinned: true, tab: 'context' }
    case 'unpin-context':
      return state.contextPinned ? { ...state, contextPinned: false } : state
    case 'set-split':
      return state.splitPct === action.pct ? state : { ...state, splitPct: action.pct }
    case 'reset':
      return state.tab === 'file' && !state.contextPinned && state.splitPct === null
        ? state
        : { tab: 'file', contextPinned: false, splitPct: null }
  }
}

function toChangeSetsError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message !== '') {
    for (const known of ['We couldn’t load change sets.', 'That change set is no longer available.']) {
      if (error.message.includes(known)) {
        return known
      }
    }
  }
  return fallback
}

function toReadError(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'We couldn’t read this file.'
}

interface ExplorerProps {
  readonly workspaceId: number
  readonly contextDrafts: readonly SessionContextDraft[]
  readonly contextDraftError: string | null
  readonly contextDraftsDispatch: Dispatch<SessionContextDraftAction>
  /** Stage 16 review handoff: when set, open this transaction's existing review. */
  readonly externalReviewTransactionId?: number | null
  /** Stage 17 review handoff: when set, open this change set's grouped review. */
  readonly externalReviewChangeSetId?: number | null
  /** Renderer-local request to reveal the secondary Context tab. Consumed once per count. */
  readonly externalContextRequest?: number
  /** Controlled activity driving the workspace tools drawer. */
  readonly activity: ActivityKind
  readonly onActivityChange: (activity: ActivityKind) => void
  /** Primary view selector for narrow single-pane widths. Reinterpreted on desktop. */
  readonly canvasView: 'session' | 'editor'
  readonly onCanvasViewChange: (view: 'session' | 'editor') => void
  /** Renderer-local drawer visibility (overlay; never a permanent column). */
  readonly sidebarOpen: boolean
  readonly onCloseSidebar: () => void
  readonly onOpenSidebar: () => void
  readonly terminalOpen: boolean
  readonly onToggleTerminal: () => void
  /** Session workspace rendered as the primary pane (always mounted on desktop). */
  readonly sessionNode: ReactNode
}

/**
 * Lazy workspace explorer with bounded project search and
 * transaction-gated single-file editing: root loads on mount,
 * directories load only when expanded, files preview on selection.
 * Files render in a local Monaco editor (read-only preview, editable
 * on Edit); editing is explicit only (Edit → modify → Review change
 * → Accept/Reject): no autosave, no formatting, no direct disk
 * writes. Reviewing a draft persists a pending change transaction
 * (disk untouched); only Accept flows through the Stage 8 writer, and
 * only Rollback restores the checkpoint. Uniform LF/CRLF endings are
 * preserved; mixed-ending files open read-only. The Git tab is
 * read-only awareness (branch/status/diff, explicit Refresh only, no
 * polling); selecting a staged/working row opens its patch in the
 * secondary pane via a read-only Monaco viewer, and Open file reuses
 * the existing file read path. Explicit chat context attaches only on
 * visible actions (preview Attach selection/file, tree Attach, search
 * Attach) through the validated prepare bridges — never on open,
 * edit, or save. All filesystem access
 * goes through workspace bridges; stale responses from a previous
 * workspace are ignored, and switching workspaces resets tree,
 * preview, search, editor, change review, and Git diff.
 *
 * Layout: the session stays mounted as the primary pane while file,
 * review, and context surfaces open in a contextual secondary pane
 * beside it; the terminal stacks beneath that secondary pane. The
 * workspace tools drawer overlays on demand and consumes no permanent
 * column when closed.
 */
export function Explorer({
  workspaceId,
  contextDrafts,
  contextDraftError,
  contextDraftsDispatch,
  externalReviewTransactionId = null,
  externalReviewChangeSetId = null,
  externalContextRequest = 0,
  activity,
  onActivityChange,
  canvasView,
  onCanvasViewChange,
  sidebarOpen,
  onCloseSidebar,
  onOpenSidebar,
  terminalOpen,
  onToggleTerminal,
  sessionNode
}: ExplorerProps): ReactElement {
  const [state, dispatch] = useReducer(explorerReducer, workspaceId, (id) => ({
    ...initialExplorerState(),
    workspaceId: id
  }))
  const [previewLine, setPreviewLine] = useState<number | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [focusRequest, setFocusRequest] = useState<EditorFocus | null>(null)
  // Latest Monaco cursor selection for the read-only preview. Cleared
  // on every file change; edit-mode buffers are excluded because line
  // numbers may no longer match disk (main re-reads at send time).
  const [editorSelection, setEditorSelection] = useState<EditorSelection | null>(null)
  const [changes, changesDispatch] = useReducer(changesReducer, workspaceId, (id) => ({
    ...initialChangesState(),
    workspaceId: id
  }))
  const [changeSets, changeSetsDispatch] = useReducer(changeSetPanelReducer, workspaceId, (id) => ({
    ...initialChangeSetPanelState(),
    workspaceId: id
  }))
  const [gitDiff, gitDiffDispatch] = useReducer(gitDiffReducer, workspaceId, (id) => ({
    ...initialGitDiffState(),
    workspaceId: id
  }))
  const gitDiffRequestRef = useRef(0)
  // Secondary pane tab + explicit context pin + session/secondary split.
  // Renderer-local only; review/file events select their tab, explicit
  // context requests pin and reveal Context. A reducer (not cascading
  // setState) keeps one-shot navigation effects lint-clean.
  // No persistence, no backend.
  const [secondaryUi, secondaryUiDispatch] = useReducer(secondaryUiReducer, undefined, () => ({
    tab: 'file',
    contextPinned: false,
    splitPct: null
  }) as SecondaryUiState)
  const consumedContextRequestRef = useRef(0)
  const workareaRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  // Publish the derived dirty flag so file selection, search-result
  // selection, and workspace switching share one discard guard.
  useEffect(() => {
    setUnsavedDraft(editor !== null && isEditorDirty(editor))
    return () => {
      setUnsavedDraft(false)
    }
  }, [editor])

  const loadDirectory = useCallback(
    async (targetWorkspaceId: number, path: string): Promise<void> => {
      const api = getWorkspaceFilesApi()
      if (api === undefined) {
        dispatch({ type: 'directory-failed', path, message: 'We couldn’t read this folder.' })
        return
      }
      dispatch({ type: 'directory-loading', path })
      try {
        const listing = await api.listDirectory(targetWorkspaceId, path)
        dispatch({
          type: 'directory-loaded',
          workspaceId: listing.workspaceId,
          path: listing.relativePath,
          entries: listing.entries
        })
      } catch (error) {
        dispatch({
          type: 'directory-failed',
          path,
          message: error instanceof Error ? error.message : 'We couldn’t read this folder.'
        })
      }
    },
    []
  )

  useEffect(() => {
    dispatch({ type: 'workspace-changed', workspaceId })
    void loadDirectory(workspaceId, '')
  }, [workspaceId, loadDirectory])

  const refreshHistory = useCallback(async (): Promise<void> => {
    const targetWorkspaceId = workspaceId
    try {
      const transactions = await listRecentChangeTransactions({ workspaceId: targetWorkspaceId })
      changesDispatch({ type: 'history-loaded', workspaceId: targetWorkspaceId, transactions })
    } catch (error: unknown) {
      changesDispatch({ type: 'history-failed', message: normalizeChangeTransactionError(error).message })
    }
  }, [workspaceId])

  const refreshChangeSets = useCallback(async (): Promise<void> => {
    const targetWorkspaceId = workspaceId
    changeSetsDispatch({ type: 'sets-loading' })
    try {
      const sets = await listRecentChangeSets({ workspaceId: targetWorkspaceId })
      changeSetsDispatch({ type: 'sets-loaded', workspaceId: targetWorkspaceId, sets })
    } catch (error: unknown) {
      changeSetsDispatch({ type: 'sets-failed', message: toChangeSetsError(error, 'We couldn’t load change sets.') })
    }
  }, [workspaceId])

  useEffect(() => {
    changesDispatch({ type: 'workspace-changed', workspaceId })
    changesDispatch({ type: 'history-loading' })
    void refreshHistory()
    changeSetsDispatch({ type: 'workspace-changed', workspaceId })
    void refreshChangeSets()
  }, [workspaceId, refreshHistory, refreshChangeSets])

  useEffect(() => {
    gitDiffDispatch({ type: 'workspace-changed', workspaceId })
    gitDiffRequestRef.current = 0
  }, [workspaceId])

  useEffect(() => {
    secondaryUiDispatch({ type: 'reset' })
    consumedContextRequestRef.current = externalContextRequest
  }, [workspaceId, externalContextRequest])

  // Stage 16 review handoff: open the newly proposed transaction in the
  // existing review + DiffEditor and refresh history. Consumed once per
  // id; null clears nothing. Tab switch here is a one-shot external
  // navigation request, not derived state.
  useEffect(() => {
    if (externalReviewTransactionId === null) {
      return
    }
    const transactionId = externalReviewTransactionId
    // One-shot external navigation: the Session panel requested review
    // of a newly created proposal transaction. On desktop the session
    // stays visible and the secondary pane reveals Review.
    onActivityChange('changes')
    onCanvasViewChange('editor')
    secondaryUiDispatch({ type: 'open-tab', tab: 'review' })
    changesDispatch({ type: 'review-loading', transactionId })
    getChangeTransaction({ transactionId }).then(
      (transaction) =>
        changesDispatch({ type: 'review-loaded', workspaceId: transaction.workspaceId, transaction }),
      (error: unknown) =>
        changesDispatch({ type: 'review-failed', message: normalizeChangeTransactionError(error).message })
    )
    void refreshHistory()
  }, [workspaceId, externalReviewTransactionId, refreshHistory, onActivityChange, onCanvasViewChange])

  // Stage 17 review handoff: open the newly proposed change set in the
  // grouped review and refresh history. Consumed once per id.
  useEffect(() => {
    if (externalReviewChangeSetId === null) {
      return
    }
    const changeSetId = externalReviewChangeSetId
    // One-shot external navigation: the Session panel requested review
    // of a newly created grouped proposal.
    onActivityChange('changes')
    onCanvasViewChange('editor')
    secondaryUiDispatch({ type: 'open-tab', tab: 'review' })
    changesDispatch({ type: 'review-closed' })
    changeSetsDispatch({ type: 'set-loading', changeSetId })
    getChangeSet({ changeSetId }).then(
      (changeSet) =>
        changeSetsDispatch({ type: 'set-loaded', workspaceId: changeSet.workspaceId, changeSet }),
      (error: unknown) =>
        changeSetsDispatch({ type: 'set-failed', message: toChangeSetsError(error, 'We couldn’t load change sets.') })
    )
    void refreshChangeSets()
    void refreshHistory()
  }, [workspaceId, externalReviewChangeSetId, refreshHistory, refreshChangeSets, onActivityChange, onCanvasViewChange])

  // Explicit context request (e.g. a composer chip): pin and reveal
  // the secondary Context tab without touching session state.
  useEffect(() => {
    if (externalContextRequest === consumedContextRequestRef.current) {
      return
    }
    consumedContextRequestRef.current = externalContextRequest
    secondaryUiDispatch({ type: 'pin-context' })
    onCanvasViewChange('editor')
  }, [externalContextRequest, onCanvasViewChange])

  function handleToggle(path: string): void {
    const expanding = !state.expanded.includes(path)
    dispatch({ type: 'toggle', path })
    if (expanding) {
      void loadDirectory(workspaceId, path)
    }
  }

  function loadPreviewFile(path: string): void {
    dispatch({ type: 'file-selected', path })
    setEditor(null)
    setFocusRequest(null)
    setEditorSelection(null)
    changesDispatch({ type: 'review-closed' })
    gitDiffDispatch({ type: 'diff-closed' })
    const api = getWorkspaceFilesApi()
    if (api === undefined) {
      dispatch({ type: 'file-failed', path, message: 'We couldn’t read this file.' })
      return
    }
    api.readTextFile(workspaceId, path).then(
      (file) =>
        dispatch({
          type: 'file-loaded',
          workspaceId: file.workspaceId,
          path: file.relativePath,
          content: file.content,
          revision: file.revision
        }),
      (error: unknown) =>
        dispatch({
          type: 'file-failed',
          path,
          message: toReadError(error)
        })
    )
  }

  function handleSelectFile(path: string): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    setPreviewLine(null)
    loadPreviewFile(path)
    secondaryUiDispatch({ type: 'open-tab', tab: 'file' })
    onCanvasViewChange('editor')
  }

  function handleSelectGitDiff(relativePath: string, target: 'staged' | 'unstaged'): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    changesDispatch({ type: 'review-closed' })
    const requestId = gitDiffRequestRef.current + 1
    gitDiffRequestRef.current = requestId
    secondaryUiDispatch({ type: 'open-tab', tab: 'review' })
    onCanvasViewChange('editor')
    gitDiffDispatch({ type: 'diff-loading', workspaceId, relativePath, target, requestId })
    getGitDiff({ workspaceId, relativePath, target }).then(
      (result) => {
        if (gitDiffRequestRef.current !== requestId) {
          return
        }
        gitDiffDispatch({ type: 'diff-succeeded', workspaceId: result.workspaceId, requestId, result })
      },
      (error: unknown) => {
        if (gitDiffRequestRef.current !== requestId) {
          return
        }
        gitDiffDispatch({
          type: 'diff-failed',
          workspaceId,
          requestId,
          message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t read this Git diff.'
        })
      }
    )
  }

  function handleCloseGitDiff(): void {
    gitDiffDispatch({ type: 'diff-closed' })
  }

  function handleOpenGitFile(relativePath: string): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    setPreviewLine(null)
    onActivityChange('explorer')
    secondaryUiDispatch({ type: 'open-tab', tab: 'file' })
    onCanvasViewChange('editor')
    loadPreviewFile(relativePath)
  }

  function handleSelectSearchResult(path: string, line: number, column: number): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    setPreviewLine(line)
    loadPreviewFile(path)
    secondaryUiDispatch({ type: 'open-tab', tab: 'file' })
    onCanvasViewChange('editor')
    setFocusRequest(toEditorFocus(line, column))
  }

  /**
   * Explicit context attach plumbing. Each action performs exactly one
   * bounded prepare call; failures surface as safe copy in the Context
   * tab (the single draft-error owner is the HomePage reducer).
   * Nothing attaches implicitly — no open/edit/save hooks.
   */
  function handleAttachDraft(promise: Promise<SessionContextDraft>): void {
    promise.then(
      (draft) => contextDraftsDispatch({ type: 'draft-added', workspaceId, draft }),
      (error: unknown) =>
        contextDraftsDispatch({
          type: 'draft-failed',
          workspaceId,
          message: normalizeContextError(error).message
        })
    )
  }

  function handleAttachPreviewSelection(): void {
    const preview = state.preview
    if (preview === null || editorSelection === null || editor !== null) {
      return
    }
    const lineStart = Math.min(editorSelection.startLineNumber, editorSelection.endLineNumber)
    const lineEnd = Math.max(editorSelection.startLineNumber, editorSelection.endLineNumber)
    handleAttachDraft(prepareContextExcerpt({ workspaceId, relativePath: preview.path, lineStart, lineEnd }))
  }

  function handleAttachPreviewFile(): void {
    const preview = state.preview
    if (preview === null || editor !== null) {
      return
    }
    handleAttachDraft(prepareContextFile({ workspaceId, relativePath: preview.path }))
  }

  function handleAttachTreeFile(path: string): void {
    handleAttachDraft(prepareContextFile({ workspaceId, relativePath: path }))
  }

  function handleAttachSearchResult(match: WorkspaceSearchMatch): void {
    handleAttachDraft(
      prepareContextSearchMatch({ workspaceId, relativePath: match.relativePath, line: match.line })
    )
  }

  function handleEdit(): void {
    const preview = state.preview
    if (
      preview === null ||
      preview.content === null ||
      preview.revision === null ||
      editor !== null ||
      !isEditableEol(classifyEol(preview.content))
    ) {
      return
    }
    setEditor(createEditorState(preview.content, preview.revision))
  }

  function handleMonacoChange(value: string): void {
    setEditor((current) => (current === null ? current : applyDraftChange(current, value)))
  }

  function handleCancel(): void {
    const preview = state.preview
    if (editor === null || preview === null) {
      return
    }
    if (isEditorDirty(editor) && !confirmDiscardUnsavedDraft()) {
      return
    }
    // Discard the draft and reload the actual disk version so the UI
    // never pretends drafted text was kept.
    loadPreviewFile(preview.path)
  }

  async function handleReviewChange(): Promise<void> {
    const preview = state.preview
    if (editor === null || preview === null || editor.saving || !isEditorDirty(editor)) {
      return
    }
    const saving = markEditorSaving(editor)
    setEditor(saving)
    try {
      // Proposal only: the project file is never touched here. The
      // returned pending transaction becomes the review; the volatile
      // draft is replaced by persisted data, so workspace switching is
      // safe again without a discard prompt.
      const transaction = await createFileChange({
        workspaceId,
        relativePath: preview.path,
        expectedRevision: saving.revision,
        proposedContent: saving.draftContent
      })
      setEditor(null)
      changesDispatch({ type: 'review-opened', transaction })
      secondaryUiDispatch({ type: 'open-tab', tab: 'review' })
      void refreshHistory()
    } catch (error: unknown) {
      // Never display raw invoke rejections: the normalizer reduces any
      // transported failure (including Electron's "Error invoking remote
      // method" prefix) to canonical display-safe copy. The draft stays
      // intact, including the "no changes" outcome.
      setEditor(markEditorSaveFailed(saving, normalizeChangeTransactionError(error).message))
    }
  }

  function handleSelectTransaction(transactionId: number): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    secondaryUiDispatch({ type: 'open-tab', tab: 'review' })
    onCanvasViewChange('editor')
    changesDispatch({ type: 'review-loading', transactionId })
    getChangeTransaction({ transactionId }).then(
      (transaction) =>
        changesDispatch({ type: 'review-loaded', workspaceId: transaction.workspaceId, transaction }),
      (error: unknown) =>
        changesDispatch({ type: 'review-failed', message: normalizeChangeTransactionError(error).message })
    )
  }

  function handleSelectChangeSet(changeSetId: number): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    secondaryUiDispatch({ type: 'open-tab', tab: 'review' })
    onCanvasViewChange('editor')
    changesDispatch({ type: 'review-closed' })
    changeSetsDispatch({ type: 'set-loading', changeSetId })
    getChangeSet({ changeSetId }).then(
      (changeSet) =>
        changeSetsDispatch({ type: 'set-loaded', workspaceId: changeSet.workspaceId, changeSet }),
      (error: unknown) =>
        changeSetsDispatch({ type: 'set-failed', message: toChangeSetsError(error, 'We couldn’t load change sets.') })
    )
  }

  function handleCloseChangeSet(): void {
    changeSetsDispatch({ type: 'set-closed' })
  }

  function handleCloseReview(): void {
    changesDispatch({ type: 'review-closed' })
  }

  async function handleAccept(): Promise<void> {
    const detail = changes.detail
    if (detail === null || changes.busy !== 'idle') {
      return
    }
    changesDispatch({ type: 'action-started', action: 'accepting' })
    try {
      const transaction = await acceptChangeTransaction({ transactionId: detail.id })
      const file = transaction.files[0]
      if (file !== undefined && file.appliedRevision !== null) {
        dispatch({
          type: 'file-loaded',
          workspaceId: transaction.workspaceId,
          path: file.relativePath,
          content: file.proposedContent,
          revision: file.appliedRevision
        })
      }
      changesDispatch({ type: 'action-succeeded', transaction, notice: 'Change applied' })
      void refreshHistory()
      void refreshChangeSets()
    } catch (error: unknown) {
      changesDispatch({ type: 'action-failed', message: normalizeChangeTransactionError(error).message })
    }
  }

  async function handleReject(): Promise<void> {
    const detail = changes.detail
    if (detail === null || changes.busy !== 'idle') {
      return
    }
    changesDispatch({ type: 'action-started', action: 'rejecting' })
    try {
      const transaction = await rejectChangeTransaction({ transactionId: detail.id })
      const file = transaction.files[0]
      if (file !== undefined) {
        const api = getWorkspaceFilesApi()
        if (api !== undefined) {
          try {
            const current = await api.readTextFile(workspaceId, file.relativePath)
            dispatch({
              type: 'file-loaded',
              workspaceId: current.workspaceId,
              path: current.relativePath,
              content: current.content,
              revision: current.revision
            })
          } catch {
            // Disk state is unchanged by reject; a failed re-read only
            // leaves the previous preview in place.
          }
        }
      }
      changesDispatch({ type: 'action-succeeded', transaction, notice: null })
      void refreshHistory()
      void refreshChangeSets()
    } catch (error: unknown) {
      changesDispatch({ type: 'action-failed', message: normalizeChangeTransactionError(error).message })
    }
  }

  async function handleRollback(): Promise<void> {
    const detail = changes.detail
    if (detail === null || changes.busy !== 'idle') {
      return
    }
    changesDispatch({ type: 'action-started', action: 'rolling-back' })
    try {
      const transaction = await rollbackChangeTransaction({ transactionId: detail.id })
      const file = transaction.files[0]
      if (file !== undefined) {
        dispatch({
          type: 'file-loaded',
          workspaceId: transaction.workspaceId,
          path: file.relativePath,
          content: file.beforeContent,
          revision: file.beforeRevision
        })
      }
      changesDispatch({ type: 'action-succeeded', transaction, notice: 'Change rolled back' })
      void refreshHistory()
      void refreshChangeSets()
    } catch (error: unknown) {
      changesDispatch({ type: 'action-failed', message: normalizeChangeTransactionError(error).message })
    }
  }

  function handleCloseSecondaryPane(): void {
    if (terminalOpen) {
      onToggleTerminal()
    }
    secondaryUiDispatch({ type: 'unpin-context' })
    handleCloseGitDiff()
    handleCloseReview()
    handleCloseChangeSet()
  }

  function handleResizeStart(event: React.PointerEvent): void {
    if (event.button !== 0) {
      return
    }
    draggingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleResizeMove(event: React.PointerEvent): void {
    if (!draggingRef.current) {
      return
    }
    const container = workareaRef.current
    if (container === null || container.clientWidth === 0) {
      return
    }
    const rect = container.getBoundingClientRect()
    const pct = ((event.clientX - rect.left) / rect.width) * 100
    secondaryUiDispatch({ type: 'set-split', pct: Math.min(68, Math.max(30, pct)) })
  }

  function handleResizeEnd(): void {
    draggingRef.current = false
  }

  function handleResizeKey(event: React.KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }
    event.preventDefault()
    const container = workareaRef.current
    const base =
      secondaryUi.splitPct ??
      (container !== null && container.clientWidth > 0
        ? (container.querySelector('.workspace__session')?.getBoundingClientRect().width ?? 0) /
          container.clientWidth /
          0.01
        : 45)
    const next = event.key === 'ArrowLeft' ? base - 2 : base + 2
    secondaryUiDispatch({ type: 'set-split', pct: Math.min(68, Math.max(30, next)) })
  }

  const dirty = editor !== null && isEditorDirty(editor)
  const previewContent = state.preview?.content ?? null
  const previewEol = useMemo(
    () => (previewContent === null ? null : classifyEol(previewContent)),
    [previewContent]
  )
  const previewEditable = previewEol !== null && isEditableEol(previewEol)
  const previewPathLabel = state.preview === null ? '' : state.preview.path === '' ? '/' : state.preview.path
  const readOnlyStatus = !previewEditable ? 'Mixed line endings — read-only' : previewLine !== null ? `Line ${previewLine} · Read-only` : 'Read-only'

  const hasReviewContent =
    changes.detail !== null ||
    changes.detailLoading ||
    changes.detailError !== null ||
    changeSets.setDetail !== null ||
    changeSets.setDetailLoading ||
    changeSets.setDetailError !== null
  const hasGitDiff = gitDiff.relativePath !== null
  const hasReviewTab = hasReviewContent || hasGitDiff
  const hasFile = state.preview !== null
  const secondaryOpen = hasReviewTab || hasFile || secondaryUi.contextPinned || terminalOpen

  const tabs: { readonly kind: SecondaryTabKind; readonly label: string }[] = []
  if (hasReviewTab) {
    tabs.push({ kind: 'review', label: 'Review' })
  }
  tabs.push({ kind: 'context', label: 'Context' })
  if (hasFile) {
    tabs.push({ kind: 'file', label: fileBasename(state.preview?.path ?? '') })
  }
  const effectiveTab: SecondaryTabKind = tabs.some((tab) => tab.kind === secondaryUi.tab)
    ? secondaryUi.tab
    : hasReviewTab
      ? 'review'
      : hasFile
        ? 'file'
        : 'context'

  function renderReviewBody(): ReactElement {
    if (hasGitDiff) {
      return (
        <div className="workbench__editor-body">
          <EditorToolbar
            path={`Git diff · ${gitDiff.relativePath ?? ''} · ${gitDiff.target === 'staged' ? 'Staged' : 'Working tree'}`}
            status="Read-only"
            actions={
              <>
                <button className="explorer__secondary" type="button" onClick={() => handleOpenGitFile(gitDiff.relativePath as string)}>
                  Open file
                </button>
                <button className="explorer__secondary" type="button" onClick={handleCloseGitDiff}>
                  Close
                </button>
              </>
            }
          />
          {gitDiff.phase === 'loading' ? (
            <p className="explorer__status explorer__status--centered" role="status">
              Loading Git diff…
            </p>
          ) : gitDiff.phase === 'error' ? (
            <p className="explorer__error explorer__status--centered" role="alert">
              {gitDiff.error ?? 'We couldn’t read this Git diff.'}
            </p>
          ) : gitDiff.result !== null ? (
            gitDiff.result.patch === '' ? (
              <p className="explorer__status explorer__status--centered">No patch content.</p>
            ) : (
              <div className="editor-canvas">
                <GitDiffViewer
                  key={`gitdiff:${workspaceId}:${gitDiff.result.relativePath}:${gitDiff.result.target}`}
                  relativePath={gitDiff.result.relativePath}
                  target={gitDiff.result.target}
                  patch={gitDiff.result.patch}
                />
              </div>
            )
          ) : (
            <p className="explorer__status explorer__status--centered">Loading Git diff…</p>
          )}
        </div>
      )
    }
    if (changes.detail !== null) {
      return (
        <TransactionReview
          transaction={changes.detail}
          busy={changes.busy}
          actionError={changes.actionError}
          notice={changes.notice}
          onAccept={() => void handleAccept()}
          onReject={() => void handleReject()}
          onRollback={() => void handleRollback()}
          onClose={handleCloseReview}
        />
      )
    }
    if (changes.detailLoading) {
      return (
        <p className="explorer__status explorer__status--centered" role="status">
          Loading change…
        </p>
      )
    }
    if (changes.detailError !== null) {
      return (
        <p className="explorer__error explorer__status--centered" role="alert">
          {changes.detailError}
        </p>
      )
    }
    if (changeSets.setDetail !== null) {
      return (
        <ChangeSetReview
          changeSet={changeSets.setDetail}
          onReviewFile={handleSelectTransaction}
          onClose={handleCloseChangeSet}
        />
      )
    }
    if (changeSets.setDetailLoading) {
      return (
        <p className="explorer__status explorer__status--centered" role="status">
          Loading change set…
        </p>
      )
    }
    return (
      <p className="explorer__error explorer__status--centered" role="alert">
        {changeSets.setDetailError ?? 'We couldn’t load this review.'}
      </p>
    )
  }

  function renderFileBody(): ReactElement {
    if (state.preview === null) {
      return (
        <div className="editor-empty" role="status" aria-label="No file selected">
          <StarkMark size="hero" />
          <img className="editor-empty__wordmark" src={STARK_WORDMARK_URL} alt="STARK" />
          <p className="editor-empty__title">Select a file to open</p>
          <p className="editor-empty__hint">Open a file from the Explorer · attach context · ask STARK on the right</p>
        </div>
      )
    }
    if (state.preview.loading) {
      return (
        <p className="explorer__status explorer__status--centered" role="status">
          Loading…
        </p>
      )
    }
    if (state.preview.error !== null) {
      return (
        <p className="explorer__error explorer__status--centered" role="alert">
          {state.preview.error}
        </p>
      )
    }
    if (editor !== null && state.preview.content !== null && state.preview.revision !== null) {
      return (
        <div className="workbench__editor-body">
          <EditorToolbar
            path={previewPathLabel}
            status={dirty ? 'Unsaved changes' : 'No unsaved changes'}
            actions={
              <>
                <button
                  className="explorer__primary"
                  type="button"
                  disabled={!dirty || editor.saving}
                  onClick={() => void handleReviewChange()}
                >
                  {editor.saving ? 'Reviewing…' : 'Review change'}
                </button>
                <button className="explorer__secondary" type="button" onClick={handleCancel}>
                  Cancel
                </button>
              </>
            }
          />
          {editor.saveError !== null && (
            <p className="explorer__error explorer__inline-alert" role="alert">
              {editor.saveError}
            </p>
          )}
          <div className="editor-canvas">
            <CodeEditor
              key={`edit:${workspaceId}:${state.preview.path}:${state.preview.revision}`}
              documentUri={buildDocumentUri(workspaceId, state.preview.path)}
              language={detectEditorLanguage(state.preview.path)}
              initialValue={editor.draftContent}
              eol={previewEol === 'crlf' ? 'CRLF' : 'LF'}
              readOnly={false}
              focusRequest={null}
              onContentChange={handleMonacoChange}
              ariaLabel="File editor"
            />
          </div>
        </div>
      )
    }
    return (
      <div className="workbench__editor-body">
        <EditorToolbar
          path={previewPathLabel}
          status={readOnlyStatus}
          actions={
            state.preview.revision !== null && previewEditable && editor === null ? (
              <>
                <button className="explorer__primary" type="button" onClick={handleEdit}>
                  Edit
                </button>
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={handleAttachPreviewSelection}
                  disabled={editorSelection === null}
                  title={editorSelection === null ? 'Select text in the preview first' : 'Attach the selected lines to chat'}
                >
                  Attach selection
                </button>
                <button className="explorer__secondary" type="button" onClick={handleAttachPreviewFile}>
                  Attach file
                </button>
              </>
            ) : null
          }
        />
        {previewEol !== null && !previewEditable && (
          <p className="explorer__error explorer__inline-alert" role="alert">
            {MIXED_EOL_MESSAGE}
          </p>
        )}
        {state.preview.content !== null && state.preview.revision !== null && (
          <div className="editor-canvas">
            <CodeEditor
              key={`view:${workspaceId}:${state.preview.path}:${state.preview.revision}`}
              documentUri={buildDocumentUri(workspaceId, state.preview.path)}
              language={detectEditorLanguage(state.preview.path)}
              initialValue={state.preview.content}
              eol={previewEol === 'crlf' ? 'CRLF' : 'LF'}
              readOnly
              focusRequest={focusRequest}
              onSelectionChange={setEditorSelection}
              ariaLabel="File preview"
            />
          </div>
        )}
      </div>
    )
  }

  // Directory chevrons resolve per expanded state via the drawer tree.
  return (
    <div ref={workareaRef} className="workspace" data-canvas-view={canvasView}>
      <WorkspaceToolsDrawer open={sidebarOpen} activity={activity} onActivityChange={onActivityChange} onClose={onCloseSidebar}>
        <div className="workbench__sidebar-body">
          {activity === 'explorer' ? (
            <TreeNode path="" state={state} onToggle={handleToggle} onSelectFile={handleSelectFile} onAttachFile={handleAttachTreeFile} />
          ) : activity === 'search' ? (
            <SearchPanel
              key={workspaceId}
              workspaceId={workspaceId}
              onSelectResult={handleSelectSearchResult}
              onAttachResult={handleAttachSearchResult}
            />
          ) : activity === 'git' ? (
            <GitPanel
              key={workspaceId}
              workspaceId={workspaceId}
              onSelectDiff={handleSelectGitDiff}
              onOpenFile={handleOpenGitFile}
            />
          ) : (
            <>
              <ChangeSetPanel
                sets={changeSets.sets}
                loading={changeSets.setsLoading}
                error={changeSets.setsError}
                selectedId={changeSets.selectedSetId}
                onSelect={handleSelectChangeSet}
              />
              <ChangesPanel
                history={changes.history}
                loading={changes.historyLoading}
                error={changes.historyError}
                selectedId={changes.selectedId}
                onSelect={handleSelectTransaction}
              />
            </>
          )}
        </div>
      </WorkspaceToolsDrawer>
      <div className="workspace__narrow-switch" role="tablist" aria-label="Primary views">
        <button
          className={canvasView === 'session' ? 'workspace__narrow-tab workspace__narrow-tab--active' : 'workspace__narrow-tab'}
          type="button"
          role="tab"
          aria-selected={canvasView === 'session'}
          onClick={() => onCanvasViewChange('session')}
        >
          Session
        </button>
        <button
          className={canvasView === 'editor' ? 'workspace__narrow-tab workspace__narrow-tab--active' : 'workspace__narrow-tab'}
          type="button"
          role="tab"
          aria-selected={canvasView === 'editor'}
          onClick={() => onCanvasViewChange('editor')}
        >
          Workspace
        </button>
      </div>
      <section className="workspace__session" aria-label="Session">
        <div className="session-frame" style={secondaryUi.splitPct !== null ? { flexBasis: `${secondaryUi.splitPct}%` } : undefined}>
          {sessionNode}
        </div>
        {secondaryOpen && (
          <div
            className="workspace__resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize session and workspace panes"
            aria-valuenow={secondaryUi.splitPct ?? 45}
            aria-valuemin={30}
            aria-valuemax={68}
            tabIndex={0}
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            onKeyDown={handleResizeKey}
          />
        )}
        {secondaryOpen && (
          <WorkspaceSecondaryPane
            tabs={tabs}
            activeTab={effectiveTab}
            onTabChange={(tab) => secondaryUiDispatch({ type: 'open-tab', tab })}
            onOpenDrawer={onOpenSidebar}
            onClosePane={handleCloseSecondaryPane}
            terminalOpen={terminalOpen}
            terminalNode={
              <div className="terminal-stack">
                <div className="terminal-stack__bar">
                  <span className="terminal-stack__label">Terminal</span>
                  <button
                    className="stark-btn stark-btn--ghost"
                    type="button"
                    onClick={onToggleTerminal}
                    aria-label="Hide terminal"
                  >
                    Hide
                  </button>
                </div>
                <TerminalPanel key={`terminal:${workspaceId}`} workspaceId={workspaceId} />
              </div>
            }
          >
            <div className="workbench__editor-main">
              {effectiveTab === 'review' && hasReviewTab ? (
                renderReviewBody()
              ) : effectiveTab === 'file' && hasFile ? (
                renderFileBody()
              ) : (
                <ContextTab
                  workspaceId={workspaceId}
                  drafts={contextDrafts}
                  dispatch={contextDraftsDispatch}
                  draftError={contextDraftError}
                />
              )}
            </div>
          </WorkspaceSecondaryPane>
        )}
      </section>
    </div>
  )
}
