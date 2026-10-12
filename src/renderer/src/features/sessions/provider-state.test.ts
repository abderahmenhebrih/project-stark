import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  initialProviderPanelState,
  providerPanelReducer,
  type ProviderPanelState
} from './provider-state'

function activeWorkspace(workspaceId: number): ProviderPanelState {
  return { ...initialProviderPanelState(), workspaceId }
}

describe('provider panel state', () => {
  it('starts unconfigured with storage assumed available', () => {
    const state = activeWorkspace(3)
    assert.equal(state.configured, false)
    assert.equal(state.selectedModel, null)
    assert.equal(state.secureStorageAvailable, true)
    assert.equal(state.connectionPhase, 'idle')
  })

  it('loads provider state', () => {
    let state = activeWorkspace(3)
    state = providerPanelReducer(state, { type: 'state-loading', workspaceId: 3, requestId: 1 })
    assert.equal(state.loading, true)
    state = providerPanelReducer(state, {
      type: 'state-loaded',
      workspaceId: 3,
      requestId: 1,
      state: {
        providerId: 'openai',
        displayName: 'OpenAI',
        secureStorageAvailable: true,
        configured: true,
        selectedModel: 'gpt-4o'
      }
    })
    assert.equal(state.loading, false)
    assert.equal(state.configured, true)
    assert.equal(state.selectedModel, 'gpt-4o')
  })

  it('surfaces secure-storage unavailability', () => {
    let state = activeWorkspace(3)
    state = providerPanelReducer(state, { type: 'state-loading', workspaceId: 3, requestId: 1 })
    state = providerPanelReducer(state, {
      type: 'state-loaded',
      workspaceId: 3,
      requestId: 1,
      state: {
        providerId: 'openai',
        displayName: 'OpenAI',
        secureStorageAvailable: false,
        configured: false,
        selectedModel: null
      }
    })
    assert.equal(state.secureStorageAvailable, false)
  })

  it('key configured then removed updates state', () => {
    let state: ProviderPanelState = { ...activeWorkspace(3), configured: true }
    state = providerPanelReducer(state, {
      type: 'state-loaded',
      workspaceId: 3,
      requestId: 0,
      state: {
        providerId: 'openai',
        displayName: 'OpenAI',
        secureStorageAvailable: true,
        configured: false,
        selectedModel: 'gpt-4o'
      }
    })
    assert.equal(state.configured, false)
    assert.equal(state.selectedModel, 'gpt-4o')
  })

  it('tracks connection testing to success with reused models', () => {
    let state = activeWorkspace(3)
    state = providerPanelReducer(state, { type: 'connection-started', workspaceId: 3, requestId: 1 })
    assert.equal(state.connectionPhase, 'testing')
    state = providerPanelReducer(state, {
      type: 'connection-finished',
      workspaceId: 3,
      requestId: 1,
      status: 'connected',
      models: [{ id: 'gpt-4o' }]
    })
    assert.equal(state.connectionPhase, 'done')
    assert.equal(state.connectionStatus, 'connected')
    assert.deepEqual(state.models, [{ id: 'gpt-4o' }])
  })

  it('tracks connection failure statuses without models', () => {
    for (const status of ['invalid-credential', 'rate-limited', 'network-error', 'timeout'] as const) {
      let state: ProviderPanelState = { ...activeWorkspace(3), models: [{ id: 'kept' }] }
      state = providerPanelReducer(state, { type: 'connection-started', workspaceId: 3, requestId: 1 })
      state = providerPanelReducer(state, {
        type: 'connection-finished',
        workspaceId: 3,
        requestId: 1,
        status,
        models: []
      })
      assert.equal(state.connectionStatus, status)
      assert.deepEqual(state.models, [{ id: 'kept' }])
    }
  })

  it('loads the model list explicitly', () => {
    let state = activeWorkspace(3)
    state = providerPanelReducer(state, { type: 'models-loading', workspaceId: 3, requestId: 1 })
    assert.equal(state.loadingModels, true)
    state = providerPanelReducer(state, {
      type: 'models-loaded',
      workspaceId: 3,
      requestId: 1,
      models: [{ id: 'b' }, { id: 'a' }]
    })
    assert.equal(state.loadingModels, false)
    assert.deepEqual(state.models, [{ id: 'b' }, { id: 'a' }])
  })

  it('records model-list failures safely', () => {
    let state: ProviderPanelState = { ...activeWorkspace(3), loadingModels: true, modelsRequestId: 1 }
    state = providerPanelReducer(state, {
      type: 'models-failed',
      workspaceId: 3,
      requestId: 1,
      message: 'We couldn’t reach the AI provider.'
    })
    assert.equal(state.loadingModels, false)
    assert.equal(state.modelsError, 'We couldn’t reach the AI provider.')
  })

  it('selects a model through state reload', () => {
    let state: ProviderPanelState = { ...activeWorkspace(3), configured: true, selectedModel: null }
    state = providerPanelReducer(state, {
      type: 'state-loaded',
      workspaceId: 3,
      requestId: 0,
      state: {
        providerId: 'openai',
        displayName: 'OpenAI',
        secureStorageAvailable: true,
        configured: true,
        selectedModel: 'o3-mini'
      }
    })
    assert.equal(state.selectedModel, 'o3-mini')
  })

  it('workspace switch resets provider view state', () => {
    let state: ProviderPanelState = {
      ...activeWorkspace(3),
      configured: true,
      selectedModel: 'gpt-4o',
      models: [{ id: 'gpt-4o' }],
      connectionStatus: 'connected',
      requestId: 4
    }
    state = providerPanelReducer(state, { type: 'workspace-changed', workspaceId: 9 })
    assert.equal(state.workspaceId, 9)
    assert.equal(state.configured, false)
    assert.equal(state.selectedModel, null)
    assert.deepEqual(state.models, [])
    assert.equal(state.connectionStatus, null)
  })

  it('ignores stale provider responses', () => {
    const state: ProviderPanelState = { ...activeWorkspace(3), requestId: 2 }
    const stale = providerPanelReducer(state, {
      type: 'state-loaded',
      workspaceId: 3,
      requestId: 1,
      state: {
        providerId: 'openai',
        displayName: 'OpenAI',
        secureStorageAvailable: true,
        configured: true,
        selectedModel: 'x'
      }
    })
    assert.equal(stale, state)
  })

  it('disconnect drops models, selection, and connection status', () => {
    let state: ProviderPanelState = {
      ...activeWorkspace(3),
      configured: true,
      selectedModel: 'gpt-4o',
      models: [{ id: 'gpt-4o' }, { id: 'o3-mini' }],
      connectionPhase: 'done',
      connectionStatus: 'connected'
    }
    state = providerPanelReducer(state, {
      type: 'disconnected',
      workspaceId: 3,
      requestId: 0,
      state: {
        providerId: 'openai',
        displayName: 'OpenAI',
        secureStorageAvailable: true,
        configured: false,
        selectedModel: null
      }
    })
    assert.equal(state.configured, false)
    assert.equal(state.selectedModel, null)
    assert.deepEqual(state.models, [])
    assert.equal(state.modelsError, null)
    assert.equal(state.connectionPhase, 'idle')
    assert.equal(state.connectionStatus, null)
    assert.equal(state.connectionError, null)
  })

  it('disconnect forces the selection to null even when main keeps a stale persisted selection', () => {
    // clearCredential drops only the credential bytes; the persisted
    // BYOK selection survives main-side, so the renderer must null it
    // or later runs would target a keyless model.
    let state: ProviderPanelState = {
      ...activeWorkspace(3),
      configured: true,
      selectedModel: 'gpt-4o',
      models: [{ id: 'gpt-4o' }]
    }
    state = providerPanelReducer(state, {
      type: 'disconnected',
      workspaceId: 3,
      requestId: 0,
      state: {
        providerId: 'openai',
        displayName: 'OpenAI',
        secureStorageAvailable: true,
        configured: false,
        selectedModel: 'gpt-4o'
      }
    })
    assert.equal(state.configured, false)
    assert.equal(state.selectedModel, null)
    assert.deepEqual(state.models, [])
  })

  it('disconnect ignores stale workspaces and request ids', () => {
    const state: ProviderPanelState = {
      ...activeWorkspace(3),
      configured: true,
      selectedModel: 'gpt-4o',
      models: [{ id: 'gpt-4o' }],
      requestId: 2
    }
    const foreign = providerPanelReducer(state, {
      type: 'disconnected',
      workspaceId: 9,
      requestId: 2,
      state: {
        providerId: 'openai',
        displayName: 'OpenAI',
        secureStorageAvailable: true,
        configured: false,
        selectedModel: null
      }
    })
    assert.equal(foreign, state)
    const stale = providerPanelReducer(state, {
      type: 'disconnected',
      workspaceId: 3,
      requestId: 1,
      state: {
        providerId: 'openai',
        displayName: 'OpenAI',
        secureStorageAvailable: true,
        configured: false,
        selectedModel: null
      }
    })
    assert.equal(stale, state)
  })
})
