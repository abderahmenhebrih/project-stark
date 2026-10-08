import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { createServices } from '../application/create-services'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { TerminalManager } from '../terminal/terminal-manager'
import { createIpcBindings } from './index'
import { createSessionBindings } from './sessions'
import { createSessionContextBindings } from './session-context'

function openServices(): { db: DatabaseSync; services: ReturnType<typeof createServices> } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  return {
    db,
    services: createServices({
      keyValue: new KeyValueRepository(db),
      workspaces: new WorkspaceRepository(db),
      changeTransactions: new ChangeTransactionRepository(db),
      codingSessions: new CodingSessionRepository(db),
      aiProviders: new AiProviderRepository(db)
    })
  }
}

function openFixture(): { db: DatabaseSync; services: ReturnType<typeof createServices>; dir: string; root: string } {
  const { db, services } = openServices()
  const dir = mkdtempSync(join(tmpdir(), 'stark-ctx-ipc-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const a = 1\nconst b = 2\n')
  return { db, services, dir, root }
}

const EXPECTED_CHANNELS = [
  'stark:session-context:prepare-excerpt',
  'stark:session-context:prepare-file',
  'stark:session-context:prepare-search-match',
  'stark:session-context:prepare-note'
] as const

describe('session context IPC bindings', () => {
  it('exposes exactly the four prepare channels', () => {
    const { db, services } = openServices()
    try {
      const channels = createSessionContextBindings(services.sessionContextService).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), [...EXPECTED_CHANNELS].sort())
    } finally {
      db.close()
    }
  })

  it('full surface contains the prepare channels and no raw channels', () => {
    const { db, services } = openServices()
    try {
      const terminalManager = new TerminalManager(
        {
          spawn: () => {
            throw new Error('pty spawn must not run in surface tests')
          }
        },
        { sendData: () => {}, sendExit: () => {} }
      )
      const channels = createIpcBindings({
        settingsService: services.settingsService,
        profileService: services.profileService,
        workspaceService: services.workspaceService,
        workspaceFilesService: services.workspaceFilesService,
        workspaceFileWriteService: services.workspaceFileWriteService,
        workspaceSearchService: services.workspaceSearchService,
        changeTransactionService: services.changeTransactionService,
        terminalService: services.terminalService,
        terminalManager,
        gitService: services.gitService,
        codingSessionService: services.codingSessionService,
        sessionContextService: services.sessionContextService,
        aiProviderService: services.aiProviderService,
        aiCompletionService: services.aiCompletionService
      }).map((binding) => binding.channel)
      for (const expected of EXPECTED_CHANNELS) {
        assert.ok(channels.includes(expected), `missing ${expected}`)
      }
      for (const forbidden of ['session-context:run', 'context:fetch', 'context:exec', 'send-assistant', 'provider:run']) {
        for (const channel of channels) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      db.close()
    }
  })

  it('prepare-excerpt delegates to the service', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = createSessionContextBindings(fixture.services.sessionContextService)
      const prepare = bindings.find((binding) => binding.channel === 'stark:session-context:prepare-excerpt')
      assert.ok(prepare !== undefined)
      const draft = (await prepare.invoke({
        workspaceId: created.id,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 1
      })) as { kind: string; content: string }
      assert.equal(draft.kind, 'file-excerpt')
      assert.equal(draft.content, 'const a = 1')
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('validates prepare payloads strictly', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = createSessionContextBindings(fixture.services.sessionContextService)
      const excerpt = bindings.find((binding) => binding.channel === 'stark:session-context:prepare-excerpt')
      const note = bindings.find((binding) => binding.channel === 'stark:session-context:prepare-note')
      assert.ok(excerpt !== undefined && note !== undefined)
      for (const bad of [
        null,
        {},
        { workspaceId: created.id, relativePath: 'app.ts', lineStart: 2, lineEnd: 1 },
        { workspaceId: created.id, relativePath: '../evil.ts', lineStart: 1, lineEnd: 1 },
        { workspaceId: created.id, relativePath: 'app.ts', lineStart: 1, lineEnd: 1, content: 'forged' }
      ]) {
        await assert.rejects(excerpt.invoke(bad), /We couldn’t attach this context\.|The selected line range is invalid\./)
      }
      for (const bad of [
        null,
        { workspaceId: created.id, content: '' },
        { workspaceId: created.id, content: 'ok', extra: true }
      ]) {
        await assert.rejects(note.invoke(bad), /We couldn’t attach this context\./)
      }
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('send-user-message persists prepared context end to end', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const session = await fixture.services.codingSessionService.createSession({ workspaceId: created.id })
      const contextBindings = createSessionContextBindings(fixture.services.sessionContextService)
      const prepare = contextBindings.find((binding) => binding.channel === 'stark:session-context:prepare-file')
      assert.ok(prepare !== undefined)
      const draft = await prepare.invoke({ workspaceId: created.id, relativePath: 'app.ts' })
      const sessionBindings = createSessionBindings(fixture.services.codingSessionService)
      const send = sessionBindings.find((binding) => binding.channel === 'stark:sessions:send-user-message')
      assert.ok(send !== undefined)
      const result = (await send.invoke({
        workspaceId: created.id,
        sessionId: session.id,
        content: 'Explain.',
        context: [draft]
      })) as { context?: readonly { kind: string }[] }
      assert.equal(result.context?.length, 1)
      assert.equal(result.context?.[0]?.kind, 'whole-file')
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('maps failures without implementation details', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createSessionContextBindings(services.sessionContextService)
      const prepare = bindings.find((binding) => binding.channel === 'stark:session-context:prepare-file')
      assert.ok(prepare !== undefined)
      await assert.rejects(prepare.invoke({ workspaceId: 999999, relativePath: 'a.ts' }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(!error.message.includes('stark:'))
        assert.ok(!error.message.includes('sqlite'))
        return true
      })
    } finally {
      db.close()
    }
  })
})
