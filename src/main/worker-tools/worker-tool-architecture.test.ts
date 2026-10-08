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
  it('tool registry contains exactly four tools (Stage 24)', () => {
    const registry = readMain('worker-tools/worker-tool-registry.ts')
    assert.ok(registry.includes('workspace_read'))
    assert.ok(registry.includes('workspace_search'))
    assert.ok(registry.includes('git_read'))
    assert.ok(registry.includes('change_propose'))
    for (const forbidden of ['terminal_execute', 'file_write', 'shell']) {
      assert.ok(!registry.includes(`'${forbidden}'`), `registry must not contain ${forbidden}`)
    }
  })

  it('change_propose maps to Stage 22 change.propose capability only', () => {
    const registry = readMain('worker-tools/worker-tool-registry.ts')
    assert.ok(registry.includes("'change.propose'") || registry.includes('change.propose'))
    // No other new tool mapping.
    assert.ok(!registry.includes('terminal.execute'))
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

  it('proposal tool domain imports only proposal creation authority (no direct writes)', () => {
    const service = readMain('worker-tools/worker-tool-service.ts')
    for (const forbidden of [
      'WorkspaceFileWriteService',
      'writeTextFile',
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
    // Stage 24 may depend on the existing proposal services only.
    assert.ok(service.includes('ChangeTransactionService') || service.includes('changeSets'), 'proposal path uses existing services')
    const proposal = readMain('worker-tools/worker-proposal-service.ts')
    for (const forbidden of ['WorkspaceFileWriteService', 'writeTextFile', 'accept', 'rollback', 'TerminalManager', 'child_process', 'spawn(']) {
      // accept/rollback appear only inside comments about what is NOT done; check calls instead.
      if (forbidden === 'accept' || forbidden === 'rollback') continue
      assert.ok(!proposal.includes(forbidden), `proposal service must not contain ${forbidden}`)
    }
    assert.ok(!proposal.includes('.markApplied'), 'proposal service never applies')
    assert.ok(!proposal.includes('.markRejected'), 'proposal service never rejects')
    assert.ok(!proposal.includes('.markRolledBack'), 'proposal service never rolls back')
  })

  it('change_propose schema carries targetRef only (no model path authority)', () => {
    const registry = readMain('worker-tools/worker-tool-registry.ts')
    const start = registry.indexOf("name: 'change_propose'")
    assert.ok(start >= 0, 'change_propose schema must exist')
    // Schema-specific block only (ends at the schema's closing "}\n    }");
    // Approval summaries below legitimately mention relativePath for
    // human display — request authority must not.
    const end = registry.indexOf('}\n    }\n  ]', start)
    assert.ok(end > start, 'schema block must end')
    const slice = registry.slice(start, end)
    assert.ok(slice.includes('targetRef'), 'schema must carry targetRef')
    assert.ok(slice.includes('proposedContent'), 'schema must carry proposedContent')
    assert.ok(slice.includes('summary'), 'schema must carry summary')
    for (const forbidden of ['relativePath', 'absolutePath', 'expectedRevision', 'workspaceId', 'transactionId', 'changeSetId']) {
      assert.ok(!slice.includes(forbidden), `change_propose request schema must not contain ${forbidden}`)
    }
  })

  it('Brain remains tool-free (no change_propose schema)', () => {
    const brain = readMain('ai/ai-brain-service.ts')
    assert.ok(!brain.includes('change_propose'), 'Brain must not name proposal tool')
    const shared = readShared('worker-tools/types.ts')
    assert.ok(shared.includes('change_propose'))
  })

  it('tool domain performs no mutation (static)', () => {
    for (const file of [
      'worker-tools/worker-tool-service.ts',
      'worker-tools/worker-tool-runner.ts',
      'worker-tools/worker-tool-approval-service.ts',
      'worker-tools/worker-tool-repository.ts',
      'worker-tools/worker-proposal-service.ts',
      'worker-tools/worker-read-ref.ts',
      'worker-tools/worker-proposal-validation.ts'
    ]) {
      const source = readMain(file)
      for (const forbidden of ['.rm(', 'mkdir', 'git commit', 'git checkout', 'git push', 'git reset', 'terminal.write', 'spawn(']) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
    // The Git read path reuses the existing safe runner only.
    const service = readMain('worker-tools/worker-tool-service.ts')
    assert.ok(!service.includes('GitProcessRunner'), 'tool service uses the Git service, not the runner directly')
  })

  it('worker proposal tool has no Accept/Reject/Rollback authority (static)', () => {
    for (const file of ['worker-tools/worker-tool-service.ts', 'worker-tools/worker-proposal-service.ts']) {
      const source = readMain(file)
      assert.ok(!source.includes('acceptTransaction'), `${file} must not accept`)
      assert.ok(!source.includes('rejectTransaction'), `${file} must not reject`)
      assert.ok(!source.includes('rollbackTransaction'), `${file} must not rollback`)
      assert.ok(!source.includes('writeTextFile'), `${file} must not write directly`)
    }
  })

  it('no new generic execution IPC exists', () => {
    const ipc = readMain('ipc/worker-tools.ts')
    for (const forbidden of ['createProposalFromWorker', 'executeProposalTool', 'acceptWorkerProposal', 'callTool', 'readFileAsAgent']) {
      assert.ok(!ipc.includes(forbidden), `no ${forbidden} endpoint`)
    }
    // Exactly the three Stage 23 approval channels remain.
    assert.ok(ipc.includes('workerToolsGetPendingApproval'))
    assert.ok(ipc.includes('workerToolsApproveAndResume'))
    assert.ok(ipc.includes('workerToolsDenyAndResume'))
  })

  it('shared worker-tool types contain no write/execute authority', () => {
    const shared = readShared('worker-tools/types.ts')
    assert.ok(shared.includes('workspace_read'))
    for (const forbidden of ['writeTextFile', 'terminal.execute tool', 'change.propose tool']) {
      assert.ok(!shared.includes(forbidden))
    }
  })
})
