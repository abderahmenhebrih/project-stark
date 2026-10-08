import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

describe('proposal architecture boundaries', () => {
  it('proposal domain never imports or calls the direct file writer', () => {
    const service = readSource('src', 'main', 'ai', 'ai-code-proposal-service.ts')
    for (const forbidden of ['WorkspaceFileWriteService', 'writeTextFile', 'workspace-file-write-service']) {
      assert.ok(!service.includes(forbidden), `proposal service must not contain ${forbidden}`)
    }
    // The ONLY mutation route is the Stage 9 transaction service.
    assert.ok(service.includes('ChangeTransactionService'), 'proposal must go through ChangeTransactionService')
    assert.ok(service.includes('createFileChange'), 'proposal must create via createFileChange')
  })

  it('proposal domain has no agent authority', () => {
    const service = readSource('src', 'main', 'ai', 'ai-code-proposal-service.ts')
    const guard = readSource('src', 'main', 'ai', 'ai-operation-guard.ts')
    const adapter = readSource('src', 'main', 'ai', 'openai-adapter.ts')
    // Code-level imports and calls only — prose comments may name the
    // forbidden domains to document their absence.
    for (const source of [service, guard]) {
      for (const forbidden of [
        'node-pty',
        'child_process',
        'TerminalManager',
        'GitProcessRunner',
        'git-process-runner',
        '../terminal/',
        '../git/',
        './terminal',
        'execSync',
        'spawn(',
        'tool_choice',
        'previous_response_id',
        'previousResponseId'
      ]) {
        assert.ok(!source.includes(forbidden), `proposal domain must not contain ${forbidden}`)
      }
    }
    // The adapter may use its existing network SDK only: no shell, no
    // pty, no git, no tools in the request.
    for (const forbidden of ['node-pty', 'child_process', 'GitProcessRunner']) {
      assert.ok(!adapter.includes(forbidden), `adapter must not contain ${forbidden}`)
    }
  })

  it('proposal IPC takes no path, content, revision, or model from the renderer', () => {
    const ipc = readSource('src', 'main', 'ipc', 'ai.ts')
    assert.ok(ipc.includes('aiProposeFileChange'), 'IPC must expose the proposal channel')
    for (const forbidden of ['proposedContent', 'expectedRevision', 'relativePath', 'model:']) {
      assert.ok(!ipc.includes(forbidden), `proposal IPC must not contain ${forbidden}`)
    }
    const service = readSource('src', 'main', 'ai', 'ai-code-proposal-service.ts')
    // Target path comes from persisted context only.
    assert.ok(service.includes('listContextForMessage'), 'proposal must load persisted context')
  })

  it('structured proposal request carries no tools', () => {
    const adapter = readSource('src', 'main', 'ai', 'openai-adapter.ts')
    assert.ok(adapter.includes('json_schema'), 'adapter must use Structured Outputs')
    assert.ok(adapter.includes('strict: true') || adapter.includes('strict:true'), 'schema must be strict')
    assert.ok(adapter.includes('store: false'), 'proposal must retain store:false')
  })
})
