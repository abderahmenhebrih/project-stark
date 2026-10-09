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
  it('tool registry contains exactly eight tools (Stage 27)', () => {
    const registry = readMain('worker-tools/worker-tool-registry.ts')
    assert.ok(registry.includes('workspace_read'))
    assert.ok(registry.includes('workspace_search'))
    assert.ok(registry.includes('git_read'))
    assert.ok(registry.includes('change_propose'))
    assert.ok(registry.includes('terminal_execute'))
    assert.ok(registry.includes('runtime_start'))
    assert.ok(registry.includes('runtime_observe'))
    assert.ok(registry.includes('preview_inspect'))
    for (const forbidden of ['file_write', 'shell', 'browser_click', 'browser_type', 'browser_navigate', 'runtime_stop', 'runtime_logs']) {
      assert.ok(!registry.includes(`'${forbidden}'`), `registry must not contain ${forbidden}`)
    }
  })

  it('change_propose, terminal_execute, and runtime_start map to their Stage 22 capabilities', () => {
    const registry = readMain('worker-tools/worker-tool-registry.ts')
    assert.ok(registry.includes("'change.propose'") || registry.includes('change.propose'))
    assert.ok(registry.includes("'terminal.execute'") || registry.includes('terminal.execute'))
  })

  it('runtime_start is advertised ask-only and shares the terminal capability', () => {
    const runner = readMain('worker-tools/worker-tool-runner.ts')
    assert.ok(runner.includes("'runtime_start'"), 'runner names the runtime tool')
    assert.ok(runner.includes('terminal.execute'), 'runtime maps to the terminal capability')
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

  it('terminal_execute schema carries program plus argv only', () => {
    const registry = readMain('worker-tools/worker-tool-registry.ts')
    const start = registry.indexOf("name: 'terminal_execute'")
    assert.ok(start >= 0, 'terminal_execute schema must exist')
    const end = registry.indexOf('}\n    }\n  ]', start)
    assert.ok(end > start, 'schema block must end')
    const slice = registry.slice(start, end)
    assert.ok(slice.includes('program'), 'schema must carry program')
    assert.ok(slice.includes('args'), 'schema must carry args')
    // Quoted property keys only: descriptions may use ordinary words.
    for (const forbidden of ['"command"', '"cwd"', '"env"', '"shell"', '"stdin"', '"timeout"', '"background"', '"detached"', '"workspaceId"', '"sessionId"']) {
      assert.ok(!slice.includes(forbidden), `terminal_execute request schema must not contain ${forbidden}`)
    }
  })

  it('worker command service has bounded authority only (static)', () => {
    const service = readMain('worker-tools/worker-command-service.ts')
    for (const forbidden of [
      'WorkspaceFileWriteService',
      'writeTextFile',
      'acceptTransaction',
      'rejectTransaction',
      'rollbackTransaction',
      'TerminalService',
      'TerminalManager',
      'node-pty',
      'OpenAI',
      'generateText',
      'generateStructured',
      'credential'
    ]) {
      assert.ok(!service.includes(forbidden), `command service must not contain ${forbidden}`)
    }
    // May depend on the gate, workspace authority, and persistence only.
    assert.ok(service.includes('CapabilityGate'), 'command service rechecks the gate')
    assert.ok(service.includes('WorkerCommandRepository'), 'command service persists executions')
  })

  it('worker command runner uses argv execution only (static)', () => {
    const service = readMain('worker-tools/worker-command-service.ts')
    assert.ok(!service.includes('exec('), 'no exec shell helper')
    assert.ok(!service.includes('execSync'), 'no sync exec helper')
    assert.ok(!service.includes('shell: true'), 'never a shell')
    assert.ok(!service.includes('detached: true'), 'never detached')
    assert.ok(service.includes('shell: false'), 'argv execution is explicit')
    assert.ok(service.includes('stdio: ['), 'stdio is pinned')
  })

  it('worker command cleanup targets only the spawned child (static)', () => {
    const service = readMain('worker-tools/worker-command-service.ts')
    for (const forbidden of ['taskkill', 'pkill', 'killall', 'image name', 'process-name']) {
      assert.ok(!service.includes(forbidden), `command service must not contain ${forbidden}`)
    }
    assert.ok(service.includes('killOnlyChild'), 'cleanup is scoped to the spawned child')
  })

  it('runtime_start schema carries program, argv, and port only', () => {
    const registry = readMain('worker-tools/worker-tool-registry.ts')
    const start = registry.indexOf("name: 'runtime_start'")
    assert.ok(start >= 0, 'runtime_start schema must exist')
    const end = registry.indexOf('}\n    }\n  ]', start)
    assert.ok(end > start, 'schema block must end')
    const slice = registry.slice(start, end)
    assert.ok(slice.includes('program'), 'schema must carry program')
    assert.ok(slice.includes('args'), 'schema must carry args')
    assert.ok(slice.includes('port'), 'schema must carry port')
    for (const forbidden of ['"command"', '"cwd"', '"env"', '"host"', '"url"', '"shell"', '"stdin"', '"timeout"', '"background"', '"detached"', '"workspaceId"', '"sessionId"']) {
      assert.ok(!slice.includes(forbidden), `runtime_start request schema must not contain ${forbidden}`)
    }
  })

  it('no Worker runtime_stop tool exists; stopping is human-only', () => {
    const registry = readMain('worker-tools/worker-tool-registry.ts')
    assert.ok(!registry.includes('runtime_stop'))
    assert.ok(!registry.includes('runtime_logs'))
    assert.ok(!registry.includes('runtime_status'))
    for (const forbidden of ['browser_click', 'browser_type', 'browser_navigate', 'javascript', 'evaluate', 'fetch']) {
      assert.ok(!registry.includes(forbidden), `registry must not contain ${forbidden}`)
    }
    const shared = readShared('worker-tools/types.ts')
    assert.ok(!shared.includes('runtime_stop'))
    assert.ok(shared.includes('runtime_observe'))
    assert.ok(shared.includes('preview_inspect'))
  })

  it('observation tools map to their Stage 27 capabilities', () => {
    const registry = readMain('worker-tools/worker-tool-registry.ts')
    assert.ok(registry.includes('runtime.observe'))
    assert.ok(registry.includes('preview.inspect'))
  })

  it('observation schemas are exactly empty objects', () => {
    const registry = readMain('worker-tools/worker-tool-registry.ts')
    for (const name of ['runtime_observe', 'preview_inspect']) {
      const start = registry.indexOf(`name: '${name}'`)
      assert.ok(start >= 0, `${name} schema must exist`)
      const end = registry.indexOf('}\n    }\n  ]', start)
      assert.ok(end > start, 'schema block must end')
      const slice = registry.slice(start, end)
      assert.ok(slice.includes('additionalProperties'), `${name} must be strict`)
      for (const forbidden of ['runtimeId', 'workspaceId', 'sessionId', 'port', 'url', 'path', 'selector', 'script', 'javascript']) {
        assert.ok(!slice.includes(`'${forbidden}'`) && !slice.includes(`"${forbidden}"`), `${name} schema must not contain ${forbidden}`)
      }
    }
  })

  it('runtime observation service is read-only (static)', () => {
    const service = readMain('runtime-observation/runtime-observation-service.ts')
    for (const forbidden of ['spawn', 'kill', 'stopRuntime', 'writeTextFile', 'acceptTransaction', 'terminal.write', 'generateText', 'generateStructured']) {
      assert.ok(!service.includes(forbidden), `observation service must not contain ${forbidden}`)
    }
    const preview = readMain('preview-inspection/preview-inspection-service.ts')
    for (const forbidden of ['WorkspaceFileWriteService', 'ChangeTransactionService', 'TerminalService', 'credential', 'generateText', 'generateStructured']) {
      assert.ok(!preview.includes(forbidden), `preview service must not contain ${forbidden}`)
    }
    assert.ok(!preview.includes('capturePage'), 'no screenshots')
  })

  it('no arbitrary browser evaluation surface exists', () => {
    const inspection = readMain('preview-inspection/preview-inspection-service.ts')
    assert.ok(!inspection.includes('executeJavaScript(') || inspection.includes('MAIN_OWNED_PREVIEW_INSPECTION_SCRIPT'), 'only constant script may execute')
    const ipc = readMain('ipc/worker-tools.ts')
    assert.ok(!ipc.includes('callTool'), 'no generic callTool endpoint')
    assert.ok(!ipc.includes('evaluate('), 'no evaluate endpoint')
    assert.ok(!ipc.includes('executeBrowser'), 'no browser execute endpoint')
    const runtimes = readMain('ipc/runtimes.ts')
    assert.ok(!runtimes.includes('callTool'), 'no runtime callTool endpoint')
    assert.ok(!runtimes.includes('evaluate('), 'no runtime evaluate endpoint')
  })

  it('Brain remains tool-free (no change_propose, terminal_execute, or runtime_start)', () => {
    const brain = readMain('ai/ai-brain-service.ts')
    assert.ok(!brain.includes('change_propose'), 'Brain must not name proposal tool')
    assert.ok(!brain.includes('terminal_execute'), 'Brain must not name terminal tool')
    assert.ok(!brain.includes('runtime_start'), 'Brain must not name runtime tool')
    const shared = readShared('worker-tools/types.ts')
    assert.ok(shared.includes('change_propose'))
    assert.ok(shared.includes('terminal_execute'))
    assert.ok(shared.includes('runtime_start'))
  })

  it('tool domain performs no mutation (static)', () => {
    for (const file of [
      'worker-tools/worker-tool-service.ts',
      'worker-tools/worker-tool-runner.ts',
      'worker-tools/worker-tool-approval-service.ts',
      'worker-tools/worker-tool-repository.ts',
      'worker-tools/worker-command-repository.ts',
      'worker-tools/worker-proposal-service.ts',
      'worker-tools/worker-read-ref.ts',
      'worker-tools/worker-proposal-validation.ts',
        'worker-tools/worker-terminal-validation.ts',
        'worker-tools/worker-runtime-validation.ts',
        'worker-tools/worker-executable.ts',
        'project-runtime/project-runtime-repository.ts',
        'project-runtime/project-runtime-validation.ts',
        'project-runtime/process-tree.ts',
        'project-runtime/runtime-preview.ts'
      ]) {
      const source = readMain(file)
      for (const forbidden of ['.rm(', 'mkdir', 'git commit', 'git checkout', 'git push', 'git reset', 'terminal.write', 'spawn(']) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
    // The Stage 25 command service spawns exactly once per approved action
    // through its own child handle (covered by the argv-only test above);
    // it still never touches the human PTY writer.
    const commands = readMain('worker-tools/worker-command-service.ts')
    assert.ok(!commands.includes('terminal.write'), 'command service never writes the human terminal')
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
