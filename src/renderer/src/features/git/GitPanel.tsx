import { useEffect, useReducer, useRef, type ReactElement } from 'react'
import type { GitFileStatus } from '../../../../shared/git/types'
import { getGitStatus } from '../../lib/git-api'
import { gitPanelReducer, gitStatusLabel, initialGitPanelState } from './git-state'
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

/**
 * Read-only Git sidebar panel. Fetches explicitly (mount, Refresh,
 * workspace change) — never polls, never watches .git, no timers.
 * Rows are buttons (keyboard/touch accessible, no hover needed) with
 * no mutation controls. Untracked rows offer Open file (existing
 * Stage 6/10 read path via onOpenFile); staged/working rows open a
 * read-only patch via onSelectDiff.
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
        <div className="git-panel__header">
          <p className="git-panel__title">Git</p>
        </div>
        <p className="git-panel__status" role="status">
          Loading Git status…
        </p>
      </section>
    )
  }

  if (state.phase === 'error') {
    return (
      <section className="git-panel" aria-label="Git">
        <div className="git-panel__header">
          <p className="git-panel__title">Git</p>
          <button className="explorer__secondary" type="button" onClick={handleRefresh}>
            Refresh
          </button>
        </div>
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
        <div className="git-panel__header">
          <p className="git-panel__title">Git</p>
          <button className="explorer__secondary" type="button" onClick={handleRefresh}>
            Refresh
          </button>
        </div>
        <p className="git-panel__error" role="alert">
          We couldn’t read Git status.
        </p>
      </section>
    )
  }

  if (data.kind === 'unavailable') {
    return (
      <section className="git-panel" aria-label="Git">
        <div className="git-panel__header">
          <p className="git-panel__title">Git</p>
          <button className="explorer__secondary" type="button" onClick={handleRefresh}>
            Refresh
          </button>
        </div>
        <p className="git-panel__empty">Git is not available on this system.</p>
      </section>
    )
  }

  if (data.kind === 'not-repository') {
    return (
      <section className="git-panel" aria-label="Git">
        <div className="git-panel__header">
          <p className="git-panel__title">Git</p>
          <button className="explorer__secondary" type="button" onClick={handleRefresh}>
            Refresh
          </button>
        </div>
        <p className="git-panel__empty">No Git repository detected.</p>
      </section>
    )
  }

  if (data.kind === 'root-mismatch') {
    return (
      <section className="git-panel" aria-label="Git">
        <div className="git-panel__header">
          <p className="git-panel__title">Git</p>
          <button className="explorer__secondary" type="button" onClick={handleRefresh}>
            Refresh
          </button>
        </div>
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
  const upstreamLabel =
    data.branch.upstream === null
      ? 'No upstream (local refs only — no network fetch).'
      : `${data.branch.upstream} · ↑ ${String(data.branch.ahead ?? 0)} ↓ ${String(data.branch.behind ?? 0)} (local refs only — no network fetch).`

  const conflicts = data.files.filter((entry) => entry.conflicted)
  const staged = data.files.filter((entry) => !entry.conflicted && entry.staged)
  const working = data.files.filter((entry) => !entry.conflicted && entry.unstaged)
  const untracked = data.files.filter((entry) => !entry.conflicted && entry.untracked)

  return (
    <section className="git-panel" aria-label="Git">
      <div className="git-panel__header">
        <p className="git-panel__title">Git</p>
        <button className="explorer__secondary" type="button" onClick={handleRefresh}>
          Refresh
        </button>
      </div>
      <p className="git-panel__branch">{branchLabel}</p>
      <p className="git-panel__meta">{upstreamLabel}</p>
      {data.clean ? (
        <p className="git-panel__empty">Working tree clean.</p>
      ) : (
        <>
          {conflicts.length > 0 && (
            <>
              <p className="git-panel__group-title">Conflicts</p>
              <ul className="git-panel__list">
                {conflicts.map((entry) => (
                  <li key={`conflict:${entry.relativePath}`}>
                    <span className="git-panel__row" aria-label={`${displayPath(entry)} conflict`}>
                      <span className="git-panel__path">{displayPath(entry)}</span>
                      <span className="git-panel__badge">Conflict</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {staged.length > 0 && (
            <>
              <p className="git-panel__group-title">Staged</p>
              <ul className="git-panel__list">
                {staged.map((entry) => (
                  <li key={`staged:${entry.relativePath}`}>
                    <button
                      className="git-panel__row"
                      type="button"
                      onClick={() => onSelectDiff(entry.relativePath, 'staged')}
                      aria-label={`Staged diff ${displayPath(entry)}`}
                    >
                      <span className="git-panel__path">{displayPath(entry)}</span>
                      <span className="git-panel__badge">
                        {gitStatusLabel({
                          staged: entry.staged,
                          unstaged: entry.unstaged,
                          untracked: entry.untracked,
                          conflicted: entry.conflicted,
                          indexStatus: entry.indexStatus,
                          worktreeStatus: entry.worktreeStatus
                        })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {working.length > 0 && (
            <>
              <p className="git-panel__group-title">Changes</p>
              <ul className="git-panel__list">
                {working.map((entry) => (
                  <li key={`working:${entry.relativePath}`}>
                    <button
                      className="git-panel__row"
                      type="button"
                      onClick={() => onSelectDiff(entry.relativePath, 'unstaged')}
                      aria-label={`Working tree diff ${displayPath(entry)}`}
                    >
                      <span className="git-panel__path">{displayPath(entry)}</span>
                      <span className="git-panel__badge">
                        {gitStatusLabel({
                          staged: entry.staged,
                          unstaged: entry.unstaged,
                          untracked: entry.untracked,
                          conflicted: entry.conflicted,
                          indexStatus: entry.indexStatus,
                          worktreeStatus: entry.worktreeStatus
                        })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {untracked.length > 0 && (
            <>
              <p className="git-panel__group-title">Untracked</p>
              <ul className="git-panel__list">
                {untracked.map((entry) => (
                  <li key={`untracked:${entry.relativePath}`}>
                    <button
                      className="git-panel__row"
                      type="button"
                      onClick={() => onOpenFile(entry.relativePath)}
                      aria-label={`Open untracked file ${displayPath(entry)}`}
                    >
                      <span className="git-panel__path">{displayPath(entry)}</span>
                      <span className="git-panel__badge">Untracked</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
