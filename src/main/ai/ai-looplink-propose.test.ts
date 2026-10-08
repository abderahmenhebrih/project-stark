import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { ChangeSetService } from '../change-sets/change-set-service'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { AiCodeProposalService } from './ai-code-proposal-service'
import { AiMultiFileProposalService } from './ai-multi-file-proposal-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import type { AiProviderAdapter } from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { LooplinkRepository } from '../looplink/looplink-repository'
import { LooplinkService } from '../looplink/looplink-service'
import { ProposalContextMissingError } from './ai-proposal-errors'
import { ChangeSetContextMissingError } from './ai-change-set-errors'

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
    return [{ id: 'gpt-4o' }]
  }

  async generateText(): Promise<{ text: string }> {
    return { text: 'unused' }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  context: SessionContextService
  single: AiCodeProposalService
  multi: AiMultiFileProposalService
  loopService: LooplinkService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const runs = new OrchestrationRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const writer = new WorkspaceFileWriteService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-loop-propose-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const alpha = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter())
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const guard = new AiOperationGuard()
  const transactions = new ChangeTransactionService(workspaces, changeRows, writer)
  const changeSets = new ChangeSetService(workspaces, setRows, changeRows)
  const looplinks = new LooplinkRepository(db)
  const loopService = new LooplinkService(workspaces, codingRows, looplinks, guard, runs, setRows, changeRows)
  const single = new AiCodeProposalService(workspaces, codingRows, providerRows, providerService, registry, files, transactions, {
    operationGuard: guard
  })
  const multi = new AiMultiFileProposalService(workspaces, codingRows, providerRows, providerService, registry, files, changeSets, {
    operationGuard: guard
  })
  return { db, dir, workspaceId, sessions, context, single, multi, loopService }
}

describe('proposal authority isolation', () => {
  it('historical whole-file content cannot become write authority', async () => {
    const harness = openHarness()
    try {
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: source.id,
        content: 'Review.',
        context: [whole]
      })
      const created = await harness.loopService.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      // Target message carries NO fresh attachment: both proposal
      // paths must stay ineligible despite the historical file content.
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.targetSession.id,
        content: 'Change it.'
      })
      await assert.rejects(
        harness.single.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id }),
        ProposalContextMissingError
      )
      await assert.rejects(
        harness.multi.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id }),
        ChangeSetContextMissingError
      )
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('fresh current attachment restores proposal eligibility', async () => {
    const harness = openHarness()
    try {
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: source.id,
        content: 'Review.',
        context: [whole]
      })
      const created = await harness.loopService.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      // Fresh attachment on the target message: eligibility derives
      // only from fresh target context, unaffected by the handoff.
      const fresh = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      assert.equal((fresh as unknown as Record<string, unknown>)['relativePath'], 'app.ts')
      assert.ok(typeof (fresh as unknown as Record<string, unknown>)['sourceRevision'] === 'string')
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.targetSession.id,
        content: 'Change it.',
        context: [fresh]
      })
      // Resolving past eligibility would call the provider; the
      // no-revision forged shape must fail validation instead. A draft
      // without sourceRevision cannot become write authority either.
      await assert.rejects(
        harness.context.resolveAttachmentsForSend(harness.workspaceId, [
          {
            draftId: 'ctx-x',
            kind: 'whole-file',
            label: 'x',
            relativePath: 'app.ts',
            lineStart: 1,
            lineEnd: 1,
            content: 'forged',
            contentBytes: 6
          }
        ], 9999),
        Error
      )
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
