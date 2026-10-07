import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WorkspaceSearchResult } from '../../../../shared/workspace-search/types'
import { initialSearchState, searchPanelReducer } from './search-state'

function sampleResult(workspaceId: number, query: string): WorkspaceSearchResult {
  return {
    workspaceId,
    query,
    matches: [{ relativePath: 'a.txt', line: 2, column: 4, preview: 'hello authentication' }],
    filesScanned: 3,
    filesMatched: 1,
    truncated: false
  }
}

describe('search panel state', () => {
  it('submit enters loading state', () => {
    const start = { ...initialSearchState(), workspaceId: 4 }
    const loading = searchPanelReducer(start, {
      type: 'search-started',
      workspaceId: 4,
      query: 'auth',
      caseSensitive: false,
      requestId: 1
    })
    assert.equal(loading.loading, true)
    assert.equal(loading.query, 'auth')
    assert.equal(loading.requestId, 1)
    assert.equal(loading.submitted, true)
    assert.deepEqual(loading.matches, [])
  })

  it('successful search stores results and truncation', () => {
    const start = { ...initialSearchState(), workspaceId: 4 }
    const loading = searchPanelReducer(start, {
      type: 'search-started',
      workspaceId: 4,
      query: 'auth',
      caseSensitive: false,
      requestId: 1
    })
    const done = searchPanelReducer(loading, {
      type: 'search-succeeded',
      workspaceId: 4,
      requestId: 1,
      result: { ...sampleResult(4, 'auth'), truncated: true }
    })
    assert.equal(done.loading, false)
    assert.equal(done.matches.length, 1)
    assert.equal(done.truncated, true)
    assert.equal(done.filesScanned, 3)
  })

  it('empty search result state is clean', () => {
    const start = { ...initialSearchState(), workspaceId: 4 }
    const loading = searchPanelReducer(start, {
      type: 'search-started',
      workspaceId: 4,
      query: 'missing-xyz',
      caseSensitive: false,
      requestId: 1
    })
    const done = searchPanelReducer(loading, {
      type: 'search-succeeded',
      workspaceId: 4,
      requestId: 1,
      result: { workspaceId: 4, query: 'missing-xyz', matches: [], filesScanned: 2, filesMatched: 0, truncated: false }
    })
    assert.deepEqual(done.matches, [])
    assert.equal(done.filesMatched, 0)
    assert.equal(done.error, null)
  })

  it('new search supersedes an old search in flight', () => {
    const start = { ...initialSearchState(), workspaceId: 4 }
    const first = searchPanelReducer(start, {
      type: 'search-started',
      workspaceId: 4,
      query: 'first',
      caseSensitive: false,
      requestId: 1
    })
    const second = searchPanelReducer(first, {
      type: 'search-started',
      workspaceId: 4,
      query: 'second',
      caseSensitive: false,
      requestId: 2
    })
    assert.equal(second.query, 'second')
    const lateFirst = searchPanelReducer(second, {
      type: 'search-succeeded',
      workspaceId: 4,
      requestId: 1,
      result: sampleResult(4, 'first')
    })
    assert.equal(lateFirst.query, 'second')
    assert.deepEqual(lateFirst.matches, [])
    const onTime = searchPanelReducer(lateFirst, {
      type: 'search-succeeded',
      workspaceId: 4,
      requestId: 2,
      result: sampleResult(4, 'second')
    })
    assert.equal(onTime.matches.length, 1)
    assert.equal(onTime.query, 'second')
  })

  it('workspace change clears and invalidates search', () => {
    const start = { ...initialSearchState(), workspaceId: 4 }
    const loaded = searchPanelReducer(
      searchPanelReducer(start, {
        type: 'search-started',
        workspaceId: 4,
        query: 'auth',
        caseSensitive: false,
        requestId: 1
      }),
      { type: 'search-succeeded', workspaceId: 4, requestId: 1, result: sampleResult(4, 'auth') }
    )
    assert.equal(loaded.matches.length, 1)
    const next = searchPanelReducer(loaded, { type: 'workspace-changed', workspaceId: 7 })
    assert.equal(next.workspaceId, 7)
    assert.deepEqual(next.matches, [])
    assert.equal(next.loading, false)
    assert.equal(next.submitted, false)
  })

  it('stale old-workspace results are ignored', () => {
    const start = { ...initialSearchState(), workspaceId: 7 }
    const ignored = searchPanelReducer(start, {
      type: 'search-succeeded',
      workspaceId: 4,
      requestId: 1,
      result: sampleResult(4, 'auth')
    })
    assert.deepEqual(ignored.matches, [])
    const failed = searchPanelReducer(start, {
      type: 'search-failed',
      workspaceId: 4,
      requestId: 1,
      message: 'We couldn’t search this project.'
    })
    assert.equal(failed.error, null)
  })

  it('hostile preview text remains inert plain data', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const start = { ...initialSearchState(), workspaceId: 4 }
    const loading = searchPanelReducer(start, {
      type: 'search-started',
      workspaceId: 4,
      query: 'img',
      caseSensitive: false,
      requestId: 1
    })
    const done = searchPanelReducer(loading, {
      type: 'search-succeeded',
      workspaceId: 4,
      requestId: 1,
      result: {
        workspaceId: 4,
        query: 'img',
        matches: [{ relativePath: 'evil.html', line: 1, column: 1, preview: hostile }],
        filesScanned: 1,
        filesMatched: 1,
        truncated: false
      }
    })
    assert.equal(done.matches[0]?.preview, hostile)
    assert.equal(typeof done.matches[0]?.preview, 'string')
  })
})
