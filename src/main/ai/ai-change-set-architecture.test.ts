import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

describe('change-set architecture boundaries', () => {
  it('multi-file proposal and change-set services never import the direct writer', () => {
    for (const relative of ['main/ai/ai-multi-file-proposal-service.ts', 'main/change-sets/change-set-service.ts']) {
      const source = readSource('src', ...relative.split('/'))
      for (const forbidden of ['WorkspaceFileWriteService', 'writeTextFile', 'workspace-file-write-service']) {
        // requireLiveWorkspace is the read-only workspace authority
        // re-exported from the writer module and is explicitly allowed.
        if (forbidden === 'workspace-file-write-service') {
          const lines = source.split('\n').filter((line) => line.includes(forbidden))
          for (const line of lines) {
            assert.ok(line.includes('requireLiveWorkspace'), `only the read authority may come from the writer module: ${line}`)
          }
          continue
        }
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
    const multi = readSource('src', 'main', 'ai', 'ai-multi-file-proposal-service.ts')
    assert.ok(multi.includes('ChangeSetService'), 'multi proposal must go through ChangeSetService')
  })

  it('multi-file domain has no agent authority', () => {
    for (const relative of [
      'main/ai/ai-multi-file-proposal-service.ts',
      'main/change-sets/change-set-service.ts',
      'main/database/repositories/change-set-repository.ts'
    ]) {
      const source = readSource('src', ...relative.split('/'))
      for (const forbidden of [
        'node-pty',
        'child_process',
        'TerminalManager',
        'GitProcessRunner',
        'git-process-runner',
        '../terminal/',
        '../git/',
        'execSync',
        'spawn(',
        'tool_choice',
        'previous_response_id',
        'previousResponseId'
      ]) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })

  it('change-set UI offers no Accept All batch control', () => {
    for (const relative of [
      'renderer/src/features/changes/ChangeSetReview.tsx',
      'renderer/src/features/changes/ChangeSetPanel.tsx',
      'renderer/src/features/sessions/SessionPanel.tsx',
      'renderer/src/features/explorer/Explorer.tsx'
    ]) {
      const source = readSource('src', ...relative.split('/'))
      for (const forbidden of ['Accept all', 'Accept All', 'accept-all', 'acceptAll', 'Apply all', 'Apply All', 'applyAll', 'Reject all', 'Rollback all']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })

  it('grouped IPC takes no paths, target IDs, code, model, or revisions from the renderer', () => {
    const ipc = readSource('src', 'main', 'ipc', 'ai.ts')
    assert.ok(ipc.includes('aiProposeChangeSet'), 'AI IPC must expose the change-set channel')
    for (const forbidden of ['proposedContent', 'expectedRevision', 'relativePath', 'targetId', 'targetIds']) {
      assert.ok(!ipc.includes(forbidden), `grouped proposal IPC must not contain ${forbidden}`)
    }
  })
})
