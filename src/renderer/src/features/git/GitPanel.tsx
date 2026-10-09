import { useEffect, useReducer, useRef, type ReactElement } from 'react'
import type { GitFileStatus } from '../../../../shared/git/types'
import { StarkIcon } from '../../components/icons/StarkIcon'
import { getGitStatus } from '../../lib/git-api'
import { FILE_ICON_URLS } from '../explorer/fileIconAssets'
import { getFileIconKind } from '../explorer/fileIconForName'
import { gitPanelReducer, gitStatusLetter, initialGitPanelState, type GitStatusTone } from './git-state'
import './git.css'

interface GitPanelProps {
  readonly workspaceId: number
  readonly onSelectDiff: (relativePath: string, target: 'staged' | 'unstaged') => void
  readonly onOpenFile: (relativePath: string) => void
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'We couldn’t read Git status.'
}

function displayPath(entry: GitFileStatus): string {
  if (entry.originalPath !== null) {
    return `${entry.originalPath} → ${entry.relativePath}`
  }
  return entry.relativePath
}

function splitName(relativePath: string): { readonly name: string; readonly dir: string | null } {
  const slash = relativePath.lastIndexOf('/')
  if (slash === -1) {
    return { name: relativePath, dir: null }
  }
  return { name: relativePath.slice(slash + 1), dir: relativePath.slice(0, slash) }
}

function GitHeader({ loading, onRefresh }: { readonly loading: boolean; readonly onRefresh: () => void }): ReactElement {
  return (
    <div className="git-panel__header">
      <p className="git-panel__title">Git</p>
      <button
        className="git-panel__refresh"
        type="button"
        onClick={onRefresh}
        disabled={loading}
        aria-label="Refresh Git status"
        title="Refresh Git status"
      >
        <StarkIcon name="refresh" size={15} />
      </button>
    </div>
  )
}

function StatusMark({ tone, letter, label }: { readonly tone: GitStatusTone; readonly letter: string; readonly label: string }): ReactElement {
  return (
    <span className={`git-panel__status-mark git-panel__status-mark--${tone}`} aria-label={label} title={label}>
      {letter}
    </span>
  )
}

function FileRow({
  entry,
  side,
  actionLabel,
  onOpen
}: {
  readonly entry: GitFileStatus
  readonly side: 'staged' | 'working'
  readonly actionLabel: string
  readonly onOpen: () => void
}): ReactElement {
  const mark = gitStatusLetter({
    conflicted: entry.conflicted,
    untracked: entry.untracked,
    indexStatus: entry.indexStatus,
    worktreeStatus: entry.worktreeStatus,
    side
  })
  const renamed = entry.originalPath !== null
  const { name, dir } = splitName(entry.relativePath)
  return (
    <button
      className="git-panel__row"
      type="button"
      onClick={onOpen}
      aria-label={`${actionLabel} ${displayPath(entry)}`}
      title={displayPath(entry)}
    >
      <span className="git-panel__file-icon" aria-hidden="true">
        <img src={FILE_ICON_URLS[getFileIconKind(renamed ? entry.relativePath : name)]} alt="" draggable={false} />
      </span>
      <span className="git-panel__names">
        <span className="git-panel__name">{renamed ? displayPath(entry) : name}</span>
        {!renamed && dir !== null && <span className="git-panel__dir">{dir}</span>}
      </span>
      <StatusMark tone={mark.tone} letter={mark.letter} label={`${actionLabel} ${displayPath(entry)}`} />
    </button>
  )
}

/**
 * Read-only Git sidebar panel. Fetches explicitly (mount, Refresh,
 * workspace change) — never polls, never watches .git, no timers, no
 * network, no mutations. Rows are buttons (keyboard/touch accessible,
 * no hover needed) with no mutation controls. Untracked rows offer Open
 * file (existing Stage 6/10 read path via onOpenFile); staged/working
 * rows open a read-only patch via onSelectDiff.
 */
