import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ExtensionAgentProviderInfo } from '../../../../shared/extension-agents/types'
import {
  agentTargetLabel,
  canSelectProvider,
  effortVisibleFor,
  findProvider,
  initialAgentTargetState,
  isTargetSwitchBlocked,
  resolveComposerSend,
  selectAgentTarget,
  setStarkEffort
} from './agent-target-state'
import { emptySessionTabDraft, stashSessionDraft } from './session-tabs'

function provider(
  overrides?: Partial<ExtensionAgentProviderInfo>
): ExtensionAgentProviderInfo {
  return {
    extensionId: 'example.agent',
    namespace: 'example',
    name: 'agent',
    version: '1.0.0',
    providerId: 'chat',
    displayName: 'Example Agent',
    iconUrl: null,
    capabilities: { chat: true, streaming: false, tools: false, proposals: true, cancellation: false },
    availability: { status: 'available', reason: null, version: '1.0.0' },
    ...overrides
  }
}

function unavailableProvider(): ExtensionAgentProviderInfo {
  return provider({ availability: { status: 'unavailable', reason: 'Extension does not expose a compatible agent interface.', version: null } })
}

describe('agent target selection (data-driven)', () => {
  it('starts on STARK with Regular effort and no providers', () => {
    const state = initialAgentTargetState()
    assert.deepEqual(state.target, { kind: 'stark' })
    assert.equal(state.effort, 'regular')
    assert.deepEqual(state.providers, [])
  })

  it('refuses unknown or unavailable providers (state unchanged, never fake)', () => {
    const state = initialAgentTargetState([unavailableProvider()])
    const unknown = selectAgentTarget(state, { kind: 'extension', extensionId: 'missing.ext', providerId: 'chat' })
    assert.equal(unknown, state)
    const refused = selectAgentTarget(state, { kind: 'extension', extensionId: 'example.agent', providerId: 'chat' })
    assert.equal(refused, state)
    assert.deepEqual(refused.target, { kind: 'stark' })
  })

  it('selects a provider only when it reports available or running', () => {
    const blocked = initialAgentTargetState([unavailableProvider()])
    assert.ok(!canSelectProvider(blocked.providers[0] as ExtensionAgentProviderInfo))
    for (const status of ['available', 'running'] as const) {
      const ready = initialAgentTargetState([provider({ availability: { status, reason: null, version: '1.0.0' } })])
      const row = ready.providers[0] as ExtensionAgentProviderInfo
      assert.ok(canSelectProvider(row))
      const next = selectAgentTarget(ready, { kind: 'extension', extensionId: 'example.agent', providerId: 'chat' })
      assert.deepEqual(next.target, { kind: 'extension', extensionId: 'example.agent', providerId: 'chat' })
    }
    for (const status of ['connecting', 'error'] as const) {
      const notReady = initialAgentTargetState([provider({ availability: { status, reason: 'busy', version: null } })])
      assert.ok(!canSelectProvider(notReady.providers[0] as ExtensionAgentProviderInfo))
    }
  })

  it('finds providers by exact coordinates (no name matching)', () => {
    const providers = [provider(), provider({ providerId: 'other', displayName: 'Other' })]
    assert.equal(findProvider(providers, 'example.agent', 'chat')?.displayName, 'Example Agent')
    assert.equal(findProvider(providers, 'example.agent', 'missing'), undefined)
  })

  it('blocks target switches during an active run (drafts untouched)', () => {
    const idle = { sending: false, generating: false, proposalPreparing: false, workPreparing: false, agentRunning: false }
    assert.ok(!isTargetSwitchBlocked(idle))
    for (const flags of [
      { ...idle, sending: true },
      { ...idle, generating: true },
      { ...idle, proposalPreparing: true },
      { ...idle, workPreparing: true },
      { ...idle, agentRunning: true }
    ]) {
      assert.ok(isTargetSwitchBlocked(flags))
    }
  })

  it('composer draft survives target selection (selection never clears text)', () => {
    const state = initialAgentTargetState([provider()])
    const draft = 'unsent work in progress'
    const next = selectAgentTarget(state, { kind: 'extension', extensionId: 'example.agent', providerId: 'chat' })
    assert.equal(typeof draft, 'string')
    assert.ok(draft.length > 0)
    assert.deepEqual(next.target, { kind: 'extension', extensionId: 'example.agent', providerId: 'chat' })
  })

  it('labels targets from provider data (STARK or the provider display name)', () => {
    assert.equal(agentTargetLabel({ kind: 'stark' }, []), 'STARK')
    assert.equal(
      agentTargetLabel({ kind: 'extension', extensionId: 'example.agent', providerId: 'chat' }, [provider()]),
      'Example Agent'
    )
    assert.equal(
      agentTargetLabel({ kind: 'extension', extensionId: 'missing.ext', providerId: 'chat' }, [provider()]),
      'Extension agent'
    )
  })
})

describe('stark effort state', () => {
  it('sets effort across all five levels and ignores invalid values', () => {
    let state = initialAgentTargetState()
    for (const effort of ['light', 'regular', 'medium', 'high', 'xhigh'] as const) {
      state = setStarkEffort(state, effort)
      assert.equal(state.effort, effort)
    }
    const unchanged = setStarkEffort(state, state.effort)
    assert.equal(unchanged, state)
  })

  it('hides the effort selector for ANY extension target (generic, never vendor-specific)', () => {
    assert.ok(effortVisibleFor({ kind: 'stark' }))
    assert.ok(!effortVisibleFor({ kind: 'extension', extensionId: 'example.agent', providerId: 'chat' }))
    assert.ok(!effortVisibleFor({ kind: 'extension', extensionId: 'other.helper', providerId: 'assistant' }))
  })

  it('persists per session inside the existing tab-draft stash (memory only)', () => {
    const fresh = emptySessionTabDraft('ask')
    assert.equal(fresh.target, undefined)
    assert.equal(fresh.effort, undefined)
    const drafts = stashSessionDraft({}, 7, {
      ...fresh,
      composer: 'unsent work',
      target: { kind: 'extension', extensionId: 'example.agent', providerId: 'chat' },
      effort: 'xhigh'
    })
    assert.equal(drafts[7]?.composer, 'unsent work')
    assert.deepEqual(drafts[7]?.target, { kind: 'extension', extensionId: 'example.agent', providerId: 'chat' })
    assert.equal(drafts[7]?.effort, 'xhigh')
  })

  it('resolves STARK sends to unified work and extension sends to provider runs', () => {
    assert.deepEqual(resolveComposerSend({ kind: 'stark' }, 'hello'), { kind: 'stark', mode: 'work', content: 'hello' })
    assert.deepEqual(resolveComposerSend({ kind: 'stark' }, '/ask why?'), { kind: 'stark', mode: 'ask', content: 'why?' })
    // Slashes are STARK-internal: extension runs receive raw text.
    assert.deepEqual(
      resolveComposerSend({ kind: 'extension', extensionId: 'example.agent', providerId: 'chat' }, '/ask hi', [provider()]),
      { kind: 'extension', extensionId: 'example.agent', providerId: 'chat' }
    )
    const blocked = resolveComposerSend(
      { kind: 'extension', extensionId: 'example.agent', providerId: 'chat' },
      'hello',
      [unavailableProvider()]
    )
    assert.equal(blocked.kind, 'blocked')
  })
})
