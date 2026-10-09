import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AGENT_CAPABILITIES, isKnownCapability, legalModesFor } from './capability-registry'

function readMain(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'main', relative), 'utf8')
}

function readShared(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'shared', relative), 'utf8')
}

describe('capability registry contract', () => {
  it('contains exactly the seven Stage 27 capabilities', () => {
    assert.deepEqual([...AGENT_CAPABILITIES], [
      'workspace.read',
      'workspace.search',
      'git.read',
      'change.propose',
      'terminal.execute',
      'runtime.observe',
      'preview.inspect'
    ])
    for (const capability of AGENT_CAPABILITIES) {
      assert.ok(isKnownCapability(capability))
    }
    assert.ok(!isKnownCapability('file.write'))
    assert.ok(!isKnownCapability(''))
  })

  it('defines legal modes with terminal allow forbidden', () => {
    assert.deepEqual([...legalModesFor('workspace.read')], ['deny', 'ask', 'allow'])
    assert.deepEqual([...legalModesFor('workspace.search')], ['deny', 'ask', 'allow'])
    assert.deepEqual([...legalModesFor('git.read')], ['deny', 'ask', 'allow'])
    assert.deepEqual([...legalModesFor('change.propose')], ['deny', 'ask', 'allow'])
    assert.deepEqual([...legalModesFor('terminal.execute')], ['deny', 'ask'])
    assert.deepEqual([...legalModesFor('runtime.observe')], ['deny', 'ask', 'allow'])
    assert.deepEqual([...legalModesFor('preview.inspect')], ['deny', 'ask', 'allow'])
  })

  it('defines no direct-write/accept/rollback/delete/credential capability', () => {
    const registry = readMain('capabilities/capability-registry.ts')
    const shared = readShared('capabilities/types.ts')
    for (const forbidden of [
      'direct-file-write',
      'accept-transaction',
      'reject-transaction',
      'rollback-transaction',
      'delete-file',
      'rename-file',
      'move-file',
      'raw-shell',
      'arbitrary-node',
      'arbitrary-fs',
      'credential-read',
      'provider-secret-read',
      'file.write',
      'filesystem.write',
      'transaction.accept',
      'transaction.reject',
      'transaction.rollback',
      'shell.raw',
      'credential.read'
    ]) {
      assert.ok(!registry.includes(forbidden), `registry must not contain ${forbidden}`)
      assert.ok(!shared.includes(forbidden), `shared types must not contain ${forbidden}`)
    }
    // change.propose is proposal-only, not a write bypass.
    assert.ok(registry.includes('change.propose'))
    const combined = `${registry}\n${shared}`.toLowerCase()
    assert.ok(!combined.includes('direct-file-write'))
  })

  it('shared capability type has no write/delete/rename/move/accept/rollback capability', () => {
    const shared = readShared('capabilities/types.ts')
    const union = shared.slice(shared.indexOf('type AgentCapability'), shared.indexOf('type AgentCapability') + 500)
    for (const forbidden of ['write', 'delete', 'rename', 'move', 'accept', 'rollback']) {
      assert.ok(!union.includes(forbidden), `capability union must not contain ${forbidden}`)
    }
    assert.ok(union.includes('change.propose'))
  })
})

describe('capability zero-authority architecture', () => {
  it('capability domain imports/calls no FS/Git/terminal/proposal/provider authority', () => {
    for (const file of [
      'capabilities/capability-registry.ts',
      'capabilities/capability-errors.ts',
      'capabilities/capability-repository.ts',
      'capabilities/capability-service.ts',
      'capabilities/capability-gate.ts'
    ]) {
      const source = readMain(file)
      for (const forbidden of [
        'WorkspaceFilesService',
        'WorkspaceFileWriteService',
        'WorkspaceSearchService',
        'GitProcessRunner',
        'git-process-runner',
        'TerminalManager',
        'node-pty',
        'ChangeTransactionService',
        'ChangeSetService',
        'OpenAI',
        'openai-adapter',
        'provider-adapter',
        'generateText',
        'generateStructured',
        'child_process',
        'node:fs',
        "from 'node:fs",
        'shell',
        'fetch('
      ]) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
  })

  it('capability domain performs zero provider calls (static)', () => {
    for (const file of [
      'capabilities/capability-registry.ts',
      'capabilities/capability-repository.ts',
      'capabilities/capability-service.ts',
      'capabilities/capability-gate.ts'
    ]) {
      const source = readMain(file)
      for (const forbidden of ['generateText', 'generateStructured', 'fetch(', 'OpenAI', 'XMLHttpRequest']) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
      assert.ok(!source.includes('setInterval'), `${file} must not poll`)
      assert.ok(!source.includes('setTimeout'), `${file} must not wait`)
    }
  })

  it('existing human workflows never consult CapabilityGate', () => {
    for (const file of [
      'workspace-files/workspace-files-service.ts',
      'workspace-search/workspace-search-service.ts',
      'git/git-service.ts',
      'terminal/terminal-service.ts',
      'ai/ai-completion-service.ts',
      'ai/ai-brain-service.ts',
      'ai/ai-code-proposal-service.ts',
      'heart/heart-service.ts',
      'looplink/looplink-service.ts',
      'recovery/recovery-coordinator.ts'
    ]) {
      const source = readMain(file)
      assert.ok(!source.includes('CapabilityGate'), `${file} must not consult the gate`)
      assert.ok(!source.includes('capability-gate'), `${file} must not consult the gate`)
    }
  })

  it('no polling, retries, recursion, kills, or WAL/SHM copying in capability domain', () => {
    for (const file of [
      'capabilities/capability-service.ts',
      'capabilities/capability-gate.ts',
      'capabilities/capability-repository.ts',
      'ipc/capabilities.ts'
    ]) {
      const source = readMain(file)
      assert.ok(!source.includes('setInterval'), `${file}: no polling`)
      assert.ok(!source.includes('while ('), `${file}: no loops`)
      assert.ok(!source.includes('process.kill'), `${file}: no kills`)
      assert.ok(!source.includes('.shm'), `${file}: no SHM copying`)
      assert.ok(!source.includes('.wal'), `${file}: no WAL copying`)
    }
    const gate = readMain('capabilities/capability-gate.ts')
    assert.ok(!gate.toLowerCase().includes('recursi'), 'gate must not recurse')
  })
})
