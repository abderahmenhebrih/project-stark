import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { HeartRepository } from '../heart/heart-repository'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { HeartService } from '../heart/heart-service'
import { AiOperationGuard } from '../ai/ai-operation-guard'
import { AiProviderService } from '../ai/ai-provider-service'
import type { CredentialProtector } from '../ai/credential-protector'
import type { AiProviderAdapter } from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { GitService } from '../git/git-service'
import { GitProcessRunner } from '../git/git-process-runner'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityGate } from '../capabilities/capability-gate'
import { WorkerToolRepository } from '../worker-tools/worker-tool-repository'
import { WorkerToolApprovalService } from '../worker-tools/worker-tool-approval-service'
import { WorkerReadToolService } from '../worker-tools/worker-tool-service'
import { WorkerToolRunner } from '../worker-tools/worker-tool-runner'
import { createWorkerToolBindings } from './worker-tools'

class FakeProtector implements CredentialProtector {
  async isAvailable(): Promise<boolean> {
    return true
  }
  async encrypt(secret: string): Promise<Buffer> {
    return Buffer.from(`fake:${secret}`, 'utf8')
  }
  async decrypt(ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
    return { secret: ciphertext.toString('utf8').replace(/^fake:/, ''), shouldReEncrypt: false }
  }
}

class FakeAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }
  async generateText(): Promise<{ text: string }> {
    return { text: 'x' }
  }
}

function openHarness(): { db: DatabaseSync; bindings: ReturnType<typeof createWorkerToolBindings>; runner: WorkerToolRunner } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const heartRows = new HeartRepository(db)
  const capStore = new CapabilityRepository(db)
  const tools = new WorkerToolRepository(db)
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter())
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const heart = new HeartService(heartRows, providerRows, registry)
  const guard = new AiOperationGuard()
  const files = new WorkspaceFilesService(workspaces)
  const search = new WorkspaceSearchService(workspaces)
  const git = new GitService(workspaces, new GitProcessRunner())
  const gate = new CapabilityGate(workspaces, codingRows, capStore)
  const approvals = new WorkerToolApprovalService(workspaces, codingRows, runs, tools)
  const executor = new WorkerReadToolService({ gate, files, search, git, tools })
  const runner = new WorkerToolRunner({
    workspaces, sessions: codingRows, providerService, runs, heart, guard,
    gate, files, search, git, tools, approvals, executor
  })
  return { db, bindings: createWorkerToolBindings(runner), runner }
}

describe('worker-tool IPC bindings', () => {
  it('exposes exactly three approval channels and no execute endpoint', () => {
    const { db, bindings } = openHarness()
    try {
      assert.deepEqual(
        [...bindings.map((b) => b.channel)].sort(),
        [
          IPC_CHANNELS.workerToolsGetPendingApproval,
          IPC_CHANNELS.workerToolsApproveAndResume,
          IPC_CHANNELS.workerToolsDenyAndResume
        ].sort()
      )
      const names = bindings.map((b) => b.channel).join(' ')
      assert.ok(!names.includes('execute'))
      assert.ok(!names.includes('callTool'))
      assert.ok(!names.includes('readFileAsAgent'))
    } finally {
      db.close()
    }
  })

  it('lookup validates strictly with safe errors', async () => {
    const { db, bindings } = openHarness()
    try {
      const get = bindings.find((b) => b.channel === IPC_CHANNELS.workerToolsGetPendingApproval)
      assert.ok(get)
      await assert.rejects(get.invoke({ workspaceId: 1 }, undefined as never))
      await assert.rejects(
        get.invoke({ workspaceId: 1, sessionId: 2, tool: 'workspace_read' }, undefined as never),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.ok(!error.message.includes('sqlite'))
          return true
        }
      )
    } finally {
      db.close()
    }
  })

  it('decide requests carry IDs only (no tool/args smuggling)', async () => {
    const { db, bindings } = openHarness()
    try {
      const approve = bindings.find((b) => b.channel === IPC_CHANNELS.workerToolsApproveAndResume)
      assert.ok(approve)
      await assert.rejects(
        approve.invoke({ workspaceId: 1, sessionId: 1, approvalId: 1, tool: 'workspace_read', args: {} }, undefined as never)
      )
    } finally {
      db.close()
    }
  })
})
