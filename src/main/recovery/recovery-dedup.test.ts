import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { CodingSessionService } from '../sessions/coding-session-service'
import { LooplinkRepository } from '../looplink/looplink-repository'
import { LooplinkService } from '../looplink/looplink-service'
import { AiOperationGuard } from '../ai/ai-operation-guard'
import { verifyLooplinkPayload } from '../looplink/looplink-payload'

function openHarness(): { db: DatabaseSync; dir: string; workspaceId: number; sessions: CodingSessionService; loop: LooplinkService; loops: LooplinkRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const runs = new OrchestrationRepository(db)
  const loops = new LooplinkRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-rec-dedup-'))
  const root = join(dir, 'p')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'p', now: 1 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const guard = new AiOperationGuard()
  const loop = new LooplinkService(workspaces, codingRows, loops, guard, runs)
  return { db, dir, workspaceId, sessions, loop, loops }
}

describe('recovery active-request dedup', () => {
  it('excludes the matching latest source user message from the block only at injection time', async () => {
    const h = openHarness()
    try {
      const source = await h.sessions.createSession({ workspaceId: h.workspaceId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: source.id, content: 'Older context.' })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: source.id, content: 'FIX_THIS' })
      const created = await h.loop.createContinuation({ workspaceId: h.workspaceId, sourceSessionId: source.id })
      const targetId = created.targetSession.id
      // Stored payload is NOT mutated: it still contains FIX_THIS.
      const stored = h.loops.findById(created.looplink.id)
      assert.ok(stored)
      const parsed = verifyLooplinkPayload(stored.payload, stored.payloadHash)
      assert.ok(parsed.messages.some((m) => m.content === 'FIX_THIS'))
      // Injection without exclusion contains the duplicate.
      const withDup = h.loop.getPendingBlock(h.workspaceId, targetId)
      assert.ok(withDup?.block.includes('FIX_THIS'))
      // Injection with exclusion drops exactly the latest matching user entry.
      const deduped = h.loop.getPendingBlockExcluding(h.workspaceId, targetId, 'FIX_THIS')
      assert.ok(deduped)
      assert.ok(!deduped?.block.includes('FIX_THIS'))
      // Older history remains.
      assert.ok(deduped?.block.includes('Older context.'))
      // Stored payload still intact after both reads.
      const reread = h.loops.findById(created.looplink.id)
      assert.ok(reread)
      const reparsed = verifyLooplinkPayload(reread.payload, reread.payloadHash)
      assert.ok(reparsed.messages.some((m) => m.content === 'FIX_THIS'))
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('provider sees the active request exactly once (block excluded + trailing active)', async () => {
    const h = openHarness()
    try {
      const source = await h.sessions.createSession({ workspaceId: h.workspaceId })
      // Two messages so the derived title comes from the older entry,
      // never colliding with the active FIX_THIS text.
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: source.id, content: 'Older context.' })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: source.id, content: 'FIX_THIS' })
      const created = await h.loop.createContinuation({ workspaceId: h.workspaceId, sourceSessionId: source.id })
      const block = h.loop.getPendingBlockExcluding(h.workspaceId, created.targetSession.id, 'FIX_THIS')
      assert.ok(block)
      // Simulate provider message assembly: [block, active].
      const providerMessages = [{ content: block?.block ?? '' }, { content: 'FIX_THIS' }]
      const joined = providerMessages.map((m) => m.content).join('\n')
      const occurrences = joined.split('FIX_THIS').length - 1
      assert.equal(occurrences, 1)
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})
