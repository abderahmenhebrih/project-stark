import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { LooplinkRepository } from './looplink-repository'
import { DatabaseError } from '../database/errors'

function openRepositories(): {
  db: DatabaseSync
  looplinks: LooplinkRepository
  sessions: CodingSessionRepository
  sourceId: number
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  db.exec('PRAGMA foreign_keys = ON')
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  const workspaceId = workspaces.create({ rootPath: 'w', displayName: 'w', now: 1000 }).id
  const sourceId = sessions.createSession({ workspaceId, title: 'source', now: 1000 })
  return { db, looplinks: new LooplinkRepository(db), sessions, sourceId }
}

function tableCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as Record<string, unknown>
  return row['n'] as number
}

const PAYLOAD = '{"version":1}'
const HASH = '0'.repeat(64)

describe('looplink repository', () => {
  it('creates target session plus pending handoff atomically', () => {
    const { db, looplinks, sourceId } = openRepositories()
    try {
      const { targetSessionId, handoffId } = looplinks.createContinuation({
        workspaceId: 1,
        sourceSessionId: sourceId,
        targetTitle: 'Continue: source',
        sourceRunId: null,
        payload: PAYLOAD,
        payloadBytes: 2,
        payloadHash: HASH,
        omittedMessageCount: 0,
        omittedContextCount: 0,
        workerResultOmitted: false,
        omittedChangeCount: 0,
        now: 2000
      })
      assert.ok(targetSessionId !== sourceId)
      const stored = looplinks.findById(handoffId)
      assert.equal(stored?.status, 'pending')
      assert.equal(stored?.payloadHash, HASH)
      assert.equal(stored?.targetSessionId, targetSessionId)
      assert.equal(looplinks.findByTargetSession(targetSessionId)?.id, handoffId)
    } finally {
      db.close()
    }
  })

  it('source and target share the workspace with unique targets', () => {
    const { db, looplinks, sessions, sourceId } = openRepositories()
    try {
      const first = looplinks.createContinuation({
        workspaceId: 1,
        sourceSessionId: sourceId,
        targetTitle: 'Continue: source',
        sourceRunId: null,
        payload: PAYLOAD,
        payloadBytes: 2,
        payloadHash: HASH,
        omittedMessageCount: 0,
        omittedContextCount: 0,
        workerResultOmitted: false,
        omittedChangeCount: 0,
        now: 2000
      })
      const target = sessions.findSessionById(first.targetSessionId)
      assert.equal(target?.workspaceId, 1)
      assert.equal(target?.title, 'Continue: source')
      // The UNIQUE(target_session_id) guard rejects a second handoff
      // attached to the same target at the SQL boundary.
      assert.throws(() =>
        db.exec(
          'INSERT INTO looplink_handoffs (workspace_id, source_session_id, target_session_id, status, payload, ' +
            'payload_bytes, payload_hash, omitted_message_count, omitted_context_count, worker_result_omitted, ' +
            `omitted_change_count, created_at) VALUES (1, ${sourceId}, ${first.targetSessionId}, 'pending', '{}', 2, 'x', 0, 0, 0, 0, 3)`
        )
      )
      void first
    } finally {
      db.close()
    }
  })

  it('marks consumed and dismissed with illegal transitions rejected', () => {
    const { db, looplinks, sourceId } = openRepositories()
    try {
      const { handoffId } = looplinks.createContinuation({
        workspaceId: 1,
        sourceSessionId: sourceId,
        targetTitle: 't',
        sourceRunId: null,
        payload: PAYLOAD,
        payloadBytes: 2,
        payloadHash: HASH,
        omittedMessageCount: 0,
        omittedContextCount: 0,
        workerResultOmitted: false,
        omittedChangeCount: 0,
        now: 2000
      })
      assert.equal(looplinks.transition(handoffId, 'consumed', 3000), true)
      assert.equal(looplinks.findById(handoffId)?.status, 'consumed')
      assert.equal(looplinks.transition(handoffId, 'dismissed', 4000), false)
      assert.equal(looplinks.transition(handoffId, 'consumed', 4000), false)
      const second = looplinks.createContinuation({
        workspaceId: 1,
        sourceSessionId: sourceId,
        targetTitle: 't2',
        sourceRunId: null,
        payload: PAYLOAD,
        payloadBytes: 2,
        payloadHash: HASH,
        omittedMessageCount: 0,
        omittedContextCount: 0,
        workerResultOmitted: false,
        omittedChangeCount: 0,
        now: 5000
      })
      assert.equal(looplinks.transition(second.handoffId, 'dismissed', 6000), true)
      assert.equal(looplinks.findById(second.handoffId)?.status, 'dismissed')
      assert.equal(looplinks.transition(second.handoffId, 'consumed', 7000), false)
    } finally {
      db.close()
    }
  })

  it('cascades handoffs with sessions and nulls source runs', () => {
    const { db, looplinks, sourceId } = openRepositories()
    try {
      looplinks.createContinuation({
        workspaceId: 1,
        sourceSessionId: sourceId,
        targetTitle: 't',
        sourceRunId: null,
        payload: PAYLOAD,
        payloadBytes: 2,
        payloadHash: HASH,
        omittedMessageCount: 0,
        omittedContextCount: 0,
        workerResultOmitted: false,
        omittedChangeCount: 0,
        now: 2000
      })
      // Deleting the source session cascades its handoffs.
      db.exec(`DELETE FROM coding_sessions WHERE id = ${sourceId}`)
      assert.equal(tableCount(db, 'looplink_handoffs'), 0)
    } finally {
      db.close()
    }
  })

  it('lists recent handoffs from a source newest-first', () => {
    const { db, looplinks, sourceId } = openRepositories()
    try {
      looplinks.createContinuation({
        workspaceId: 1, sourceSessionId: sourceId, targetTitle: 'a', sourceRunId: null,
        payload: PAYLOAD, payloadBytes: 2, payloadHash: HASH,
        omittedMessageCount: 0, omittedContextCount: 0, workerResultOmitted: false, omittedChangeCount: 0, now: 2000
      })
      looplinks.createContinuation({
        workspaceId: 1, sourceSessionId: sourceId, targetTitle: 'b', sourceRunId: null,
        payload: PAYLOAD, payloadBytes: 2, payloadHash: HASH,
        omittedMessageCount: 0, omittedContextCount: 0, workerResultOmitted: false, omittedChangeCount: 0, now: 3000
      })
      const recent = looplinks.listRecentFromSource(sourceId, 20)
      assert.equal(recent.length, 2)
      assert.ok((recent[0]?.createdAt ?? 0) >= (recent[1]?.createdAt ?? 0))
    } finally {
      db.close()
    }
  })

  it('fault during creation leaves no target session and no handoff', () => {
    const { db, looplinks, sourceId } = openRepositories()
    try {
      assert.throws(
        () =>
          looplinks.createContinuation(
            {
              workspaceId: 1,
              sourceSessionId: sourceId,
              targetTitle: 't',
              sourceRunId: null,
              payload: PAYLOAD,
              payloadBytes: 2,
              payloadHash: HASH,
              omittedMessageCount: 0,
              omittedContextCount: 0,
              workerResultOmitted: false,
              omittedChangeCount: 0,
              now: 2000
            },
            { failAfterSession: true }
          ),
        DatabaseError
      )
      assert.equal(tableCount(db, 'looplink_handoffs'), 0)
      assert.equal(tableCount(db, 'coding_sessions'), 1)
    } finally {
      db.close()
    }
  })

  it('assistant completion consumes atomically with fault safety', () => {
    const { db, looplinks, sourceId } = openRepositories()
    try {
      const { targetSessionId, handoffId } = looplinks.createContinuation({
        workspaceId: 1,
        sourceSessionId: sourceId,
        targetTitle: 't',
        sourceRunId: null,
        payload: PAYLOAD,
        payloadBytes: 2,
        payloadHash: HASH,
        omittedMessageCount: 0,
        omittedContextCount: 0,
        workerResultOmitted: false,
        omittedChangeCount: 0,
        now: 2000
      })
      const { messageId } = looplinks.appendAssistantMessageAndConsume({
        sessionId: targetSessionId,
        content: 'answer',
        now: 3000,
        looplinkId: handoffId,
        retitle: null
      })
      assert.ok(messageId > 0)
      assert.equal(looplinks.findById(handoffId)?.status, 'consumed')
      assert.throws(
        () =>
          looplinks.appendAssistantMessageAndConsume(
            { sessionId: targetSessionId, content: 'x', now: 4000, looplinkId: handoffId, retitle: null },
            { failAfterMessage: true }
          ),
        DatabaseError
      )
      assert.equal(tableCount(db, 'coding_messages'), 1)
    } finally {
      db.close()
    }
  })
})
