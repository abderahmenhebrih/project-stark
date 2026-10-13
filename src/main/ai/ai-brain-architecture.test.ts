import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

describe('brain no-authority architecture', () => {
  it('brain/orchestration domain imports no filesystem, command, or mutation authority', () => {
    for (const relative of [
      'main/ai/ai-brain-service.ts',
      'main/ai/ai-brain-errors.ts',
      'main/ai/ai-operation-guard.ts',
      'main/database/repositories/orchestration-repository.ts'
    ]) {
      const source = readSource('src', ...relative.split('/'))
      for (const forbidden of [
        'WorkspaceFileWriteService',
        'writeTextFile',
        'ChangeTransactionService',
        'ChangeSetService',
        'node-pty',
        'TerminalManager',
        'GitProcessRunner',
        'git-process-runner',
        'child_process',
        'execSync',
        'spawn(',
        'tool_choice',
        '../terminal/',
        '../git/'
      ]) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
    const brain = readSource('src', 'main', 'ai', 'ai-brain-service.ts')
    assert.ok(!brain.includes("from 'node:fs"), 'brain must not use the filesystem API')
    assert.ok(!brain.includes('from "node:fs'), 'brain must not use the filesystem API')
  })

  it('bounded provider calls per run by construction (LoopLink failover)', () => {
    const brain = readSource('src', 'main', 'ai', 'ai-brain-service.ts')
    // Primary run + two bounded recovery paths + LoopLink chain run:
    // 5 structured plan sites (primary, chain-plan, chain-legacy,
    // recovery, recovery-text-only) and 5 worker sites, each path
    // using at most 1 plan + 1 worker + 1 synthesis per phase attempt.
    // LoopLink phases fail over sequentially over at most 5 enabled
    // models (ordered, each tried once) — bounded, no parallel calls,
    // no infinite loops, no recursive unlimited fallback.
    const structuredSites = brain.match(/generateStructured\(\{/g) ?? []
    assert.equal(structuredSites.length, 5, 'primary + chain + chain-legacy + recovery + recovery-text-only plan sites')
    const workerSites = brain.match(/generateWorkerText\(\{/g) ?? []
    assert.equal(workerSites.length, 5, 'primary + chain + chain-legacy + recovery + recovery-text-only worker sites')
    const synthesisSites = brain.match(/generateSynthesisText\(\{/g) ?? []
    assert.equal(synthesisSites.length, 3, 'primary + recovery + recovery-text-only synthesis sites')
    const trackedSites = brain.match(/this\.trackCall\(/g) ?? []
    assert.equal(trackedSites.length, 15, 'all 15 call sites pass through the central tracker')
    // Only bounded LoopLink failover loops enclose provider calls
    // (sequential, max 5 attempts per phase, each tried once). No
    // unbounded retry/repair/recursion patterns.
    for (const forbidden of ['repair', 'recursi']) {
      assert.ok(!brain.toLowerCase().includes(forbidden), `brain service must not contain ${forbidden}`)
    }
    assert.ok(!brain.includes('this.runBrain('), 'no recursive Brain calls')
  })

  it('no recursive worker or retry patterns exist', () => {
    const brain = readSource('src', 'main', 'ai', 'ai-brain-service.ts')
    assert.ok(!brain.toLowerCase().includes('recursi'), 'no recursion of any kind')
    assert.ok(!brain.includes('setInterval'), 'no polling')
    assert.ok(!brain.includes('setTimeout'), 'no timer waits')
  })

  it('repair budgets come from policy caps and cancel is checked between rounds', () => {
    const brain = readSource('src', 'main', 'ai', 'ai-brain-service.ts')
    // Structured-output repeats use the effort policy budget (capped
    // at the absolute cap in stark-run-policy), never a literal.
    assert.ok(brain.includes('policy.structuredOutputRepeatBudget'), 'repeats must read the policy budget')
    assert.ok(!brain.includes('structuredOutputRepeatBudget: 2'), 'no hardcoded repeat budget in the service')
    // Cancel and deadline are both checked between plan-shape repeats.
    const repeatBlock = brain.slice(brain.indexOf('attempts += 1'))
    assert.ok(repeatBlock.includes('this.guard.throwIfCancelled(sessionId)'), 'cancel must be checked between repeats')
    assert.ok(repeatBlock.includes('this.requireDeadline(deadline)'), 'deadline must be checked between repeats')
    const policy = readSource('src', 'main', 'ai', 'stark-run-policy.ts')
    assert.ok(policy.includes('STARK_POLICY_ABSOLUTE_CAPS'), 'absolute caps must exist')
  })

  it('LoopLink tries each model at most once per phase with no inner retry', () => {
    const chain = readSource('src', 'main', 'ai', 'looplink-chain.ts')
    assert.equal((chain.match(/attempts \+= 1/g) ?? []).length, 1, 'exactly one attempt counter increment')
    assert.ok(!chain.includes('while ('), 'no while loops in chain execution')
    assert.ok(chain.includes('chain.slice(0, MAX_LOOPLINK_CHAIN_MODELS)'), 'chain is hard-capped')
    assert.ok(chain.includes('isCancelled'), 'cancellation is threaded through failover')
  })

  it('provider IPC takes no model, prompt, instruction, context, or messageId from the renderer', () => {
    const ipc = readSource('src', 'main', 'ipc', 'orchestration.ts')
    assert.ok(ipc.includes('aiRunBrain'), 'orchestration IPC must expose the run channel')
    for (const forbidden of ['workerInstruction', 'finalAnswer', 'proposedContent', 'expectedRevision', 'relativePath', 'model:', 'messageId']) {
      assert.ok(!ipc.includes(forbidden), `orchestration IPC must not contain ${forbidden}`)
    }
  })
})
