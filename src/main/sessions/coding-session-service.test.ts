import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionService } from './coding-session-service'
import { MAX_MESSAGE_BYTES } from './limits'

function openService(clock?: () => number): {
  db: DatabaseSync
  service: CodingSessionService
  workspaces: WorkspaceRepository
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  return { db, service: new CodingSessionService(workspaces, sessions, clock === undefined ? undefined : { now: clock }), workspaces }
}

function createWorkspace(workspaces: WorkspaceRepository, rootPath: string, now = 1000): number {
  return workspaces.create({ rootPath, displayName: rootPath, now }).id
}

describe('coding session service', () => {
  it('creates a session for a valid workspace', async () => {
    const { db, service, workspaces } = openService(() => 5000)
    try {
      const workspaceId = createWorkspace(workspaces, 'w1')
      const session = await service.createSession({ workspaceId })
      assert.equal(session.workspaceId, workspaceId)
      assert.equal(session.title, 'New session')
      assert.equal(session.createdAt, 5000)
      assert.equal(session.updatedAt, 5000)
    } finally {
      db.close()
    }
  })

  it('rejects creation for a missing workspace', async () => {
    const { db, service } = openService()
    try {
      // Missing rows surface as workspace-gone; malformed payloads throw
      // typed request errors that the IPC layer maps to public copy.
      const { InvalidSessionRequestError, toPublicSessionError } = await import('./errors')
      await assert.rejects(service.createSession({ workspaceId: 999 }), /That project folder is no longer available\./)
      await assert.rejects(service.createSession({ workspaceId: '1' }), InvalidSessionRequestError)
      await assert.rejects(service.createSession({}), InvalidSessionRequestError)
      await assert.rejects(service.createSession({ workspaceId: 1, title: 'chosen' }), InvalidSessionRequestError)
      assert.equal(
        toPublicSessionError('create', new InvalidSessionRequestError('workspace reference is invalid')).message,
        'We couldn’t create this session.'
      )
    } finally {
      db.close()
    }
  })

  it('keeps workspace A sessions invisible from workspace B', async () => {
    const { db, service, workspaces } = openService()
    try {
      const first = createWorkspace(workspaces, 'a')
      const second = createWorkspace(workspaces, 'b')
      await service.createSession({ workspaceId: first })
      assert.equal((await service.listSessions({ workspaceId: second })).length, 0)
      assert.equal((await service.listSessions({ workspaceId: first })).length, 1)
    } finally {
      db.close()
    }
  })

  it('sends a valid user message with role forced to user', async () => {
    const { db, service, workspaces } = openService(() => 7000)
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const created = await service.createSession({ workspaceId })
      const result = await service.sendUserMessage({ workspaceId, sessionId: created.id, content: 'Hello STARK' })
      assert.equal(result.message.role, 'user')
      assert.equal(result.message.content, 'Hello STARK')
      assert.equal(result.message.sessionId, created.id)
      assert.equal(result.session.updatedAt, 7000)
    } finally {
      db.close()
    }
  })

  it('rejects empty and whitespace-only messages', async () => {
    const { db, service, workspaces } = openService()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const created = await service.createSession({ workspaceId })
      for (const content of ['', '   ', '\n\t ']) {
        await assert.rejects(
          service.sendUserMessage({ workspaceId, sessionId: created.id, content }),
          /We couldn’t save this message\./
        )
      }
    } finally {
      db.close()
    }
  })

  it('enforces the 64 KiB boundary in encoded bytes', async () => {
    const { db, service, workspaces } = openService()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const created = await service.createSession({ workspaceId })
      const atLimit = await service.sendUserMessage({
        workspaceId,
        sessionId: created.id,
        content: 'a'.repeat(MAX_MESSAGE_BYTES)
      })
      assert.equal(atLimit.message.content.length, MAX_MESSAGE_BYTES)
      await assert.rejects(
        service.sendUserMessage({ workspaceId, sessionId: created.id, content: `${'a'.repeat(MAX_MESSAGE_BYTES)}b` }),
        /This message is too large\./
      )
    } finally {
      db.close()
    }
  })

  it('rejects NUL and unpaired surrogates', async () => {
    const { db, service, workspaces } = openService()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const created = await service.createSession({ workspaceId })
      await assert.rejects(
        service.sendUserMessage({ workspaceId, sessionId: created.id, content: 'bad\0msg' }),
        /We couldn’t save this message\./
      )
      await assert.rejects(
        service.sendUserMessage({ workspaceId, sessionId: created.id, content: 'lone \uD800' }),
        /We couldn’t save this message\./
      )
    } finally {
      db.close()
    }
  })

  it('accepts Unicode and preserves newlines exactly', async () => {
    const { db, service, workspaces } = openService()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const created = await service.createSession({ workspaceId })
      const content = 'caf\u00e9 \u65e5\u672c\u8a9e\nsecond\ttabbed'
      const result = await service.sendUserMessage({ workspaceId, sessionId: created.id, content })
      assert.equal(result.message.content, content)
    } finally {
      db.close()
    }
  })

  it('derives a deterministic title from the first message only', async () => {
    let now = 1000
    const { db, service, workspaces } = openService(() => now)
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const created = await service.createSession({ workspaceId })
      now = 2000
      const first = await service.sendUserMessage({
        workspaceId,
        sessionId: created.id,
        content: '  Fix the\n   authentication   middleware  '
      })
      assert.equal(first.session.title, 'Fix the authentication middleware')
      now = 3000
      const second = await service.sendUserMessage({ workspaceId, sessionId: created.id, content: 'Another topic here' })
      assert.equal(second.session.title, 'Fix the authentication middleware')
      assert.equal(second.session.updatedAt, 3000)
    } finally {
      db.close()
    }
  })

  it('bounds titles to 80 code points', async () => {
    const { db, service, workspaces } = openService()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const created = await service.createSession({ workspaceId })
      const result = await service.sendUserMessage({ workspaceId, sessionId: created.id, content: 'y'.repeat(500) })
      assert.ok([...result.session.title].length <= 81)
      assert.ok(result.session.title.endsWith('\u2026'))
    } finally {
      db.close()
    }
  })

  it('rejects session/workspace mismatch without leaking', async () => {
    const { db, service, workspaces } = openService()
    try {
      const first = createWorkspace(workspaces, 'a')
      const second = createWorkspace(workspaces, 'b')
      const created = await service.createSession({ workspaceId: first })
      await assert.rejects(
        service.sendUserMessage({ workspaceId: second, sessionId: created.id, content: 'hi' }),
        /That session is no longer available\./
      )
      await assert.rejects(
        service.listMessages({ workspaceId: second, sessionId: created.id }),
        /That session is no longer available\./
      )
      await assert.rejects(
        service.listMessages({ workspaceId: first, sessionId: 9999 }),
        /That session is no longer available\./
      )
    } finally {
      db.close()
    }
  })

  it('pages messages bounded to 100 with hasMore probing', async () => {
    const { db, service, workspaces } = openService()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const created = await service.createSession({ workspaceId })
      for (let index = 1; index <= 5; index += 1) {
        await service.sendUserMessage({ workspaceId, sessionId: created.id, content: `message ${String(index)}` })
      }
      const latest = await service.listMessages({ workspaceId, sessionId: created.id })
      assert.equal(latest.messages.length, 5)
      assert.equal(latest.hasMore, false)
      assert.deepEqual(
        latest.messages.map((entry) => entry.content),
        ['message 1', 'message 2', 'message 3', 'message 4', 'message 5']
      )
    } finally {
      db.close()
    }
  })

  it('probes hasMore across the 100-message boundary', async () => {
    const { db, service, workspaces } = openService()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const created = await service.createSession({ workspaceId })
      for (let index = 1; index <= 105; index += 1) {
        await service.sendUserMessage({ workspaceId, sessionId: created.id, content: `bulk ${String(index)}` })
      }
      const latest = await service.listMessages({ workspaceId, sessionId: created.id })
      assert.equal(latest.messages.length, 100)
      assert.equal(latest.hasMore, true)
      assert.equal(latest.messages[0]?.content, 'bulk 6')
      assert.equal(latest.messages[99]?.content, 'bulk 105')
      const older = await service.listMessages({
        workspaceId,
        sessionId: created.id,
        beforeMessageId: latest.messages[0]?.id
      })
      assert.equal(older.messages.length, 5)
      assert.equal(older.hasMore, false)
      assert.equal(older.messages[0]?.content, 'bulk 1')
    } finally {
      db.close()
    }
  })

  it('rejects invalid beforeMessageId values', async () => {
    const { db, service, workspaces } = openService()
    try {
      const workspaceId = createWorkspace(workspaces, 'w')
      const created = await service.createSession({ workspaceId })
      const { InvalidSessionRequestError, toPublicSessionError } = await import('./errors')
      for (const beforeMessageId of [0, -1, 1.5, '3', Number.NaN]) {
        await assert.rejects(
          service.listMessages({ workspaceId, sessionId: created.id, beforeMessageId }),
          InvalidSessionRequestError
        )
      }
      await assert.rejects(
        service.listMessages({ workspaceId, sessionId: created.id, extra: true }),
        InvalidSessionRequestError
      )
      assert.equal(
        toPublicSessionError('list-messages', new InvalidSessionRequestError('message page reference is invalid')).message,
        'We couldn’t load these messages.'
      )
    } finally {
      db.close()
    }
  })

  it('exposes no assistant-writing method to the renderer path', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'sessions', 'coding-session-service.ts'), 'utf8')
    assert.ok(!source.includes('sendAssistantMessage'), 'service must not offer assistant writes')
    assert.ok(!source.includes('send-assistant'), 'service must not reference assistant IPC')
    // The renderer-reachable protocol is exactly the four public
    // operations (TypeScript `private` helpers live on the prototype at
    // runtime but are never invoked through IPC — only the binding
    // methods below are).
    for (const method of ['createSession', 'listSessions', 'listMessages', 'sendUserMessage'] as const) {
      assert.equal(typeof CodingSessionService.prototype[method], 'function', `${method} must exist`)
    }
    const proto = Object.getOwnPropertyNames(CodingSessionService.prototype)
    assert.ok(!proto.some((name) => name.toLowerCase().includes('assistant')), 'no assistant-named method may exist')
  })
})
