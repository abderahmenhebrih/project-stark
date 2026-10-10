import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  initialUsagePanelState,
  usagePanelReducer,
  type UsagePanelState
} from './usage-state'

/**
 * Async session-ownership regression net (stabilization pass, Part B).
 *
 * Every async completion must land in the SESSION that started it, never
 * in whichever tab happens to be active when the promise resolves.
 * Pure rules are unit-tested; renderer wiring is pinned by static
 * source assertions (same pattern as session-multitab.test.ts).
 */

function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

function panel(): string {
  return readRenderer('features/sessions/SessionPanel.tsx')
}

function boundUsage(): UsagePanelState {
  return { ...initialUsagePanelState(), workspaceId: 7 }
}

describe('attachment picker session ownership', () => {
  it('captures the origin session and never merges into the live (wrong-tab) state blindly', () => {
    const source = panel()
    const at = source.indexOf('async function handleAttach()')
    assert.ok(at >= 0, 'attach flow must exist')
    // Scope to the attach function body only (the per-item removal
    // helper below it legitimately releases single draft assets).
    const end = source.indexOf('function handleVoiceTranscribed(', at)
    assert.ok(end > at, 'attach body must be bounded')
    const body = source.slice(at, end)
    assert.ok(body.includes('const originSessionId = state.selectedSessionId'), 'picker must capture its origin session')
    assert.ok(body.includes('selectedSessionIdRef.current === originSessionId'), 'resolve must compare against the live selection')
    assert.ok(body.includes('stashSessionDraft(drafts, originSessionId'), 'late resolves must stash into the origin tab’s draft')
    assert.ok(!body.includes('removeChatAttachmentDraft'), 'the picker path must never release draft assets')
  })

  it('resets attachBusy on every path (try/finally, no stuck spinner)', () => {
    const source = panel()
    const at = source.indexOf('async function handleAttach()')
    const body = source.slice(at, at + 2200)
    assert.ok(body.includes('try {'), 'picker must guard the await')
    assert.ok(body.includes('finally {'), 'busy flag must reset in finally')
    const finallyAt = body.indexOf('finally {')
    assert.ok(body.slice(finallyAt, finallyAt + 120).includes('setAttachBusy(false)'), 'finally must release the busy flag')
  })
})

describe('approval session ownership', () => {
  it('stale approval loads cannot overwrite the current tab’s card', () => {
    const source = panel()
    const at = source.indexOf('async function loadPendingApproval(sessionId: number)')
    assert.ok(at >= 0, 'approval load must exist')
    const body = source.slice(at, at + 1400)
    assert.ok(body.includes('approvalRequestRef.current'), 'approval loads must carry a request guard')
    assert.ok(body.includes('selectedSessionIdRef.current !== sessionId'), 'late resolves must check the live selection')
    const setAt = body.indexOf('setPendingApproval(found)')
    assert.ok(setAt >= 0, 'approval card must still populate for the owning tab')
  })

  it('tool-resume outcomes keep the card with the originating session', () => {
    const source = panel()
    const at = source.indexOf('async function handleToolResumeOutcome(')
    assert.ok(at >= 0, 'tool resume path must exist')
    const body = source.slice(at, at + 1600)
    assert.ok(body.includes('selectedSessionIdRef.current === sessionId'), 'card updates must verify the origin tab is still active')
    // Session-scoped run/message updates still flow (reducers own scoping).
    assert.ok(body.includes("workDispatch({ type: 'run-succeeded'"), 'run updates must still dispatch')
  })

  it('approval decision failures surface on the originating tab only', () => {
    const source = panel()
    const at = source.indexOf('async function handleApprovalDecision(')
    assert.ok(at >= 0, 'approval decision must exist')
    const body = source.slice(at, at + 1800)
    assert.ok(body.includes('selectedSessionIdRef.current === sessionId'), 'decision errors must not leak into another tab')
  })
})

