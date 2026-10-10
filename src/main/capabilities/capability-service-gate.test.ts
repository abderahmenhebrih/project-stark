import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { CodingSessionService } from '../sessions/coding-session-service'
import { CapabilityRepository } from './capability-repository'
import { CapabilityService } from './capability-service'
import { CapabilityGate } from './capability-gate'
import { AGENT_CAPABILITIES } from './capability-registry'

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  otherWorkspaceId: number
  sessionId: number
  otherSessionId: number
  store: CapabilityRepository
  service: CapabilityService
  gate: CapabilityGate
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const store = new CapabilityRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-cap-'))
  const rootA = join(dir, 'a')
  const rootB = join(dir, 'b')
  mkdirSync(rootA, { recursive: true })
  mkdirSync(rootB, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: rootA, displayName: 'a', now: 1 }).id
  const otherWorkspaceId = workspaces.create({ rootPath: rootB, displayName: 'b', now: 2 }).id
  const service = new CapabilityService(store, workspaces)
  const gate = new CapabilityGate(workspaces, codingRows, store)
  return { db, dir, workspaceId, otherWorkspaceId, sessionId: 0, otherSessionId: 0, store, service, gate }
}

async function seedSessions(h: ReturnType<typeof openHarness>): Promise<{ sessionId: number; otherSessionId: number }> {
  const dbSessions = new CodingSessionRepository(h.db)
  const workspaces = new WorkspaceRepository(h.db)
  const sessions = new CodingSessionService(workspaces, dbSessions)
  const a = await sessions.createSession({ workspaceId: h.workspaceId })
  await sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: a.id, content: 'Hi A.' })
  const b = await sessions.createSession({ workspaceId: h.otherWorkspaceId })
  await sessions.sendUserMessage({ workspaceId: h.otherWorkspaceId, sessionId: b.id, content: 'Hi B.' })
  return { sessionId: a.id, otherSessionId: b.id }
}

function fullPolicies(modes: Record<string, string>): { capability: string; mode: string }[] {
  return AGENT_CAPABILITIES.map((capability) => ({ capability, mode: modes[capability] ?? 'deny' }))
}

