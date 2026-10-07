import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Static provider/AI bridge contract: the preload source must expose
 * exactly the six provider functions plus ai.generateResponse, and
 * must never gain secret reads, networking, or tool execution.
 * Runs against the repository source (cwd is the repo root via npm).
 */
function readPreloadSource(): string {
  const file = join(process.cwd(), 'src', 'preload', 'index.ts')
  assert.ok(existsSync(file), 'preload source must exist')
  return readFileSync(file, 'utf8')
}

describe('provider/AI preload contract', () => {
  it('exposes only the six provider controls', () => {
    const source = readPreloadSource()
    for (const expected of [
      'IPC_CHANNELS.providersGetState',
      'IPC_CHANNELS.providersSaveCredential',
      'IPC_CHANNELS.providersClearCredential',
      'IPC_CHANNELS.providersTestConnection',
      'IPC_CHANNELS.providersListModels',
      'IPC_CHANNELS.providersSetModel',
      'createProvidersApi()',
      'providers: createProvidersApi()'
    ]) {
      assert.ok(source.includes(expected), `preload must contain ${expected}`)
    }
  })

  it('exposes ai.generateResponse and nothing else for AI', () => {
    const source = readPreloadSource()
    assert.ok(source.includes('IPC_CHANNELS.aiGenerateResponse'))
    assert.ok(source.includes('createAiApi()'))
    assert.ok(source.includes('ai: createAiApi()'))
  })

  it('exposes no secret-read or networking API', () => {
    const source = readPreloadSource()
    for (const forbidden of [
      'get-api-key',
      'getApiKey',
      'decrypt',
      'encryptedApiKey',
      'encrypted_api_key',
      'fetch(',
      'WebSocket',
      'OpenAI',
      'openai',
      'raw-request',
      'set-base-url',
      'setBaseUrl',
      'baseURL',
      'sendAssistant',
      'provider:run'
    ]) {
      assert.ok(!source.includes(forbidden), `preload must not contain ${forbidden}`)
    }
  })

  it('exposes no generic invoke/send or tool execution', () => {
    const source = readPreloadSource()
    for (const forbidden of ['generic invoke', 'generic send', 'run-agent', 'runAgent', 'tools:']) {
      assert.ok(!source.includes(forbidden), `preload must not contain ${forbidden}`)
    }
    // invoke() calls below are the fixed per-domain bridge — no channel
    // choice reaches the renderer.
    assert.ok(!source.includes('genericInvoke'))
    assert.ok(!source.includes('genericSend'))
  })

  it('uses no raw channel strings for providers/AI', () => {
    const source = readPreloadSource()
    assert.ok(!source.includes("'stark:providers:"), 'preload must not hardcode provider channel names')
    assert.ok(!source.includes("'stark:ai:"), 'preload must not hardcode AI channel names')
  })

  it('completion/IPC sources take no renderer provider parameters', () => {
    const completion = readFileSync(join(process.cwd(), 'src', 'main', 'ai', 'ai-completion-service.ts'), 'utf8')
    assert.ok(!completion.includes('baseURL') && !completion.includes('baseUrl'), 'completion must not accept endpoints')
    const ipc = readFileSync(join(process.cwd(), 'src', 'main', 'ipc', 'ai.ts'), 'utf8')
    for (const forbidden of ['sendAssistant', 'send-assistant', 'tools', 'run-agent']) {
      assert.ok(!ipc.includes(forbidden), `AI IPC must not contain ${forbidden}`)
    }
  })
})