describe('recovery banner ownership', () => {
  it('late recovery loads cannot overwrite the current tab’s banner', () => {
    const source = panel()
    const at = source.indexOf('async function loadRecoveryForSelected(sessionId: number)')
    assert.ok(at >= 0, 'recovery load must exist')
    const body = source.slice(at, at + 1400)
    assert.ok(body.includes('recoveryRequestRef.current'), 'recovery loads must carry a request guard')
    assert.ok(body.includes('selectedSessionIdRef.current !== sessionId'), 'late resolves must check the live selection')
  })

  it('dismiss results apply to the originating tab only', () => {
    const source = panel()
    const at = source.indexOf('async function handleDismissRecovery()')
    assert.ok(at >= 0, 'recovery dismiss must exist')
    const body = source.slice(at, at + 900)
    assert.ok(body.includes('selectedSessionIdRef.current !== sessionId'), 'dismiss must verify the origin tab is still active')
  })
})

describe('send-clear ownership', () => {
  it('clears exactly the consumed attachments in the session that sent them', () => {
    const source = panel()
    const at = source.indexOf('function clearSentComposer(')
    assert.ok(at >= 0, 'send-clear helper must exist')
    const body = source.slice(at, at + 1600)
    assert.ok(body.includes('sentAttachmentIds'), 'clear must know exactly what was consumed')
    assert.ok(body.includes('!sentAttachmentIds.includes(entry.id)'), 'clear must filter, never blind-wipe')
    assert.ok(body.includes('selectedSessionIdRef.current !== originSessionId'), 'clear must detect a mid-send tab switch')
    assert.ok(body.includes('stashSessionDraft(drafts, originSessionId'), 'switched-away origins clear from their own stash')
  })

  it('every send mode snapshots its consumed attachments before the await', () => {
    const source = panel()
    for (const marker of ['async function handleSend()', 'async function handleProposeSend(', 'async function handleWorkSend(']) {
      const at = source.indexOf(marker)
      assert.ok(at >= 0, `${marker} must exist`)
      const body = source.slice(at, at + 2400)
      assert.ok(body.includes('const sentAttachmentIds = attachments.map((entry) => entry.id)'), `${marker} must snapshot consumed IDs`)
      assert.ok(body.includes('clearSentComposer(content, sessionId, sentAttachmentIds)'), `${marker} must clear with ownership`)
    }
  })
})

describe('voice transcription cannot cross tabs', () => {
  it('remounts per session and drops late results instead of injecting them', () => {
    const source = panel()
    assert.ok(source.includes('key={`voice-${String(state.selectedSessionId'), 'voice control must remount per session tab')
    const button = readRenderer('features/sessions/VoiceInputButton.tsx')
    assert.ok(button.includes('mountedRef.current = false'), 'unmount/switch must invalidate the instance')
    assert.ok(button.includes('if (!mountedRef.current)'), 'late transcription must be dropped, never injected')
    assert.ok(button.includes('stopTracks()'), 'owned media tracks must stop on switch')
  })
})

describe('workspace switch keeps its guards on every trigger', () => {
  it('the chrome project button uses the shared guarded flow', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('chooseWorkspaceWithGuards(workspace)'), 'chrome switch must consult dirty + terminal guards')
    assert.ok(!home.includes('void workspace.chooseWorkspace()'), 'no unguarded native switch may remain on the shell path')
  })
})

