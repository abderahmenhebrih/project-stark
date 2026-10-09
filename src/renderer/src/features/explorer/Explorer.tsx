import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactElement } from 'react'
import type { WorkspaceEntry } from '../../../../shared/workspace-files/types'
import { APP_NAME } from '../../../../shared/constants'
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
import { StarkMark } from '../../components/StarkMark'
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
import './Explorer.css'

interface TreeNodeProps {
  readonly path: string
  readonly state: ExplorerState
  readonly onToggle: (path: string) => void
  readonly onSelectFile: (path: string) => void
  readonly onAttachFile: (path: string) => void
}

function entryGlyph(kind: WorkspaceEntry['kind'], expanded: boolean): string {
  if (kind === 'directory') {
    return expanded ? '▾' : '▸'
  }
  return ''
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
                {entryGlyph(entry.kind, state.expanded.includes(entry.relativePath))}
              </span>
              <span className="explorer__name">{entry.name}</span>
            </button>
          ) : entry.kind === 'file' ? (
            <span className="explorer__file-row">
              <button
                className="explorer__row explorer__row--file"
                type="button"
                onClick={() => onSelectFile(entry.relativePath)}
              >
                <span className="explorer__chevron" aria-hidden="true" />
                <span className="explorer__name">{entry.name}</span>
              </button>
              <button
                className="explorer__attach"
                type="button"
                onClick={() => onAttachFile(entry.relativePath)}
                aria-label={`Attach ${entry.relativePath} to chat`}
                title="Attach file to chat"
              >
                Attach
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

interface ExplorerProps {
  readonly workspaceId: number
  readonly contextDraftsDispatch: Dispatch<SessionContextDraftAction>
  /** Stage 16 review handoff: when set, open this transaction's existing review. */
  readonly externalReviewTransactionId?: number | null
  /** Stage 17 review handoff: when set, open this change set's grouped review. */
  readonly externalReviewChangeSetId?: number | null
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
 * main pane via a read-only Monaco viewer, and Open file reuses the
 * existing file read path. Explicit chat context attaches only on
 * visible actions (preview Attach selection/file, tree Attach, search
 * Attach) through the validated prepare bridges — never on open,
 * edit, or save. All filesystem access
 * goes through workspace bridges; stale responses from a previous
 * workspace are ignored, and switching workspaces resets tree,
 * preview, search, editor, change review, and Git diff.
 */
export function Explorer({ workspaceId, contextDraftsDispatch, externalReviewTransactionId = null, externalReviewChangeSetId = null }: ExplorerProps): ReactElement {
  const [state, dispatch] = useReducer(explorerReducer, workspaceId, (id) => ({
    ...initialExplorerState(),
    workspaceId: id
  }))
  const [tab, setTab] = useState<'explorer' | 'search' | 'changes' | 'git'>('explorer')
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
    // of a newly created proposal transaction.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab('changes')
    changesDispatch({ type: 'review-loading', transactionId })
    getChangeTransaction({ transactionId }).then(
      (transaction) =>
        changesDispatch({ type: 'review-loaded', workspaceId: transaction.workspaceId, transaction }),
      (error: unknown) =>
        changesDispatch({ type: 'review-failed', message: normalizeChangeTransactionError(error).message })
    )
    void refreshHistory()
  }, [workspaceId, externalReviewTransactionId, refreshHistory])

  // Stage 17 review handoff: open the newly proposed change set in the
  // grouped review and refresh history. Consumed once per id.
  useEffect(() => {
    if (externalReviewChangeSetId === null) {
      return
    }
    const changeSetId = externalReviewChangeSetId
    // One-shot external navigation: the Session panel requested review
    // of a newly created grouped proposal.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab('changes')
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
  }, [workspaceId, externalReviewChangeSetId, refreshHistory, refreshChangeSets])

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
  }

  function handleSelectGitDiff(relativePath: string, target: 'staged' | 'unstaged'): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    changesDispatch({ type: 'review-closed' })
    const requestId = gitDiffRequestRef.current + 1
    gitDiffRequestRef.current = requestId
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
    setTab('explorer')
    loadPreviewFile(relativePath)
  }

  function handleSelectSearchResult(path: string, line: number, column: number): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    setPreviewLine(line)
    loadPreviewFile(path)
    setFocusRequest(toEditorFocus(line, column))
  }

  /**
   * Explicit context attach plumbing. Each action performs exactly one
   * bounded prepare call; failures surface as safe copy in the Session
   * panel's Attached context section (the single owner of draft
   * errors). Nothing attaches implicitly — no open/edit/save hooks.
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

  const dirty = editor !== null && isEditorDirty(editor)
  const previewContent = state.preview?.content ?? null
  const previewEol = useMemo(
    () => (previewContent === null ? null : classifyEol(previewContent)),
    [previewContent]
  )
  const previewEditable = previewEol !== null && isEditableEol(previewEol)
  const previewPathLabel = state.preview === null ? '' : state.preview.path === '' ? '/' : state.preview.path
  const readOnlyStatus = !previewEditable ? 'Mixed line endings — read-only' : previewLine !== null ? `Line ${previewLine} · Read-only` : 'Read-only'

  return (
    <section className="workbench" aria-label="Explorer">
      <aside className="workbench__sidebar" aria-label="Sidebar">
        <div className="workbench__tabs" role="tablist" aria-label="Explorer views" aria-orientation="vertical">
          <button
            className={tab === 'explorer' ? 'explorer__tab explorer__tab--active' : 'explorer__tab'}
            type="button"
            role="tab"
            aria-selected={tab === 'explorer'}
            title="Explorer"
            onClick={() => setTab('explorer')}
          >
            <span className="explorer__tab-icon" aria-hidden="true">▤</span>
            <span className="explorer__tab-label">Explorer</span>
          </button>
          <button
            className={tab === 'search' ? 'explorer__tab explorer__tab--active' : 'explorer__tab'}
            type="button"
            role="tab"
            aria-selected={tab === 'search'}
            title="Search"
            onClick={() => setTab('search')}
          >
            <span className="explorer__tab-icon" aria-hidden="true">⌕</span>
            <span className="explorer__tab-label">Search</span>
          </button>
          <button
            className={tab === 'changes' ? 'explorer__tab explorer__tab--active' : 'explorer__tab'}
            type="button"
            role="tab"
            aria-selected={tab === 'changes'}
            title="Changes"
            onClick={() => setTab('changes')}
          >
            <span className="explorer__tab-icon" aria-hidden="true">⇄</span>
            <span className="explorer__tab-label">Changes</span>
          </button>
          <button
            className={tab === 'git' ? 'explorer__tab explorer__tab--active' : 'explorer__tab'}
            type="button"
            role="tab"
            aria-selected={tab === 'git'}
            title="Git"
            onClick={() => setTab('git')}
          >
            <span className="explorer__tab-icon" aria-hidden="true">⎇</span>
            <span className="explorer__tab-label">Git</span>
          </button>
        </div>
        <div className="workbench__sidebar-body">
          {tab === 'explorer' ? (
            <TreeNode path="" state={state} onToggle={handleToggle} onSelectFile={handleSelectFile} onAttachFile={handleAttachTreeFile} />
          ) : tab === 'search' ? (
            <SearchPanel
              key={workspaceId}
              workspaceId={workspaceId}
              onSelectResult={handleSelectSearchResult}
              onAttachResult={handleAttachSearchResult}
            />
          ) : tab === 'git' ? (
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
      </aside>
      <section className="workbench__editor" aria-label="Editor">
        <div className="workbench__editor-main">
        {gitDiff.relativePath !== null ? (
          <div className="workbench__editor-body">
            <EditorToolbar
              path={`Git diff · ${gitDiff.relativePath} · ${gitDiff.target === 'staged' ? 'Staged' : 'Working tree'}`}
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
        ) : changes.detail !== null ? (
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
        ) : changes.detailLoading ? (
          <p className="explorer__status explorer__status--centered" role="status">
            Loading change…
          </p>
        ) : changes.detailError !== null ? (
          <p className="explorer__error explorer__status--centered" role="alert">
            {changes.detailError}
          </p>
        ) : changeSets.setDetail !== null ? (
          <ChangeSetReview
            changeSet={changeSets.setDetail}
            onReviewFile={handleSelectTransaction}
            onClose={handleCloseChangeSet}
          />
        ) : changeSets.setDetailLoading ? (
          <p className="explorer__status explorer__status--centered" role="status">
            Loading change set…
          </p>
        ) : changeSets.setDetailError !== null ? (
          <p className="explorer__error explorer__status--centered" role="alert">
            {changeSets.setDetailError}
          </p>
        ) : state.preview === null ? (
          <div className="editor-empty" role="status" aria-label="No file selected">
            <StarkMark size="hero" />
            <p className="editor-empty__brand">{APP_NAME}</p>
            <p className="editor-empty__title">Select a file to open</p>
            <p className="editor-empty__hint">Open a file from the Explorer · attach context · ask STARK on the right</p>
          </div>
        ) : state.preview.loading ? (
          <p className="explorer__status explorer__status--centered" role="status">
            Loading…
          </p>
        ) : state.preview.error !== null ? (
          <p className="explorer__error explorer__status--centered" role="alert">
            {state.preview.error}
          </p>
        ) : editor !== null && state.preview.content !== null && state.preview.revision !== null ? (
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
        ) : (
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
        )}
        </div>
        <TerminalPanel key={`terminal:${workspaceId}`} workspaceId={workspaceId} />
      </section>
    </section>
  )
}
