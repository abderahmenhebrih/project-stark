import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { MAX_AI_CONTEXT_BYTES, MAX_AI_CONTEXT_MESSAGES } from './limits'
import { loadBoundedContext } from './context-window'

/**
 * Shared bounded-context proof: the single loader every AI path
 * uses. Latest messages retained, oldest dropped first, byte
 * budget enforced, trailing user message always kept, whole
 * messages only (multi-byte UTF-8 never splits).
 */
function openSessions(): { db: DatabaseSync; sessions: CodingSessionRepository; workspaceId: number } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  const workspaceId = workspaces.create({ rootPath: 'w-ctx', displayName: 'w', now: 1000 }).id
  return { db, sessions, workspaceId }
}

function seedMessages(
  sessions: CodingSessionRepository,
  workspaceId: number,
  contents: readonly string[],
  role: 'user' | 'assistant' = 'user'
): number {
  const sessionId = sessions.createSession({ workspaceId, title: 's', now: 1000 })
  let now = 2000
  for (const content of contents) {
    sessions.appendMessage({ sessionId, role, content, now, retitle: null })
    now += 1
  }
  return sessionId
}

describe('shared bounded context window', () => {
  it('returns messages chronologically within the message cap', () => {
    const { db, sessions, workspaceId } = openSessions()
    try {
      const many = Array.from({ length: MAX_AI_CONTEXT_MESSAGES + 10 }, (_, index) => `message ${String(index).padStart(3, '0')}`)
      const sessionId = seedMessages(sessions, workspaceId, many)
      const context = loadBoundedContext(sessions, sessionId)
      assert.equal(context.length, MAX_AI_CONTEXT_MESSAGES)
      assert.equal(context[0]?.content, `message 010`)
      assert.equal(context[context.length - 1]?.content, `message ${String(many.length - 1).padStart(3, '0')}`)
    } finally {
      db.close()
    }
  })

  it('drops oldest first under the byte budget and always keeps the trailing message', () => {
    const { db, sessions, workspaceId } = openSessions()
    try {
      const big = 'x'.repeat(100 * 1024)
      const sessionId = seedMessages(sessions, workspaceId, [big, big, big, 'trailing'])
      const context = loadBoundedContext(sessions, sessionId)
      assert.ok(context.length >= 1)
      assert.equal(context[context.length - 1]?.content, 'trailing')
      let total = 0
      for (const entry of context) {
        total += Buffer.byteLength(entry.content, 'utf8')
      }
      assert.ok(total <= MAX_AI_CONTEXT_BYTES)
    } finally {
      db.close()
    }
  })

  it('never splits multi-byte content and keeps a single message intact', () => {
    const { db, sessions, workspaceId } = openSessions()
    try {
      const emoji = 'Status: ✅ done 🎉 — naïve façade — 日本語テスト'
      const sessionId = seedMessages(sessions, workspaceId, [emoji])
      const context = loadBoundedContext(sessions, sessionId)
      assert.deepEqual(context.map((entry) => entry.content), [emoji])
      assert.equal(Buffer.byteLength(context[0]?.content ?? '', 'utf8'), Buffer.byteLength(emoji, 'utf8'))
    } finally {
      db.close()
    }
  })

  it('returns an empty context for sessions without messages', () => {
    const { db, sessions, workspaceId } = openSessions()
    try {
      const sessionId = sessions.createSession({ workspaceId, title: 'empty', now: 1000 })
      assert.deepEqual(loadBoundedContext(sessions, sessionId), [])
    } finally {
      db.close()
    }
  })
})
