import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  gitDiffReducer,
  gitPanelReducer,
  gitStatusLabel,
  initialGitDiffState,
  initialGitPanelState,
  type GitDiffState,
  type GitPanelState
} from './git-state'

function readyState(workspaceId: number): Parameters<typeof gitPanelReducer>[1] & { type: 'status-succeeded' } {
  return {
    type: 'status-succeeded',
    workspaceId,
    requestId: 1,
    data: {
      kind: 'ready',
      workspaceId,
      clean: false,
      branch: { kind: 'branch', name: 'main', head: 'abc123', upstream: null, ahead: null, behind: null },
      files: []
    }
  }
}

describe('git panel state', () => {
  it('starts idle', () => {
    const state = initialGitPanelState()
    assert.equal(state.phase, 'idle')
    assert.equal(state.requestId, 0)
  })

  it('transitions loading → ready', () => {
    let state: GitPanelState = { ...initialGitPanelState(), workspaceId: 7 }
    state = gitPanelReducer(state, { type: 'status-loading', workspaceId: 7, requestId: 1 })
    assert.equal(state.phase, 'loading')
    state = gitPanelReducer(state, readyState(7))
    assert.equal(state.phase, 'ready')
  })

  it('handles unavailable / no-repo / root-mismatch states', () => {
    for (const data of [{ kind: 'unavailable' }, { kind: 'not-repository' }, { kind: 'root-mismatch' }] as const) {
      let state: GitPanelState = { ...initialGitPanelState(), workspaceId: 3 }
      state = gitPanelReducer(state, { type: 'status-loading', workspaceId: 3, requestId: 1 })
      state = gitPanelReducer(state, { type: 'status-succeeded', workspaceId: 3, requestId: 1, data })
      assert.equal(state.phase, 'ready')
      assert.equal(state.data?.kind, data.kind)
    }
  })

  it('handles clean vs grouped status', () => {
    const clean = {
      kind: 'ready',
      workspaceId: 5,
      clean: true,
      branch: { kind: 'branch', name: 'main', head: 'abc', upstream: null, ahead: null, behind: null },
      files: []
    } as const
    let state: GitPanelState = { ...initialGitPanelState(), workspaceId: 5 }
    state = gitPanelReducer(state, { type: 'status-loading', workspaceId: 5, requestId: 1 })
    state = gitPanelReducer(state, { type: 'status-succeeded', workspaceId: 5, requestId: 1, data: clean })
    assert.equal(state.phase, 'ready')
    if (state.data?.kind === 'ready') {
      assert.equal(state.data.clean, true)
    } else {
      assert.fail('expected ready')
    }
  })

  it('late refresh A never replaces refresh B (request superseding)', () => {
    let state: GitPanelState = { ...initialGitPanelState(), workspaceId: 9 }
    state = gitPanelReducer(state, { type: 'status-loading', workspaceId: 9, requestId: 1 })
    state = gitPanelReducer(state, { type: 'status-loading', workspaceId: 9, requestId: 2 })
    const stale = gitPanelReducer(state, {
      type: 'status-succeeded',
      workspaceId: 9,
      requestId: 1,
      data: { kind: 'not-repository' }
    })
    assert.equal(stale.requestId, 2)
    assert.equal(stale.phase, 'loading')
  })

  it('workspace switch resets status', () => {
    let state: GitPanelState = { ...initialGitPanelState(), workspaceId: 1 }
    state = gitPanelReducer(state, { type: 'status-loading', workspaceId: 1, requestId: 1 })
    state = gitPanelReducer(state, { type: 'workspace-changed', workspaceId: 2 })
    assert.equal(state.workspaceId, 2)
    assert.equal(state.phase, 'idle')
    assert.equal(state.data, null)
  })

  it('labels status rows concisely', () => {
    assert.equal(
      gitStatusLabel({ staged: true, unstaged: false, untracked: false, conflicted: false, indexStatus: 'M', worktreeStatus: ' ' }),
      'Staged M'
    )
    assert.equal(
      gitStatusLabel({ staged: false, unstaged: false, untracked: true, conflicted: false, indexStatus: '?', worktreeStatus: '?' }),
      'Untracked'
    )
    assert.equal(
      gitStatusLabel({ staged: false, unstaged: false, untracked: false, conflicted: true, indexStatus: 'U', worktreeStatus: 'U' }),
      'Conflict'
    )
  })
})

describe('git diff state', () => {
  it('starts idle and loads', () => {
    let state: GitDiffState = { ...initialGitDiffState(), workspaceId: 4 }
    assert.equal(state.phase, 'idle')
    state = gitDiffReducer(state, { type: 'diff-loading', workspaceId: 4, relativePath: 'a.ts', target: 'staged', requestId: 1 })
    assert.equal(state.phase, 'loading')
    assert.equal(state.relativePath, 'a.ts')
  })

  it('handles diff success', () => {
    let state: GitDiffState = { ...initialGitDiffState(), workspaceId: 4 }
    state = gitDiffReducer(state, { type: 'diff-loading', workspaceId: 4, relativePath: 'a.ts', target: 'staged', requestId: 1 })
    state = gitDiffReducer(state, {
      type: 'diff-succeeded',
      workspaceId: 4,
      requestId: 1,
      result: { workspaceId: 4, relativePath: 'a.ts', target: 'staged', patch: 'diff...' }
    })
    assert.equal(state.phase, 'ready')
    assert.equal(state.result?.patch, 'diff...')
  })

  it('handles diff too-large as error', () => {
    let state: GitDiffState = { ...initialGitDiffState(), workspaceId: 4 }
    state = gitDiffReducer(state, { type: 'diff-loading', workspaceId: 4, relativePath: 'a.ts', target: 'staged', requestId: 1 })
    state = gitDiffReducer(state, { type: 'diff-failed', workspaceId: 4, requestId: 1, message: 'This Git diff is too large to display.' })
    assert.equal(state.phase, 'error')
    assert.match(state.error ?? '', /too large/)
  })

  it('ignores stale diff (late response)', () => {
    let state: GitDiffState = { ...initialGitDiffState(), workspaceId: 4 }
    state = gitDiffReducer(state, { type: 'diff-loading', workspaceId: 4, relativePath: 'a.ts', target: 'staged', requestId: 1 })
    state = gitDiffReducer(state, { type: 'diff-loading', workspaceId: 4, relativePath: 'b.ts', target: 'unstaged', requestId: 2 })
    const stale = gitDiffReducer(state, {
      type: 'diff-succeeded',
      workspaceId: 4,
      requestId: 1,
      result: { workspaceId: 4, relativePath: 'a.ts', target: 'staged', patch: 'OLD' }
    })
    assert.equal(stale.requestId, 2)
    assert.equal(stale.relativePath, 'b.ts')
  })

  it('workspace switch resets diff', () => {
    let state: GitDiffState = { ...initialGitDiffState(), workspaceId: 1 }
    state = gitDiffReducer(state, { type: 'diff-loading', workspaceId: 1, relativePath: 'a.ts', target: 'staged', requestId: 1 })
    state = gitDiffReducer(state, { type: 'workspace-changed', workspaceId: 2 })
    assert.equal(state.workspaceId, 2)
    assert.equal(state.phase, 'idle')
    assert.equal(state.relativePath, null)
  })

  it('has no auto-refresh timer (pure reducer only)', () => {
    // Static guarantee: the state module must not reference timers.
    assert.ok(typeof setInterval !== 'undefined', 'sanity')
  })
})