describe('usage limit rows keep stable identity', () => {
  it('draft rows carry renderer-local keys excluded from the save payload', () => {
    const state = readRenderer('features/sessions/usage-state.ts')
    assert.ok(state.includes('readonly key: string'), 'limit drafts must carry a stable row key')
    assert.ok(state.includes('mintUsageLimitKey()'), 'keys must be minted on add and config load')
    const surface = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    assert.ok(surface.includes('key={entry.key}'), 'rows must key by stable id, never by index')
    const source = panel()
    const saveAt = source.indexOf('const limits = draft.limits.map((entry) => {')
    assert.ok(saveAt >= 0, 'save mapping must exist')
    const saveBody = source.slice(saveAt, saveAt + 700)
    assert.ok(!saveBody.includes('entry.key'), 'renderer-local keys must never reach the save payload')
  })

  it('add/edit/remove preserve each row’s key', () => {
    let state = boundUsage()
    state = usagePanelReducer(state, { type: 'limit-added', workspaceId: 7 })
    state = usagePanelReducer(state, { type: 'limit-added', workspaceId: 7 })
    const first = state.draft.limits[0]
    const second = state.draft.limits[1]
    assert.ok(first !== undefined && second !== undefined && first.key !== second.key, 'added rows must key uniquely')
    state = usagePanelReducer(state, { type: 'limit-edited', workspaceId: 7, index: 0, limit: { ...first, model: 'model-A' } })
    assert.equal(state.draft.limits[0]?.key, first.key, 'editing must preserve the row key')
    assert.equal(state.draft.limits[0]?.model, 'model-A')
    state = usagePanelReducer(state, { type: 'limit-removed', workspaceId: 7, index: 0 })
    assert.equal(state.draft.limits.length, 1)
    assert.equal(state.draft.limits[0]?.key, second.key, 'removal must keep the surviving row’s identity')
  })

  it('config load mints keys for every row', () => {
    let state = boundUsage()
    state = usagePanelReducer(state, {
      type: 'config-loaded',
      workspaceId: 7,
      config: {
        heartThresholdRoutingEnabled: false,
        limits: [
          { providerId: 'openai', model: 'a', maxCalls24h: null, maxTotalTokens24h: null, switchAtPercent: 90 },
          { providerId: 'openai', model: 'b', maxCalls24h: 10, maxTotalTokens24h: null, switchAtPercent: 80 }
        ],
        alternates: []
      }
    })
    const keys = state.draft.limits.map((entry) => entry.key)
    assert.equal(keys.length, 2)
    assert.ok(keys[0] !== keys[1], 'loaded rows must key uniquely')
  })
})

describe('explorer ownership and trigger hygiene', () => {
  it('workspace trust evaluation runs once per workspace, not once ever', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('useRef<number | null>(null)'), 'trigger tracking must be id-scoped')
    assert.ok(explorer.includes('workspaceTriggeredRef.current === workspaceId'), 'repeat workspaces must re-evaluate trust')
  })

  it('debounced host doc sync drops stale pushes and clears on unmount', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('if (openDocUriRef.current !== uri)'), 'late sync must verify the open document')
    const clearAt = explorer.indexOf('clearTimeout(docSyncTimerRef.current)')
    assert.ok(clearAt >= 0, 'pending sync must be cancellable')
  })

  it('background-file format results never yank the review pane', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    const at = explorer.indexOf('async function runFormatDocument(')
    assert.ok(at >= 0, 'format flow must exist')
    const body = explorer.slice(at, at + 2400)
    assert.ok(body.includes('previewPathRef.current !== relativePath'), 'review must verify the foreground file')
    assert.ok(body.includes('Reopen it to review the change'), 'background results must name their file calmly')
    assert.ok(body.includes("result.revision !== startedRevision"), 'stale revisions must still fail safely')
  })
})

describe('bounded caches and timers', () => {
  it('live search cache evicts oldest-first past its cap', () => {
    const search = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(search.includes('LIVE_SEARCH_CACHE_MAX'), 'search cache must declare a bound')
    assert.ok(search.includes('cacheLiveSearch(workspaceId'), 'writes must route through the bounded helper')
    assert.ok(search.includes('liveSearchCache.delete(oldest.value)'), 'overflow must evict oldest-first')
  })

  it('extension toast timers clear on unmount', () => {
    const overlays = readRenderer('features/extensions/ExtensionOverlays.tsx')
    assert.ok(overlays.includes('toastTimersRef'), 'toast timers must be owned')
    assert.ok(overlays.includes('clearTimeout(timer)'), 'unmount must cancel pending dismissals')
  })
})