export function GitPanel({ workspaceId, onSelectDiff, onOpenFile }: GitPanelProps): ReactElement {
  const [state, dispatch] = useReducer(gitPanelReducer, workspaceId, (id) => ({
    ...initialGitPanelState(),
    workspaceId: id
  }))
  const requestIdRef = useRef(0)

  function fetchStatus(targetWorkspaceId: number): void {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    dispatch({ type: 'status-loading', workspaceId: targetWorkspaceId, requestId })
    getGitStatus(targetWorkspaceId).then(
      (data) => {
        if (requestIdRef.current !== requestId) {
          return
        }
        dispatch({ type: 'status-succeeded', workspaceId: data.kind === 'ready' ? data.workspaceId : targetWorkspaceId, requestId, data })
      },
      (error: unknown) => {
        if (requestIdRef.current !== requestId) {
          return
        }
        dispatch({ type: 'status-failed', workspaceId: targetWorkspaceId, requestId, message: toErrorMessage(error) })
      }
    )
  }

  useEffect(() => {
    dispatch({ type: 'workspace-changed', workspaceId })
    requestIdRef.current = 0
    fetchStatus(workspaceId)
    // Fetch once per workspace activation; Refresh re-fetches below.
  }, [workspaceId])

  function handleRefresh(): void {
    if (state.phase === 'loading') {
      return
    }
    fetchStatus(workspaceId)
  }

  if (state.phase === 'loading' || state.phase === 'idle') {
    return (
      <section className="git-panel" aria-label="Git">
        <GitHeader loading onRefresh={handleRefresh} />
        <p className="git-panel__status" role="status">
          Loading Git status…
        </p>
      </section>
    )
  }

  if (state.phase === 'error') {
    return (
      <section className="git-panel" aria-label="Git">
        <GitHeader loading={false} onRefresh={handleRefresh} />
        <p className="git-panel__error" role="alert">
          {state.error ?? 'We couldn’t read Git status.'}
        </p>
      </section>
    )
  }

  const data = state.data
  if (data === null) {
    return (
      <section className="git-panel" aria-label="Git">
        <GitHeader loading={false} onRefresh={handleRefresh} />
        <p className="git-panel__error" role="alert">
          We couldn’t read Git status.
        </p>
      </section>
    )
  }

  if (data.kind === 'unavailable') {
    return (
      <section className="git-panel" aria-label="Git">
        <GitHeader loading={false} onRefresh={handleRefresh} />
        <p className="git-panel__empty">Git is not available on this system.</p>
      </section>
    )
  }

  if (data.kind === 'not-repository') {
    return (
      <section className="git-panel" aria-label="Git">
        <GitHeader loading={false} onRefresh={handleRefresh} />
        <p className="git-panel__empty">No Git repository detected.</p>
      </section>
    )
  }

  if (data.kind === 'root-mismatch') {
    return (
      <section className="git-panel" aria-label="Git">
        <GitHeader loading={false} onRefresh={handleRefresh} />
        <p className="git-panel__empty">
          This folder is inside a Git repository. Open the repository root as the workspace to use Git integration.
        </p>
      </section>
    )
  }

  const branchLabel =
    data.branch.kind === 'branch'
      ? (data.branch.name ?? 'Branch')
      : data.branch.kind === 'detached'
        ? `Detached · ${data.branch.head ?? 'unknown'}`
        : 'No commits yet'
  const upstreamLine =
    data.branch.upstream === null ? (
      'Local branch · no upstream'
    ) : (
      <>
        {data.branch.upstream} · <span className="git-panel__counts">↑ {String(data.branch.ahead ?? 0)}</span>{' '}
        <span className="git-panel__counts">↓ {String(data.branch.behind ?? 0)}</span>
      </>
    )

  const conflicts = data.files.filter((entry) => entry.conflicted)
  const staged = data.files.filter((entry) => !entry.conflicted && entry.staged)
  const working = data.files.filter((entry) => !entry.conflicted && entry.unstaged)
  const untracked = data.files.filter((entry) => !entry.conflicted && entry.untracked)

  return (
    <section className="git-panel" aria-label="Git">
      <GitHeader loading={false} onRefresh={handleRefresh} />
      <div className="git-panel__branch-row">
        <span className="git-panel__branch-icon" aria-hidden="true">
          <StarkIcon name="git" size={14} />
        </span>
        <span className="git-panel__branch-name" title={branchLabel}>
          {branchLabel}
        </span>
      </div>
      <p className="git-panel__meta" title="Local refs only — Refresh never fetches">
        {upstreamLine}
      </p>
      {data.clean ? (
        <p className="git-panel__clean" role="status">
          <span className="git-panel__clean-icon" aria-hidden="true">
            <StarkIcon name="review" size={16} />
          </span>
          Working tree clean
        </p>
      ) : (
        <div className="git-panel__scroll">
          {conflicts.length > 0 && (
            <section className="git-panel__group" aria-label={`Conflicts, ${conflicts.length}`}>
              <div className="git-panel__group-head">
                <span className="git-panel__group-name">Conflicts</span>
                <span className="git-panel__group-count">{conflicts.length}</span>
              </div>
              <ul className="git-panel__list">
                {conflicts.map((entry) => (
                  <li key={`conflict:${entry.relativePath}`}>
                    <span className="git-panel__row git-panel__row--static" aria-label={`${displayPath(entry)} conflict`}>
                      <span className="git-panel__file-icon" aria-hidden="true">
                        <img src={FILE_ICON_URLS[getFileIconKind(entry.relativePath)]} alt="" draggable={false} />
                      </span>
                      <span className="git-panel__names">
                        <span className="git-panel__name">{displayPath(entry)}</span>
                      </span>
                      <StatusMark tone="conflict" letter="!" label={`${displayPath(entry)} conflict`} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {staged.length > 0 && (
            <section className="git-panel__group" aria-label={`Staged, ${staged.length}`}>
              <div className="git-panel__group-head">
                <span className="git-panel__group-name">Staged</span>
                <span className="git-panel__group-count">{staged.length}</span>
              </div>
              <ul className="git-panel__list">
                {staged.map((entry) => (
                  <li key={`staged:${entry.relativePath}`}>
                    <FileRow
                      entry={entry}
                      side="staged"
                      actionLabel="Staged diff"
                      onOpen={() => onSelectDiff(entry.relativePath, 'staged')}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {working.length > 0 && (
            <section className="git-panel__group" aria-label={`Modified, ${working.length}`}>
              <div className="git-panel__group-head">
                <span className="git-panel__group-name">Modified</span>
                <span className="git-panel__group-count">{working.length}</span>
              </div>
              <ul className="git-panel__list">
                {working.map((entry) => (
                  <li key={`working:${entry.relativePath}`}>
                    <FileRow
                      entry={entry}
                      side="working"
                      actionLabel="Working tree diff"
                      onOpen={() => onSelectDiff(entry.relativePath, 'unstaged')}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {untracked.length > 0 && (
            <section className="git-panel__group" aria-label={`Untracked, ${untracked.length}`}>
              <div className="git-panel__group-head">
                <span className="git-panel__group-name">Untracked</span>
                <span className="git-panel__group-count">{untracked.length}</span>
              </div>
              <ul className="git-panel__list">
                {untracked.map((entry) => (
                  <li key={`untracked:${entry.relativePath}`}>
                    <FileRow
                      entry={entry}
                      side="working"
                      actionLabel="Open untracked file"
                      onOpen={() => onOpenFile(entry.relativePath)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </section>
  )
}
