import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { USAGE_OPERATIONS } from './ai-usage-types'

function readMain(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'main', relative), 'utf8')
}

function readShared(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'shared', relative), 'utf8')
}

/** Every outbound adapter invocation must live inside a tracking closure. */
function assertAllCallsTracked(relative: string): void {
  const source = readMain(relative)
  const lines = source.split('\n')
  let tracked = 0
  let direct = 0
  for (const line of lines) {
    // Bound captures (`const generateX = adapter.generateX.bind(...)`)
    // end without an invocation; invocations end with `({`.
    if (/generate[A-Za-z]*\(\{\s*$/.test(line)) {
      if (line.includes('=>')) {
        tracked += 1
      } else {
        direct += 1
      }
    }
  }
  assert.ok(tracked > 0, `${relative} must route adapter calls through the tracker`)
  assert.equal(direct, 0, `${relative} has untracked adapter calls`)
}

describe('usage tracking boundary', () => {
  it('every outbound provider call passes through the central tracker', () => {
    for (const file of [
      'ai/ai-completion-service.ts',
      'ai/ai-brain-service.ts',
      'ai/ai-code-proposal-service.ts',
      'ai/ai-multi-file-proposal-service.ts',
      'worker-tools/worker-tool-runner.ts'
    ]) {
      assertAllCallsTracked(file)
    }
  })

  it('call-site operations are main-owned bounded labels', () => {
    const known = new Set(USAGE_OPERATIONS)
    for (const file of [
      'ai/ai-completion-service.ts',
      'ai/ai-brain-service.ts',
      'ai/ai-code-proposal-service.ts',
      'ai/ai-multi-file-proposal-service.ts',
      'worker-tools/worker-tool-runner.ts'
    ]) {
      const source = readMain(file)
      for (const match of source.matchAll(/operation: '([a-z_]+)'/g)) {
        assert.ok(known.has(match[1] as string), `${file} uses unknown operation ${match[1]}`)
      }
    }
  })

  it('no tool, runtime, or preview event is recorded as AI usage', () => {
    for (const file of [
      'worker-tools/worker-tool-service.ts',
      'worker-tools/worker-tool-runner.ts',
      'project-runtime/project-runtime-service.ts'
    ]) {
      const source = readMain(file)
      assert.ok(!source.includes('ai_usage_events'), `${file} must not write usage events`)
      assert.ok(!source.includes('reserveEvent'), `${file} must not reserve usage`)
    }
    const service = readMain('usage/ai-usage-service.ts')
    void service
  })

  it('usage domain performs no network, polling, retry, or estimation calls', () => {
    for (const file of [
      'usage/ai-usage-types.ts',
      'usage/usage-limits.ts',
      'usage/ai-usage-errors.ts',
      'usage/ai-usage-repository.ts',
      'usage/ai-usage-service.ts',
      'usage/ai-usage-tracker.ts',
      'usage/usage-threshold-policy.ts'
    ]) {
      const source = readMain(file)
      for (const forbidden of ['fetch(', 'axios', 'setInterval', 'setTimeout', 'sleep(', 'tokenizer(']) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
      assert.ok(!source.includes('while ('), `${file} must not loop`)
    }
    // Threshold policy is a pure single evaluation: no recursion, no chains.
    const policy = readMain('usage/usage-threshold-policy.ts')
    assert.equal(policy.split('decideThresholdRoute(').length - 1, 1, 'single definition, never self-invoked')
    assert.ok(!policy.includes('alternate1'), 'no alternate chains')
    assert.ok(!policy.includes('ranking'), 'no ranking')
  })

  it('usage domain imports no file, terminal, git, runtime, window, or credential authority', () => {
    for (const file of [
      'usage/ai-usage-types.ts',
      'usage/usage-limits.ts',
      'usage/ai-usage-errors.ts',
      'usage/ai-usage-repository.ts',
      'usage/ai-usage-service.ts',
      'usage/ai-usage-tracker.ts',
      'usage/usage-threshold-policy.ts'
    ]) {
      const source = readMain(file)
      for (const forbidden of [
        'WorkspaceFileWriteService',
        'TerminalService',
        'TerminalManager',
        'node-pty',
        'GitProcessRunner',
        'git commit',
        'BrowserWindow',
        'project-runtime-service',
        'runtime-preview',
        'safeStorage',
        'credential-protector',
        "from 'openai'",
        'api.openai.com',
        'previous_response_id',
        'Conversations'
      ]) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
    // The tracker classifies already-typed errors only — never raw bodies.
    const tracker = readMain('usage/ai-usage-tracker.ts')
    assert.ok(!tracker.includes('response body'), 'no bodies')
    assert.ok(!tracker.includes('.headers'), 'no header access')
    assert.ok(!tracker.includes('Authorization'), 'no auth material')
  })

  it('saving config never calls the provider (no automatic model test)', () => {
    const service = readMain('usage/ai-usage-service.ts')
    for (const forbidden of ['listModels(', 'generateText(', 'generateStructured(', 'generateWorkerTurn(', 'diagnoseConnection(']) {
      assert.ok(!service.includes(forbidden), `usage service must not invoke ${forbidden}`)
    }
    // Known-provider checks are local registry lookups only.
    assert.ok(service.includes('isKnown('), 'provider checks stay local')
  })

  it('usage IPC surface is exactly three local channels', () => {
    const constants = readShared('constants/index.ts')
    assert.ok(constants.includes("usageGetConfig: 'stark:usage:get-config'"))
    assert.ok(constants.includes("usageUpdateConfig: 'stark:usage:update-config'"))
    assert.ok(constants.includes("usageGetSummary: 'stark:usage:get-summary'"))
    for (const forbidden of ['record-usage', 'insert-event', 'set-used-tokens', 'reset-quota', 'route-now', 'switch-model-now']) {
      assert.ok(!constants.includes(forbidden), `no ${forbidden} channel`)
    }
    const ipc = readMain('ipc/usage.ts')
    for (const forbidden of ['record-usage', 'insert-event', 'set-used-tokens', 'reset-quota', 'route-now', 'switch-model-now']) {
      assert.ok(!ipc.includes(forbidden), `usage IPC must not expose ${forbidden}`)
    }
    assert.ok(ipc.includes('usageGetConfig'))
    assert.ok(ipc.includes('usageUpdateConfig'))
    assert.ok(ipc.includes('usageGetSummary'))
    const preload = readFileSync(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8')
    assert.ok(preload.includes('createUsageApi()'))
    assert.ok(preload.includes('usage: createUsageApi()'))
    assert.ok(!preload.includes("'stark:usage:"), 'preload must not hardcode usage channel names')
  })

  it('shared usage contract never promises provider quotas or credentials', () => {
    const shared = readShared('usage/types.ts')
    const lower = shared.toLowerCase()
    for (const forbidden of ['remaining quota', 'exact provider quota', 'billing balance', 'price', 'credential', 'api key']) {
      assert.ok(!lower.includes(forbidden), `shared usage contract must not contain ${forbidden}`)
    }
    assert.ok(lower.includes('does not query'), 'contract states the local-only boundary')
  })
})
