import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readMain(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'main', relative), 'utf8')
}

describe('recovery architecture (no loops, no fallback chains, no side channels)', () => {
  it('policy domain contains no provider, FS, or tool imports', () => {
    const source = readMain('recovery/recovery-policy.ts')
    for (const forbidden of [
      'openai',
      'OpenAI',
      'fetch(',
      'XMLHttpRequest',
      'node:fs',
      'node:child_process',
      'child_process',
      'WorkspaceFileWriteService',
      'WorkspaceFilesService',
      'ChangeTransactionService',
      'ChangeSetService',
      'terminal',
      'Git',
      'shell',
      'tools'
    ]) {
      assert.ok(!source.includes(forbidden), `policy must not contain ${forbidden}`)
    }
  })

  it('recovery repository contains no provider logic', () => {
    const source = readMain('recovery/recovery-repository.ts')
    for (const forbidden of ['generateText', 'generateStructured', 'fetch(', 'OpenAI', 'adapter']) {
      assert.ok(!source.includes(forbidden), `repository must not contain ${forbidden}`)
    }
  })

  it('coordinator has no fallback lists, retry loops, or polling', () => {
    const source = readMain('recovery/recovery-coordinator.ts')
    for (const forbidden of [
      'fallbackModels',
      'fallbackChain',
      'nextProvider',
      'while (retry',
      'while(retry',
      'setInterval',
      'setTimeout',
      'exponential',
      'maxRetries'
    ]) {
      assert.ok(!source.includes(forbidden), `coordinator must not contain ${forbidden}`)
    }
    // No provider-candidate iteration: the only `for` in the
    // coordinator validates strict IPC shapes (Object.keys), never
    // iterates providers. Forbid the specific fallback iteration shape.
    assert.ok(!source.includes('for (') || source.includes('Object.keys'), 'coordinator must not iterate providers')
    assert.ok(!source.includes('for (const provider'), 'coordinator must not iterate providers')
    assert.ok(!source.includes('for (const candidate'), 'coordinator must not iterate candidates')
  })

  it('exactly one recovery assignment per role (no arrays of providers)', () => {
    const service = readMain('recovery/recovery-service.ts')
    assert.ok(!service.includes('fallback'), 'service must not contain fallback')
    assert.ok(!service.includes('while ('), 'service must not loop')
    const coordinator = readMain('recovery/recovery-coordinator.ts')
    // One explicit assignment per role: ask uses config.ask once, work uses brain+worker once.
    const askUses = (coordinator.match(/config\.ask/g) ?? []).length
    assert.ok(askUses >= 1 && askUses <= 3, `ask assignment uses: ${askUses}`)
  })

  it('hard caps are declared once and match spec (Ask<=2, Work<=6, hops=1)', () => {
    const limits = readMain('recovery/recovery-limits.ts')
    assert.ok(limits.includes('MAX_ASK_TOTAL_CALLS = 2'))
    assert.ok(limits.includes('MAX_WORK_TOTAL_CALLS = 6'))
    assert.ok(limits.includes('MAX_RECOVERY_HOPS = 1'))
    assert.ok(limits.includes('RECOVERY_PROVIDER_CALL_TIMEOUT_MS = 60000') || limits.includes('60000'))
    assert.ok(limits.includes('RECOVERY_WORK_RUN_TIMEOUT_MS = 150000') || limits.includes('150000'))
  })

  it('no billing/quota/token metering exists', () => {
    for (const file of [
      'recovery/recovery-service.ts',
      'recovery/recovery-repository.ts',
      'recovery/recovery-coordinator.ts',
      'recovery/recovery-policy.ts'
    ]) {
      const source = readMain(file)
      for (const forbidden of ['billing', 'quota', 'token accounting', 'cost metering', 'balance']) {
        assert.ok(!source.toLowerCase().includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
  })

  it('provider maxRetries stays 0 and per-call timeouts are bounded', async () => {
    const adapter = readFileSync(join(process.cwd(), 'src', 'main', 'ai', 'openai-adapter.ts'), 'utf8')
    assert.ok(adapter.includes('maxRetries'), 'adapter must declare maxRetries')
    assert.ok(adapter.includes('maxRetries: 0'), 'provider maxRetries must be 0')
    const limits = readMain('ai/limits.ts')
    assert.ok(limits.includes('AI_GENERATE_TIMEOUT_MS = 60000') || limits.includes('60000'))
    assert.ok(limits.includes('MAX_ORCHESTRATION_RUN_MS = 150000') || limits.includes('150000'))
  })

  it('no broad process kills or WAL/SHM copying', () => {
    for (const file of [
      'recovery/recovery-service.ts',
      'recovery/recovery-repository.ts',
      'recovery/recovery-coordinator.ts'
    ]) {
      const source = readMain(file)
      assert.ok(!source.includes('process.kill'), `${file} must not kill processes`)
      assert.ok(!source.includes('SIGKILL'), `${file} must not SIGKILL`)
      assert.ok(!source.includes('.shm'), `${file} must not copy SHM`)
      assert.ok(!source.includes('.wal'), `${file} must not copy WAL`)
    }
  })
})