describe('capability repository', () => {
  it('absent config reads as disabled/default-deny via service', async () => {
    const h = openHarness()
    try {
      const ids = await seedSessions(h)
      const config = h.service.getConfig({ workspaceId: h.workspaceId })
      assert.equal(config.enabled, false)
      assert.ok(config.policies.every((p) => p.mode === 'deny'))
      assert.equal(h.gate.authorize({ workspaceId: h.workspaceId, sessionId: ids.sessionId, actor: 'worker', capability: 'workspace.read' }).decision, 'deny')
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('saves and loads complete config with timestamps', async () => {
    const h = openHarness()
    try {
      await seedSessions(h)
      const saved = h.service.updateConfig({
        workspaceId: h.workspaceId,
        enabled: true,
        policies: fullPolicies({ 'workspace.read': 'allow', 'workspace.search': 'ask', 'git.read': 'allow', 'change.propose': 'ask', 'terminal.execute': 'deny' })
      })
      assert.equal(saved.enabled, true)
      const loaded = h.service.getConfig({ workspaceId: h.workspaceId })
      assert.deepEqual(loaded, saved)
      assert.ok(h.store.listPolicies(h.workspaceId).length === 9)
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('atomic replacement preserves modes while disabled and rolls back on fault', async () => {
    const h = openHarness()
    try {
      await seedSessions(h)
      h.service.updateConfig({
        workspaceId: h.workspaceId,
        enabled: true,
        policies: fullPolicies({ 'workspace.read': 'allow', 'workspace.search': 'allow', 'git.read': 'allow', 'change.propose': 'allow', 'terminal.execute': 'ask' })
      })
      // Disable while preserving modes.
      const disabled = h.service.updateConfig({
        workspaceId: h.workspaceId,
        enabled: false,
        policies: fullPolicies({ 'workspace.read': 'allow', 'workspace.search': 'allow', 'git.read': 'allow', 'change.propose': 'allow', 'terminal.execute': 'ask' })
      })
      assert.equal(disabled.enabled, false)
      assert.equal(disabled.policies.find((p) => p.capability === 'workspace.read')?.mode, 'allow')
      // Fault leaves old configuration intact.
      assert.throws(() =>
        h.store.saveConfig(
          { workspaceId: h.workspaceId, enabled: true, policies: fullPolicies({}), now: 9999 },
          { failAfterPolicies: 0 }
        )
      )
      const after = h.service.getConfig({ workspaceId: h.workspaceId })
      assert.deepEqual(after, disabled)
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('workspace cascade and separation hold', async () => {
    const h = openHarness()
    try {
      await seedSessions(h)
      h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: fullPolicies({ 'workspace.read': 'allow' }) })
      assert.equal(h.service.getConfig({ workspaceId: h.otherWorkspaceId }).enabled, false)
      h.db.exec(`DELETE FROM workspaces WHERE id = ${h.workspaceId}`)
      assert.equal(h.store.listPolicies(h.workspaceId).length, 0)
      assert.equal(h.store.findSettings(h.workspaceId), undefined)
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('tables hold no secrets', () => {
    const h = openHarness()
    try {
      const cols: unknown = h.db.prepare("SELECT name FROM pragma_table_info('workspace_capability_policies')").all()
      const names = JSON.stringify(cols)
      assert.ok(!names.includes('credential'))
      assert.ok(!names.includes('api_key'))
      assert.ok(!names.includes('command'))
      assert.ok(!names.includes('path'))
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('capability service validation', () => {
  it('rejects unknown/duplicate/missing/mode/terminal-allow/extra/bad-workspace', async () => {
    const h = openHarness()
    try {
      await seedSessions(h)
      const good = fullPolicies({ 'workspace.read': 'allow', 'workspace.search': 'ask', 'git.read': 'allow', 'change.propose': 'ask', 'terminal.execute': 'deny' })
      // Unknown capability.
      assert.throws(() =>
        h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: [...good.slice(0, 4), { capability: 'file.write', mode: 'allow' }] as never })
      )
      // Duplicate.
      assert.throws(() =>
        h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: [...good, good[0]] as never })
      )
      // Missing (only 4).
      assert.throws(() =>
        h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: good.slice(0, 4) })
      )
      // Unknown mode.
      assert.throws(() =>
        h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: good.map((p) => (p.capability === 'git.read' ? { ...p, mode: 'sometimes' } : p)) as never })
      )
      // Terminal allow forbidden.
      assert.throws(() =>
        h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: good.map((p) => (p.capability === 'terminal.execute' ? { ...p, mode: 'allow' } : p)) as never })
      )
      // Attachment-import allow forbidden (binary-write policy: exact approval only).
      assert.throws(() =>
        h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: good.map((p) => (p.capability === 'attachment.import' ? { ...p, mode: 'allow' } : p)) as never })
      )
      // Image-generate allow forbidden (cost-bearing policy: exact approval only).
      assert.throws(() =>
        h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: good.map((p) => (p.capability === 'image.generate' ? { ...p, mode: 'allow' } : p)) as never })
      )
      // Extra fields.
      assert.throws(() =>
        h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: good.map((p) => ({ ...p, extra: 1 })) as never })
      )
      // Bad workspace id + unknown workspace.
      assert.throws(() => h.service.updateConfig({ workspaceId: -1, enabled: true, policies: good }))
      assert.throws(() => h.service.updateConfig({ workspaceId: 999999, enabled: true, policies: good }))
      assert.throws(() => h.service.updateConfig({ workspaceId: h.workspaceId, enabled: 'yes' as never, policies: good }))
      assert.throws(() => h.service.getConfig({ workspaceId: 999999 }))
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('capability gate decisions', () => {
  it('worker allow/ask/deny matrix for every capability', async () => {
    const h = openHarness()
    try {
      const ids = await seedSessions(h)
      for (const capability of AGENT_CAPABILITIES) {
        for (const mode of capability === 'terminal.execute' || capability === 'attachment.import' || capability === 'image.generate' ? ['deny', 'ask'] : ['deny', 'ask', 'allow']) {
          const modes: Record<string, string> = {}
          for (const c of AGENT_CAPABILITIES) modes[c] = 'deny'
          modes[capability] = mode
          h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: fullPolicies(modes) })
          const decision = h.gate.authorize({ workspaceId: h.workspaceId, sessionId: ids.sessionId, actor: 'worker', capability })
          if (mode === 'allow') assert.equal(decision.decision, 'allow')
          if (mode === 'ask') assert.equal(decision.decision, 'requires_approval')
          if (mode === 'deny') {
            assert.equal(decision.decision, 'deny')
            assert.equal((decision as { reason: string }).reason, 'policy-deny')
          }
        }
      }
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('brain always denies even when worker would allow', async () => {
    const h = openHarness()
    try {
      const ids = await seedSessions(h)
      h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: fullPolicies({ 'workspace.read': 'allow', 'workspace.search': 'allow', 'git.read': 'allow', 'change.propose': 'allow', 'terminal.execute': 'ask' }) })
      for (const capability of AGENT_CAPABILITIES) {
        const decision = h.gate.authorize({ workspaceId: h.workspaceId, sessionId: ids.sessionId, actor: 'brain', capability })
        assert.equal(decision.decision, 'deny')
        assert.equal((decision as { reason: string }).reason, 'brain-has-no-tool-authority')
      }
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('master disabled denies everything with workspace-disabled', async () => {
    const h = openHarness()
    try {
      const ids = await seedSessions(h)
      h.service.updateConfig({ workspaceId: h.workspaceId, enabled: false, policies: fullPolicies({ 'workspace.read': 'allow', 'workspace.search': 'allow', 'git.read': 'allow', 'change.propose': 'allow', 'terminal.execute': 'ask' }) })
      for (const capability of AGENT_CAPABILITIES) {
        const decision = h.gate.authorize({ workspaceId: h.workspaceId, sessionId: ids.sessionId, actor: 'worker', capability })
        assert.equal(decision.decision, 'deny')
        assert.equal((decision as { reason: string }).reason, 'workspace-disabled')
      }
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('cross-workspace session never inherits policy', async () => {
    const h = openHarness()
    try {
      const ids = await seedSessions(h)
      h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: fullPolicies({ 'workspace.read': 'allow' }) })
      const decision = h.gate.authorize({ workspaceId: h.workspaceId, sessionId: ids.otherSessionId, actor: 'worker', capability: 'workspace.read' })
      assert.equal(decision.decision, 'deny')
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('unknown capability denies with no side effects', async () => {
    const h = openHarness()
    try {
      const ids = await seedSessions(h)
      h.service.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: fullPolicies({ 'workspace.read': 'allow' }) })
      const decision = h.gate.authorize({ workspaceId: h.workspaceId, sessionId: ids.sessionId, actor: 'worker', capability: 'file.write' })
      assert.equal(decision.decision, 'deny')
      assert.equal((decision as { reason: string }).reason, 'unknown-capability')
      // Decisions are immutable plain objects (no live references).
      assert.deepEqual(JSON.parse(JSON.stringify(decision)), decision)
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})
