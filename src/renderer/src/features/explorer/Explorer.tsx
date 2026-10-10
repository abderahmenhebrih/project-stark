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
import { formatDocumentWithPrettier } from '../../lib/format-api'
import { normalizeFormatterError } from '../../lib/format-error'
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
import { CodeEditor, type EditorSelection, type ExtensionMarker } from '../editor/CodeEditor'
import { EditorToolbar } from '../editor/EditorToolbar'
import { buildDocumentUri } from '../editor/editor-document'
import { classifyEol, isEditableEol, MIXED_EOL_MESSAGE } from '../editor/editor-eol'
import { toEditorFocus, type EditorFocus } from '../editor/editor-focus'
import { detectEditorLanguageWithOverrides } from '../editor/editor-language'
import {
  fireExtensionTrigger,
  getExtensionDiagnostics,
  onExtensionManagementEvent,
  pushExtensionDocumentEvent,
  setExtensionActiveEditor,
  setExtensionWorkspaceFolders
} from '../../lib/stark-api'
import { fetchIconThemeCached, fetchLanguageOverrides, resolveTreeFileIcon, type IconThemeSnapshot } from '../extensions/extension-language-bridge'
import { extensionDocUri, requestExtensionTrust, EXTENSION_DOC_SYNC_DEBOUNCE_MS } from '../extensions/extension-trust-bus'
import { getSelectedExtensionThemes } from '../../lib/stark-api'
import { GitDiffViewer } from '../git/GitDiffViewer'
import { GitPanel } from '../git/GitPanel'
import { gitDiffReducer, initialGitDiffState } from '../git/git-state'
import { SearchPanel } from '../search/SearchPanel'
import { ExtensionsPanel } from '../extensions/ExtensionsPanel'
import type { SessionContextDraftAction } from '../sessions/session-context-state'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { confirmDiscardUnsavedDraft, setUnsavedDraft } from './editor-guard'
import { clampSplitPct, splitBounds } from './split-bounds'
import { subscribeFormatRequests } from '../extensions/format-request-bus'
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
  /** Selected Explorer icon theme (null = STARK default glyphs). */
  readonly fileIconTheme?: IconThemeSnapshot | null
}

