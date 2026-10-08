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

  it('at most three provider calls per run by construction', () => {
    const brain = readSource('src', 'main', 'ai', 'ai-brain-service.ts')
    // Stage 21 adds two bounded recovery paths (recovery-fixed run +
    // recovery text-only final) alongside the primary run: 3 structured
    // plan sites and 6 text sites total, each path using at most 1 plan
    // + 1 worker + 1 synthesis. No path loops or retries.
    const structuredSites = brain.match(/generateStructured\(/g) ?? []
    assert.equal(structuredSites.length, 3, 'primary + recovery + recovery-text-only plan sites')
    const textSites = brain.match(/generateText\(/g) ?? []
    assert.equal(textSites.length, 6, 'primary (2) + recovery (2) + recovery-text-only (2) text sites')
    // The only loops in the file budget local context bytes; no loop
    // encloses a provider call (single call sites above prove it).
    for (const forbidden of ['retry', 'repair', 'fallback', 'recursi']) {
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

  it('provider IPC takes no model, prompt, instruction, context, or messageId from the renderer', () => {
    const ipc = readSource('src', 'main', 'ipc', 'orchestration.ts')
    assert.ok(ipc.includes('aiRunBrain'), 'orchestration IPC must expose the run channel')
    for (const forbidden of ['workerInstruction', 'finalAnswer', 'proposedContent', 'expectedRevision', 'relativePath', 'model:', 'messageId']) {
      assert.ok(!ipc.includes(forbidden), `orchestration IPC must not contain ${forbidden}`)
    }
  })
})
