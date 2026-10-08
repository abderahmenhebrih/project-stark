import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

const LOOPLINK_SOURCES = [
  'main/looplink/looplink-service.ts',
  'main/looplink/looplink-repository.ts',
  'main/looplink/looplink-payload.ts',
  'main/looplink/looplink-errors.ts',
  'main/looplink/looplink-limits.ts'
]

describe('looplink architecture boundaries', () => {
  it('looplink domain imports no provider, filesystem, or command authority', () => {
    for (const relative of LOOPLINK_SOURCES) {
      const source = readSource('src', ...relative.split('/'))
      for (const forbidden of [
        'OpenAI',
        'AiProviderAdapter',
        'generateText',
        'generateStructured',
        'WorkspaceFilesService',
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
        '../terminal/',
        '../git/'
      ]) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
    // Allowed read-only dependencies only.
    const service = readSource('src', 'main', 'looplink', 'looplink-service.ts')
    assert.ok(service.includes('CodingSessionRepository'), 'reads sessions from the repository')
    assert.ok(service.includes('LooplinkRepository'), 'persists through its own repository')
  })

  it('looplink creation, reads, and dismissal add zero provider calls', () => {
    for (const relative of ['main/looplink/looplink-service.ts', 'main/ipc/looplink.ts']) {
      const source = readSource('src', ...relative.split('/'))
      for (const forbidden of ['generateText', 'generateStructured', 'OpenAI', 'fetch(', 'http', 'axios']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })

  it('no nested payload construction exists', () => {
    const service = readSource('src', 'main', 'looplink', 'looplink-service.ts')
    // Payloads derive from session messages/context only — the builder
    // never reads stored handoff payloads when building a new one.
    const buildSection = service.slice(service.indexOf('private buildPayload'))
    assert.ok(!buildSection.includes('findById'), 'builder must not re-read handoffs')
    assert.ok(!buildSection.includes('listRecentFromSource'), 'builder must not re-read handoffs')
  })

  it('completion paths never auto-send or start AI work', () => {
    for (const relative of ['main/looplink/looplink-service.ts', 'main/looplink/looplink-repository.ts']) {
      const source = readSource('src', ...relative.split('/'))
      for (const forbidden of ['sendUserMessage', 'generateResponse', 'runBrain', 'proposeFileChange', 'proposeChangeSet']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })
})
