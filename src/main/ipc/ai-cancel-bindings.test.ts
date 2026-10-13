import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { AiOperationGuard } from '../ai/ai-operation-guard'
import { createAiCancelBinding } from './ai'
import { IPC_CHANNELS } from '../../shared/constants'

/**
 * Cancel-operation IPC proof: exactly one narrow channel, strict
 * workspace/session validation, session-scoped idempotent results.
 * The renderer submits references only — main owns authority through
 * the shared guard. No generic cancel(channel) surface exists.
 */
function openBinding(): {
  db: DatabaseSync
  guard: AiOperationGuard
  invoke: (payload: unknown) => Promise<{ cancelled: boolean }>
  workspaceId: number
  sessionId: number
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  const guard = new AiOperationGuard()
  const workspaceId = workspaces.create({ rootPath: 'w-cancel', displayName: 'w', now: 1000 }).id
  const sessionId = sessions.createSession({ workspaceId, title: 's', now: 1000 })
  const binding = createAiCancelBinding(guard, workspaces, sessions)
  assert.equal(binding.channel, IPC_CHANNELS.aiCancelOperation)
  assert.equal(binding.channel, 'stark:ai:cancel-operation')
  return { db, guard, invoke: binding.invoke as (payload: unknown) => Promise<{ cancelled: boolean }>, workspaceId, sessionId }
}

describe('ai cancel-operation binding', () => {
  it('rejects malformed payloads without touching the guard', async () => {
    const harness = openBinding()
    try {
      harness.guard.acquire(harness.sessionId)
      for (const bad of [null, undefined, 7, 'x', [], {}, { workspaceId: 1 }, { sessionId: 1 }, { workspaceId: 0, sessionId: 1 }, { workspaceId: 1, sessionId: -2 }, { workspaceId: '1', sessionId: 1 }]) {
        await assert.rejects(harness.invoke(bad))
      }
      assert.equal(harness.guard.isCancelRequested(harness.sessionId), false)
    } finally {
      harness.db.close()
    }
  })

  it('rejects unknown sessions and cross-workspace references', async () => {
    const harness = openBinding()
    try {
      const otherWorkspace = new WorkspaceRepository(harness.db).create({ rootPath: 'w-other', displayName: 'o', now: 1000 }).id
      await assert.rejects(harness.invoke({ workspaceId: harness.workspaceId, sessionId: 9999 }))
      await assert.rejects(harness.invoke({ workspaceId: otherWorkspace, sessionId: harness.sessionId }))
      await assert.rejects(harness.invoke({ workspaceId: 9999, sessionId: harness.sessionId }))
    } finally {
      harness.db.close()
    }
  })

  it('idle session resolves cancelled:false (harmless no-op)', async () => {
    const harness = openBinding()
    try {
      const result = await harness.invoke({ workspaceId: harness.workspaceId, sessionId: harness.sessionId })
      assert.deepEqual(result, { cancelled: false })
    } finally {
      harness.db.close()
    }
  })

  it('active session resolves cancelled:true and records on the guard', async () => {
    const harness = openBinding()
    try {
      harness.guard.acquire(harness.sessionId)
      const result = await harness.invoke({ workspaceId: harness.workspaceId, sessionId: harness.sessionId })
      assert.deepEqual(result, { cancelled: true })
      assert.equal(harness.guard.isCancelRequested(harness.sessionId), true)
      // Duplicate cancels stay idempotent while active.
      const again = await harness.invoke({ workspaceId: harness.workspaceId, sessionId: harness.sessionId })
      assert.deepEqual(again, { cancelled: true })
    } finally {
      harness.db.close()
    }
  })

  it('cancel is scoped: one session never cancels another', async () => {
    const harness = openBinding()
    try {
      const sessions = new CodingSessionRepository(harness.db)
      const other = sessions.createSession({ workspaceId: harness.workspaceId, title: 'other', now: 1000 })
      harness.guard.acquire(harness.sessionId)
      harness.guard.acquire(other)
      const result = await harness.invoke({ workspaceId: harness.workspaceId, sessionId: harness.sessionId })
      assert.deepEqual(result, { cancelled: true })
      assert.equal(harness.guard.isCancelRequested(other), false)
    } finally {
      harness.db.close()
    }
  })

  it('parked approval cancel returns cancelled:true even though the guard is released', async () => {
    const harness = openBinding()
    try {
      let calls = 0
      const parked = {
        cancelParkedWork: (): { cancelled: boolean } => {
          calls += 1
          return { cancelled: true }
        }
      }
      const binding = createAiCancelBinding(harness.guard, new WorkspaceRepository(harness.db), new CodingSessionRepository(harness.db), parked)
      const invoke = binding.invoke as (payload: unknown) => Promise<{ cancelled: boolean }>
      assert.equal(harness.guard.isActive(harness.sessionId), false, 'parked runs release the guard')
      const result = await invoke({ workspaceId: harness.workspaceId, sessionId: harness.sessionId })
      assert.deepEqual(result, { cancelled: true })
      assert.equal(calls, 1, 'parked path consulted exactly once')
      // Repeated parked cancel stays harmless true (idempotent).
      const again = await invoke({ workspaceId: harness.workspaceId, sessionId: harness.sessionId })
      assert.deepEqual(again, { cancelled: true })
    } finally {
      harness.db.close()
    }
  })

  it('idle session with no parked run resolves cancelled:false without touching parked state', async () => {
    const harness = openBinding()
    try {
      let calls = 0
      const parked = {
        cancelParkedWork: (): { cancelled: boolean } => {
          calls += 1
          return { cancelled: false }
        }
      }
      const binding = createAiCancelBinding(harness.guard, new WorkspaceRepository(harness.db), new CodingSessionRepository(harness.db), parked)
      const invoke = binding.invoke as (payload: unknown) => Promise<{ cancelled: boolean }>
      const result = await invoke({ workspaceId: harness.workspaceId, sessionId: harness.sessionId })
      assert.deepEqual(result, { cancelled: false })
      assert.equal(calls, 1)
    } finally {
      harness.db.close()
    }
  })

  it('active guard takes precedence and parked cancel is not consulted', async () => {
    const harness = openBinding()
    try {
      let calls = 0
      const parked = {
        cancelParkedWork: (): { cancelled: boolean } => {
          calls += 1
          return { cancelled: false }
        }
      }
      const binding = createAiCancelBinding(harness.guard, new WorkspaceRepository(harness.db), new CodingSessionRepository(harness.db), parked)
      const invoke = binding.invoke as (payload: unknown) => Promise<{ cancelled: boolean }>
      harness.guard.acquire(harness.sessionId)
      const result = await invoke({ workspaceId: harness.workspaceId, sessionId: harness.sessionId })
      assert.deepEqual(result, { cancelled: true })
      assert.equal(calls, 0, 'active path short-circuits before the parked path')
    } finally {
      harness.db.close()
    }
  })
})