function TreeNode({ path, state, onToggle, onSelectFile, onAttachFile, fileIconTheme = null }: TreeNodeProps): ReactElement | null {
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
                <span className="explorer__chevron explorer__chevron--spacer" aria-hidden="true" />
                <span className="explorer__file-icon" aria-hidden="true">
                  <img src={resolveTreeFileIcon(entry.name, fileIconTheme) ?? FILE_ICON_URLS[getFileIconKind(entry.name)]} alt="" draggable={false} />
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
              <TreeNode path={entry.relativePath} state={state} onToggle={onToggle} onSelectFile={onSelectFile} onAttachFile={onAttachFile} fileIconTheme={fileIconTheme} />
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
  readonly workspaceName: string
  readonly workspaceRootPath: string
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
 * directories load only when expanded, files open directly editable
 * in a local Monaco editor (VS Code-style: place the cursor and
 * type — no Edit button, no read-only step). Typing edits a volatile
 * draft only (Review change → Accept/Reject): no autosave, no
 * formatting, no direct disk writes. Reviewing a draft persists a
 * pending change transaction (disk untouched); only Accept flows
 * through the Stage 8 writer, and only Rollback restores the
 * checkpoint. Uniform LF/CRLF endings are preserved; mixed-ending
 * files stay read-only. The Git tab is
 * read-only awareness (branch/status/diff, explicit Refresh only, no
 * polling); selecting a staged/working row opens its patch in the
 * secondary pane via a read-only Monaco viewer, and Open file reuses
 * the existing file read path. Explicit chat context attaches only on
 * visible actions (editor right-click menu, tree Attach, search
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
  workspaceName,
  workspaceRootPath,
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
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [focusRequest, setFocusRequest] = useState<EditorFocus | null>(null)
  // Latest Monaco cursor selection for context attach. Cleared on
  // every file change; dirty-draft selections are excluded from
  // excerpt attach because line numbers may no longer match disk
  // (main re-reads at send time).
  const [editorSelection, setEditorSelection] = useState<EditorSelection | null>(null)
  // VS Code-style root row: collapsing hides the whole tree below it.
  // Workspace switching stays on the AppChrome project button.
  const [rootCollapsed, setRootCollapsed] = useState(false)
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
  // Document formatting (generic activation): explicit user action only.
  // Trust is generic and session-scoped (asked once per extension per
  // mount, never persisted): before executing an extension for the
  // first time in the session, STARK shows "STARK is about to run
  // <Extension Name>." plus the code-execution risk. Busy/error/notice
  // are renderer-local; the file itself is never written here —
  // results become reviewable change transactions.
  const [trustedExtensions, setTrustedExtensions] = useState<readonly string[]>([])
  const [formatTrustOpen, setFormatTrustOpen] = useState(false)
  const [formatTrustExtensionName, setFormatTrustExtensionName] = useState('Prettier')
  const [formatBusy, setFormatBusy] = useState(false)
  const [formatNotice, setFormatNotice] = useState<string | null>(null)
  // Generic extension runtime sync (Steps 8+9): contributed language
  // detection, host document snapshots, active-editor tracking,
  // demand-driven language triggers, and editor diagnostics. All
  // renderer-owned facts pushed through the narrow bridge; failures
  // degrade to a standalone editor (never errors, never retries).
  const [languageOverrides, setLanguageOverrides] = useState<Readonly<Record<string, string>> | null>(null)
  const [fileIconTheme, setFileIconTheme] = useState<IconThemeSnapshot | null>(null)
  const [extDiagnostics, setExtDiagnostics] = useState<{ uri: string | null; markers: readonly ExtensionMarker[] }>({ uri: null, markers: [] })
  const openDocUriRef = useRef<string | null>(null)
  const openDocVersionRef = useRef(1)
  // Latest requested preview path: late file-read arrivals for a
  // deselected file (superseded selection, or pane X during load)
  // must not resurrect an editor for it.
  const previewPathRef = useRef<string | null>(null)
  const docSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workspaceTriggeredRef = useRef(false)
  // Latest format handler for Command Palette requests (the palette
  // lives at the app root; the open file lives here).
  const formatRequestRef = useRef<() => void>(() => {})

  const refreshFileDiagnostics = useCallback((uri: string): void => {
    getExtensionDiagnostics(uri).then(
      (diagnostics) => {
        if (openDocUriRef.current !== uri) {
          return
        }
        setExtDiagnostics({
          uri,
          markers: diagnostics.slice(0, 2000).map((diagnostic) => ({
            startLineNumber: diagnostic.range.start.line + 1,
            startColumn: diagnostic.range.start.character + 1,
            endLineNumber: diagnostic.range.end.line + 1,
            endColumn: Math.max(1, diagnostic.range.end.character + 1),
            severity: diagnostic.severity,
            message: diagnostic.message
          }))
        })
      },
      () => {}
    )
  }, [])

  // Publish the derived dirty flag so file selection, search-result
  // selection, and workspace switching share one discard guard.
  useEffect(() => {
    setUnsavedDraft(editor !== null && isEditorDirty(editor))
    return () => {
      setUnsavedDraft(false)
    }
  }, [editor])

  // Command Palette "Format Document" reaches the open file here:
  // the ref always points at the latest handler (current preview,
  // draft, and trust state); delivery itself is a no-op when nothing
  // is open. Subscribed once, unsubscribed on unmount.
  useEffect(() => {
    formatRequestRef.current = () => {
      handleFormatRequest()
    }
  })
  useEffect(() => subscribeFormatRequests(() => formatRequestRef.current()), [])

  // Window resize keeps the percentage split (ratio preserved by the
  // flex-basis itself) and re-clamps it when the row becomes too
  // narrow, so the row can never overflow horizontally. Listener is
  // added only while a split exists and always removed on cleanup.
  useEffect(() => {
    if (secondaryUi.splitPct === null) {
      return
    }
    const onWindowResize = (): void => {
      const root = workareaRef.current
      if (root === null) {
        return
      }
      const row = root.querySelector('.workspace__session')
      if (!(row instanceof HTMLElement) || row.clientWidth <= 0) {
        return
      }
      const clamped = clampSplitPct(secondaryUi.splitPct ?? 45, row.clientWidth)
      if (clamped !== secondaryUi.splitPct) {
        secondaryUiDispatch({ type: 'set-split', pct: clamped })
      }
    }
    window.addEventListener('resize', onWindowResize)
    return () => {
      window.removeEventListener('resize', onWindowResize)
    }
  }, [secondaryUi.splitPct])

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

  // Contributed languages + selected icon theme (session-cached).
  useEffect(() => {
    let cancelled = false
    fetchLanguageOverrides().then(
      (overrides) => {
        if (!cancelled) {
          setLanguageOverrides(overrides)
        }
      },
      () => {}
    )
    getSelectedExtensionThemes().then(
      (selected) => {
        if (cancelled || selected.icon === null) {
          return
        }
        void fetchIconThemeCached(selected.icon).then(
          (theme) => {
            if (!cancelled) {
              setFileIconTheme(theme)
            }
          },
          () => {}
        )
      },
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [])

  // Workspace folders for extensions (renderer-owned fact, main
  // re-validates the directory before the host ever sees it).
  useEffect(() => {
    setExtensionWorkspaceFolders([{ uri: `file:${workspaceRootPath}`, name: workspaceName }]).then(
      () => {},
      () => {}
    )
  }, [workspaceId, workspaceRootPath, workspaceName])

  // Workspace trigger (once per workspace): main lists the root and
  // considers workspaceContains candidates; untrusted ones surface
  // as trust requests instead of auto-running.
  useEffect(() => {
    if (workspaceTriggeredRef.current) {
      return
    }
    workspaceTriggeredRef.current = true
    fireExtensionTrigger({ kind: 'workspace' }).then(
      (outcome) => {
        for (const id of outcome.needsTrust) {
          const at = id.lastIndexOf('@')
          const head = id.slice(0, at)
          const dot = head.indexOf('.')
          requestExtensionTrust({
            namespace: head.slice(0, dot),
            name: head.slice(dot + 1),
            version: id.slice(at + 1),
            displayName: head
          })
        }
      },
      () => {}
    )
  }, [workspaceId])

  const previewSyncPath = state.preview?.path ?? null
  const previewSyncContent = state.preview?.content ?? null
  const previewSyncRevision = state.preview?.revision ?? null
  const previewLanguageId = previewSyncPath === null ? null : detectEditorLanguageWithOverrides(previewSyncPath, languageOverrides)

  // Host document sync for the open file: opened on selection,
  // closed on navigation, plus active-editor tracking.
  useEffect(() => {
    const previous = openDocUriRef.current
    if (previous !== null) {
      openDocUriRef.current = null
      pushExtensionDocumentEvent({ kind: 'closed', uri: previous }).then(
        () => {},
        () => {}
      )
    }
    if (previewSyncPath === null || previewSyncContent === null) {
      setExtensionActiveEditor(null).then(
        () => {},
        () => {}
      )
      return
    }
    const uri = extensionDocUri(previewSyncPath)
    openDocUriRef.current = uri
    openDocVersionRef.current = 1
    const languageId = detectEditorLanguageWithOverrides(previewSyncPath, languageOverrides)
    pushExtensionDocumentEvent({ kind: 'opened', uri, languageId, text: previewSyncContent, version: 1 }).then(
      () => refreshFileDiagnostics(uri),
      () => {}
    )
    setExtensionActiveEditor({ uri, languageId }).then(
      () => {},
      () => {}
    )
  }, [workspaceId, previewSyncPath, previewSyncRevision, previewSyncContent, languageOverrides, refreshFileDiagnostics])

  // Demand-driven language trigger (separate effect so late-arriving
  // contributed-language overrides still fire correctly).
  useEffect(() => {
    if (previewLanguageId === null) {
      return
    }
    fireExtensionTrigger({ kind: 'language', value: previewLanguageId }).then(
      (outcome) => {
        for (const id of outcome.needsTrust) {
          const at = id.lastIndexOf('@')
          const head = id.slice(0, at)
          const dot = head.indexOf('.')
          requestExtensionTrust({
            namespace: head.slice(0, dot),
            name: head.slice(dot + 1),
            version: id.slice(at + 1),
            displayName: head
          })
        }
      },
      () => {}
    )
  }, [workspaceId, previewSyncPath, previewLanguageId])

  // Extension diagnostics follow host pushes for the open file.
  useEffect(() => {
    return onExtensionManagementEvent((event) => {
      if (event.kind === 'diagnostics' && openDocUriRef.current !== null) {
        refreshFileDiagnostics(openDocUriRef.current)
      }
    })
  }, [refreshFileDiagnostics])

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
    previewPathRef.current = path
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
      (file) => {
        dispatch({
          type: 'file-loaded',
          workspaceId: file.workspaceId,
          path: file.relativePath,
          content: file.content,
          revision: file.revision
        })
        // Files open directly editable: enter edit state immediately
        // for uniform line endings (same state the Edit button used to
        // create). Mixed-ending files keep the read-only viewer. Late
        // arrivals for a deselected file are ignored, matching the
        // reducer's stale guard.
        if (file.relativePath === previewPathRef.current && isEditableEol(classifyEol(file.content))) {
          setEditor(createEditorState(file.content, file.revision))
        }
      },
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
    onActivityChange('explorer')
    secondaryUiDispatch({ type: 'open-tab', tab: 'file' })
    onCanvasViewChange('editor')
    loadPreviewFile(relativePath)
  }

  function handleSelectSearchResult(path: string, line: number, column: number): void {
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
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
    // Excerpt attach tracks the visible selection, which matches disk
    // only while the draft is clean — dirty selections stay disabled.
    if (preview === null || editorSelection === null || (editor !== null && isEditorDirty(editor))) {
      return
    }
    const lineStart = Math.min(editorSelection.startLineNumber, editorSelection.endLineNumber)
    const lineEnd = Math.max(editorSelection.startLineNumber, editorSelection.endLineNumber)
    handleAttachDraft(prepareContextExcerpt({ workspaceId, relativePath: preview.path, lineStart, lineEnd }))
  }

  function handleAttachPreviewFile(): void {
    const preview = state.preview
    if (preview === null) {
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

  function handleMonacoChange(value: string): void {
    setEditor((current) => (current === null ? current : applyDraftChange(current, value)))
    // Extension document sync (debounced trailing): the host snapshot
    // follows local edits so providers and diagnostics stay current.
    const uri = openDocUriRef.current
    if (uri === null) {
      return
    }
    if (docSyncTimerRef.current !== null) {
      clearTimeout(docSyncTimerRef.current)
    }
    docSyncTimerRef.current = setTimeout(() => {
      openDocVersionRef.current += 1
      pushExtensionDocumentEvent({ kind: 'changed', uri, text: value, version: openDocVersionRef.current }).then(
        () => refreshFileDiagnostics(uri),
        () => {}
      )
    }, EXTENSION_DOC_SYNC_DEBOUNCE_MS)
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
      // Disk is untouched by the proposal, so the file tab keeps a
      // clean editable draft of the same content when the user returns.
      if (preview.content !== null && preview.revision !== null && isEditableEol(classifyEol(preview.content))) {
        setEditor(createEditorState(preview.content, preview.revision))
      } else {
        setEditor(null)
      }
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

  /**
   * Standard editor save gesture (Ctrl+S in the open file): opens the
   * EXISTING Review change flow for dirty files — never a direct disk
   * write. Clean files safely no-op without creating a transaction.
   */
  function handleSaveGesture(): void {
    if (editor === null || !isEditorDirty(editor) || editor.saving) {
      return
    }
    void handleReviewChange()
  }

  /**
   * Format Document (generic activation): explicit user action on the
   * open file. First execution per extension per mount asks
   * the generic trust question ("STARK is about to run <Extension
   * Name>."); the file is never written here. Main returns the
   * snapshot revision it formatted plus formatted text; a mismatch
   * with the click-time revision rejects as stale, identical output
   * reports "already formatted", and anything else becomes a
   * reviewable change transaction (Accept writes, Reject discards).
   */
  function handleFormatRequest(): void {
    const preview = state.preview
    // Format runs against disk state, so it is available only while
    // the draft is clean — unsaved edits must be reviewed or
    // discarded first.
    if (
      preview === null ||
      preview.content === null ||
      preview.revision === null ||
      formatBusy
    ) {
      return
    }
    if (editor !== null && isEditorDirty(editor)) {
      setFormatNotice('Review or discard your unsaved changes before formatting.')
      return
    }
    setFormatNotice(null)
    // Generic trust key for the formatter extension (stable across
    // versions; session-only). Future extensions use their own keys.
    const trustKey = 'esbenp.prettier-vscode'
    setFormatTrustExtensionName('Prettier')
    if (!trustedExtensions.includes(trustKey)) {
      setFormatTrustOpen(true)
      return
    }
    void runFormatDocument(preview.path, preview.revision, preview.content)
  }

  function handleFormatTrustCancel(): void {
    setFormatTrustOpen(false)
  }

  function handleFormatTrustConfirm(): void {
    const preview = state.preview
    if (
      preview === null ||
      preview.content === null ||
      preview.revision === null ||
      formatBusy
    ) {
      setFormatTrustOpen(false)
      return
    }
    if (editor !== null && isEditorDirty(editor)) {
      setFormatTrustOpen(false)
      setFormatNotice('Review or discard your unsaved changes before formatting.')
      return
    }
    const trustKey = 'esbenp.prettier-vscode'
    setTrustedExtensions((trusted) => (trusted.includes(trustKey) ? trusted : [...trusted, trustKey]))
    void runFormatDocument(preview.path, preview.revision, preview.content)
  }

  async function runFormatDocument(relativePath: string, startedRevision: string, startedContent: string): Promise<void> {
    setFormatTrustOpen(false)
    setFormatBusy(true)
    // Transient busy copy in the notice line (cleared below unless an
    // outcome overwrote it).
    setFormatNotice('Formatting…')
    try {
      let result: { revision: string; afterText: string }
      try {
        result = await formatDocumentWithPrettier(workspaceId, relativePath)
      } catch (error: unknown) {
        setFormatNotice(normalizeFormatterError(error).message)
        return
      }
      // Stale protection: main formats the revision it just read. If
      // the click-time revision differs, the file moved under us —
      // never propose onto newer content.
      if (result.revision !== startedRevision) {
        setFormatNotice('This file changed on disk. Reload it before saving your changes.')
        return
      }
      if (result.afterText === startedContent) {
        setFormatNotice('Already formatted.')
        return
      }
      try {
        const transaction = await createFileChange({
          workspaceId,
          relativePath,
          expectedRevision: result.revision,
          proposedContent: result.afterText
        })
        changesDispatch({ type: 'review-opened', transaction })
        secondaryUiDispatch({ type: 'open-tab', tab: 'review' })
        void refreshHistory()
      } catch (error: unknown) {
        setFormatNotice(normalizeChangeTransactionError(error).message)
      }
    } finally {
      setFormatBusy(false)
      setFormatNotice((current) => (current === 'Formatting…' ? null : current))
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
      if (file !== undefined && file.binaryImport !== undefined) {
        // Binary ADD: refresh the exact affected parent directory. The
        // stored proposed content is a review manifest — never load it
        // into the editor.
        void loadDirectory(transaction.workspaceId, parentDirectoryOf(file.relativePath))
      } else if (file !== undefined && file.appliedRevision !== null) {
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

  /** Parent directory of a `/`-separated destination (`''` for the root). Pure and total. */
  function parentDirectoryOf(relativePath: string): string {
    const slash = relativePath.lastIndexOf('/')
    return slash === -1 ? '' : relativePath.slice(0, slash)
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
      if (file !== undefined && file.binaryImport !== undefined) {
        // Binary rollback restores the absent checkpoint: refresh the
        // exact affected parent directory instead of loading content.
        void loadDirectory(transaction.workspaceId, parentDirectoryOf(file.relativePath))
      } else if (file !== undefined) {
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
    // Unsaved human edits are never silently discarded: declining
    // keeps the file open (same guard as every other navigation).
    if (!confirmDiscardUnsavedDraft()) {
      return
    }
    if (terminalOpen) {
      onToggleTerminal()
    }
    secondaryUiDispatch({ type: 'unpin-context' })
    handleCloseGitDiff()
    handleCloseReview()
    handleCloseChangeSet()
    // Clear the active file/editor so the secondary pane unmounts and
    // the layout returns to the Session-only view. Workspace, tree,
    // session, and disk files are untouched — presentation only.
    previewPathRef.current = null
    dispatch({ type: 'preview-cleared' })
    setEditor(null)
    setEditorSelection(null)
    setFocusRequest(null)
  }

  function handleResizeStart(event: React.PointerEvent): void {
    if (event.button !== 0) {
      return
    }
    draggingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  /** Measured width of the Session | secondary flex row (0 when hidden). */
  function measureSplitRow(): number {
    const root = workareaRef.current
    if (root === null) {
      return 0
    }
    const row = root.querySelector('.workspace__session')
    if (row instanceof HTMLElement && row.clientWidth > 0) {
      return row.clientWidth
    }
    return 0
  }

  function handleResizeMove(event: React.PointerEvent): void {
    if (!draggingRef.current) {
      return
    }
    const root = workareaRef.current
    if (root === null) {
      return
    }
    const row = root.querySelector('.workspace__session')
    if (!(row instanceof HTMLElement)) {
      return
    }
    const rect = row.getBoundingClientRect()
    if (rect.width <= 0) {
      return
    }
    // Continuous percentage — never snapped to presets — clamped to
    // the pixel minimums of the measured row.
    const pct = ((event.clientX - rect.left) / rect.width) * 100
    secondaryUiDispatch({ type: 'set-split', pct: clampSplitPct(pct, rect.width) })
  }

  function handleResizeEnd(): void {
    draggingRef.current = false
  }

  function handleResizeKey(event: React.KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }
    event.preventDefault()
    const base = secondaryUi.splitPct ?? 45
    const next = event.key === 'ArrowLeft' ? base - 2 : base + 2
    secondaryUiDispatch({ type: 'set-split', pct: clampSplitPct(next, measureSplitRow()) })
  }

  const dirty = editor !== null && isEditorDirty(editor)
  const previewContent = state.preview?.content ?? null
  const previewEol = useMemo(
    () => (previewContent === null ? null : classifyEol(previewContent)),
    [previewContent]
  )
  const previewEditable = previewEol !== null && isEditableEol(previewEol)
  // Diagnostics follow the open file only: stale markers from a
  // previous document never render (derived during render, no effect).
  const openDocUriForView = state.preview === null ? null : extensionDocUri(state.preview.path)
  const visibleExtDiagnostics = extDiagnostics.uri !== null && extDiagnostics.uri === openDocUriForView ? extDiagnostics.markers : []

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
    const base = fileBasename(state.preview?.path ?? '')
    // Subtle dirty dot on the file tab — the only dirty indication.
    tabs.push({ kind: 'file', label: dirty ? `${base} ●` : base })
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
      // No file action toolbar: Monaco begins directly beneath the tab
      // strip. Typing edits the volatile draft; Ctrl+S opens the
      // existing review flow; Format / Attach live in the editor
      // right-click menu. Review-before-write is unchanged.
      const fileMenuActions = [
        { id: 'stark.formatDocument', label: 'Format Document', run: () => handleFormatRequest() },
        { id: 'stark.attachSelection', label: 'Attach selection', run: () => handleAttachPreviewSelection() },
        { id: 'stark.attachFile', label: 'Attach file', run: () => handleAttachPreviewFile() }
      ]
      return (
        <div className="workbench__editor-body">
          {editor.saveError !== null && (
            <p className="explorer__error explorer__inline-alert" role="alert">
              {editor.saveError}
            </p>
          )}
          {formatTrustOpen && (
            <div className="explorer__inline-alert explorer__confirm" role="alertdialog" aria-label={`Run ${formatTrustExtensionName} in the Extension Host?`}>
              <p className="explorer__confirm-title">STARK is about to run {formatTrustExtensionName} in the Extension Host.</p>
              <p className="explorer__confirm-copy">VS Code extensions can execute code on your computer.</p>
              <div className="explorer__confirm-actions">
                <button className="explorer__secondary" type="button" onClick={handleFormatTrustCancel}>
                  Cancel
                </button>
                <button className="explorer__primary" type="button" onClick={handleFormatTrustConfirm}>
                  Run {formatTrustExtensionName}
                </button>
              </div>
            </div>
          )}
          {formatNotice !== null && !formatTrustOpen && (
            <p className="explorer__status explorer__inline-alert" role="status">
              {formatNotice}
            </p>
          )}
          <div className="editor-canvas">
            <CodeEditor
              key={`edit:${workspaceId}:${state.preview.path}:${state.preview.revision}`}
              documentUri={buildDocumentUri(workspaceId, state.preview.path)}
              language={detectEditorLanguageWithOverrides(state.preview.path, languageOverrides)}
              initialValue={editor.draftContent}
              eol={previewEol === 'crlf' ? 'CRLF' : 'LF'}
              readOnly={false}
              focusRequest={focusRequest}
              onContentChange={handleMonacoChange}
              onSelectionChange={setEditorSelection}
              onSaveRequest={handleSaveGesture}
              menuActions={fileMenuActions}
              ariaLabel="File editor"
              extensionDiagnostics={visibleExtDiagnostics}
              extensionFilePath={state.preview.path}
            />
          </div>
        </div>
      )
    }
    // Mixed-ending files (and any loaded preview without a draft)
    // stay read-only with no editing affordances.
    return (
      <div className="workbench__editor-body">
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
              language={detectEditorLanguageWithOverrides(state.preview.path, languageOverrides)}
              initialValue={state.preview.content}
              eol={previewEol === 'crlf' ? 'CRLF' : 'LF'}
              readOnly
              focusRequest={focusRequest}
              onSelectionChange={setEditorSelection}
              ariaLabel="File preview"
              extensionDiagnostics={visibleExtDiagnostics}
              extensionFilePath={state.preview.path}
            />
          </div>
        )}
      </div>
    )
  }

  // Directory chevrons resolve per expanded state via the drawer tree.
  return (
    <div ref={workareaRef} className="workspace" data-canvas-view={canvasView}>
      <WorkspaceToolsDrawer open={sidebarOpen} activity={activity} onActivityChange={onActivityChange} onClose={onCloseSidebar} terminalOpen={terminalOpen} onToggleTerminal={onToggleTerminal}>
        <div className="workbench__sidebar-body">
          {activity === 'explorer' ? (
            <>
              <button
                className="explorer__root"
                type="button"
                aria-expanded={!rootCollapsed}
                aria-label={`Project root ${workspaceName}`}
                title={workspaceRootPath}
                onClick={() => setRootCollapsed((collapsed) => !collapsed)}
              >
                <span className="explorer__chevron" aria-hidden="true">
                  <StarkIcon name={rootCollapsed ? 'chevron-right' : 'chevron-down'} size={13} />
                </span>
                <span className="explorer__folder-icon" aria-hidden="true">
                  <img src={rootCollapsed ? FOLDER_ICON_URL : FOLDER_OPEN_ICON_URL} alt="" draggable={false} />
                </span>
                <span className="explorer__root-name">{workspaceName}</span>
              </button>
              {!rootCollapsed && (
                <TreeNode path="" state={state} onToggle={handleToggle} onSelectFile={handleSelectFile} onAttachFile={handleAttachTreeFile} fileIconTheme={fileIconTheme} />
              )}
            </>
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
          ) : activity === 'extensions' ? (
            <ExtensionsPanel workspaceId={workspaceId} rootPath={workspaceRootPath} />
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
        <div
          className="session-frame"
          style={
            secondaryUi.splitPct !== null
              ? { flexGrow: 0, flexBasis: `${secondaryUi.splitPct}%` }
              : undefined
          }
        >
          {sessionNode}
        </div>
        {secondaryOpen && (
          <div
            className="workspace__resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize session and workspace panes"
            aria-valuenow={Math.round(secondaryUi.splitPct ?? 45)}
            aria-valuemin={Math.round(splitBounds(measureSplitRow()).min)}
            aria-valuemax={Math.round(splitBounds(measureSplitRow()).max)}
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
            style={
              secondaryUi.splitPct !== null
                ? { flexGrow: 0, flexBasis: `${100 - secondaryUi.splitPct}%` }
                : undefined
            }
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
