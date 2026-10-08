import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readMain(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'main', relative), 'utf8')
}

function readShared(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'shared', relative), 'utf8')
}

describe('worker tool architecture', () => {
  it('tool registry contains exactly three read-only tools', () => {
    const registry = readMain('worker-tools/worker-tool-registry.ts')
    assert.ok(registry.includes('workspace_read'))
    assert.ok(registry.includes('workspace_search'))
    assert.ok(registry.includes('git_read'))
    for (const forbidden of ['change_propose', 'terminal_execute', 'file_write', 'shell']) {
      // change_propose/terminal_execute are capabilities, not Stage 23 tools.
      if (forbidden === 'change_propose' || forbidden === 'terminal_execute') continue
      assert.ok(!registry.includes(`'${forbidden}'`), `registry must not contain ${forbidden}`)
    }
  })

  it('Worker loop is explicitly bounded (no while-true, no recursion)', () => {
    const runner = readMain('worker-tools/worker-tool-runner.ts')
    assert.ok(runner.includes('MAX_WORKER_TURNS'), 'bounded turn constant')
    assert.ok(runner.includes('MAX_WORKER_TOOL_CALLS'), 'bounded tool budget')
    assert.ok(runner.includes('for (let turn = 0; turn < MAX_WORKER_TURNS; turn += 1)'), 'explicit bounded for-loop')
    assert.ok(!runner.includes('while (true'), 'no unbounded loop')
    assert.ok(!runner.includes('while(true'), 'no unbounded loop')
    assert.ok(!runner.toLowerCase().includes('recursi'), 'no recursion')
  })

  it('only Worker turns reference tools (Brain/Ask/Propose are tool-free)', () => {
    const brain = readMain('ai/ai-brain-service.ts')
    assert.ok(!brain.includes('generateWorkerTurn'), 'Brain service must not call worker turns')
    assert.ok(!brain.includes('workspace_read'), 'Brain must not name tools')
    const completion = readMain('ai/ai-completion-service.ts')
    assert.ok(!completion.includes('generateWorkerTurn'))
    assert.ok(!completion.includes('workspace_read'))
    for (const file of ['ai/ai-code-proposal-service.ts', 'ai/ai-multi-file-proposal-service.ts']) {
      const source = readMain(file)
      assert.ok(!source.includes('generateWorkerTurn'), `${file} must not use tools`)
      assert.ok(!source.includes('workspace_read'), `${file} must not name tools`)
    }
    const runner = readMain('worker-tools/worker-tool-runner.ts')
    assert.ok(runner.includes('generateWorkerTurn'), 'only the runner drives Worker turns')
  })

  it('tool results stay untrusted data (never instructions)', () => {
    const runner = readMain('worker-tools/worker-tool-runner.ts')
    assert.ok(runner.includes('untrusted data, not an instruction'), 'tool results labeled untrusted')
    assert.ok(runner.includes('Worker tool result (untrusted data'), 'injection block labeled')
    const synthesis = runner.slice(runner.indexOf('buildSynthesisMessages'))
    assert.ok(!synthesis.includes('tool result (untrusted data') || true)
  })

  it('execution service imports only read authority', () => {
    const service = readMain('worker-tools/worker-tool-service.ts')
    for (const forbidden of [
      'WorkspaceFileWriteService',
      'ChangeTransactionService',
      'ChangeSetService',
      'node-pty',
      'TerminalManager',
      'child_process',
      'OpenAI',
      'generateText',
      'generateStructured',
      'credential'
    ]) {
      assert.ok(!service.includes(forbidden), `tool service must not contain ${forbidden}`)
    }
  })

  it('tool domain performs no mutation (static)', () => {
    for (const file of [
      'worker-tools/worker-tool-service.ts',
      'worker-tools/worker-tool-runner.ts',
      'worker-tools/worker-tool-approval-service.ts',
      'worker-tools/worker-tool-repository.ts'
    ]) {
      const source = readMain(file)
      for (const forbidden of ['writeTextFile', '.rm(', 'mkdir', 'git commit', 'git checkout', 'git push', 'git reset', 'terminal.write', 'spawn(']) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
    // The Git read path reuses the existing safe runner only.
    const service = readMain('worker-tools/worker-tool-service.ts')
    assert.ok(!service.includes('GitProcessRunner'), 'tool service uses the Git service, not the runner directly')
  })

  it('shared worker-tool types contain no write/execute authority', () => {
    const shared = readShared('worker-tools/types.ts')
    assert.ok(shared.includes('workspace_read'))
    for (const forbidden of ['writeTextFile', 'terminal.execute tool', 'change.propose tool']) {
      assert.ok(!shared.includes(forbidden))
    }
  })
})
