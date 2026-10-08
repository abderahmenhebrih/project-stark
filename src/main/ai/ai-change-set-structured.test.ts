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
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { ChangeSetService } from '../change-sets/change-set-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiMultiFileProposalService, CHANGE_SET_SCHEMA_NAME, buildChangeSetJsonSchema } from './ai-multi-file-proposal-service'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import type {
  AiProviderAdapter,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredRequest,
  ProviderStructuredResult
} from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { STAGE_17_FIXED_MULTI_FILE_INSTRUCTIONS } from './limits'
import { OpenAiProviderAdapter, type OpenAiClientFactory } from './openai-adapter'

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

class CapturingAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  seen: (ProviderStructuredRequest & { apiKey: string })[] = []

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    this.seen.push(request)
    return {
      outputText: JSON.stringify({
        summary: 'grouped update',
        changes: [
          { targetId: 'T1', summary: 'bump a', proposedContent: 'const v0 = 2\n' },
          { targetId: 'T2', summary: 'bump b', proposedContent: 'const v1 = 2\n' }
        ]
      })
    }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  context: SessionContextService
  sessions: CodingSessionService
  proposals: AiMultiFileProposalService
  providerService: AiProviderService
  adapter: CapturingAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-changeset-struct-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'f0.ts'), 'const v0 = 1\n')
  writeFileSync(join(root, 'f1.ts'), 'const v1 = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const changeSets = new ChangeSetService(workspaces, setRows, changeRows)
  const adapter = new CapturingAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const proposals = new AiMultiFileProposalService(
    workspaces,
    codingRows,
    providerRows,
    providerService,
    registry,
    files,
    changeSets,
    { operationGuard: new AiOperationGuard() }
  )
  return { db, dir, workspaceId, context, sessions, proposals, providerService, adapter }
}

describe('change-set structured output', () => {
  it('schema requires summary and changes with targetId/summary/proposedContent only', () => {
    const schema = buildChangeSetJsonSchema(3) as unknown as Record<string, unknown>
    assert.equal(schema['type'], 'object')
    assert.equal(schema['additionalProperties'], false)
    assert.deepEqual(schema['required'], ['summary', 'changes'])
    const properties = schema['properties'] as Record<string, unknown>
    const arrayDef = properties['changes'] as Record<string, unknown>
    assert.equal(arrayDef['type'], 'array')
    assert.equal(arrayDef['minItems'], 1)
    assert.equal(arrayDef['maxItems'], 3)
    const itemDef = arrayDef['items'] as Record<string, unknown>
    assert.deepEqual(itemDef['required'], ['targetId', 'summary', 'proposedContent'])
    assert.equal(itemDef['additionalProperties'], false)
    const serialized = JSON.stringify(schema)
    for (const forbidden of ['"path"', '"revision"', '"command"', '"tool"', '"apply"', '"accept"', '"transactionId"']) {
      assert.ok(!serialized.includes(forbidden), `schema must not contain ${forbidden}`)
    }
  })

  it('service sends target blocks, fixed instructions, schema, and makes one call', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const first = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'f0.ts' })
      const second = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'f1.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Update both.',
        context: [first, second]
      })
      await harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(harness.adapter.seen.length, 1)
      const request = harness.adapter.seen[0]
      assert.ok(request !== undefined)
      assert.equal(request.model, 'gpt-4o')
      assert.equal(request.instructions, STAGE_17_FIXED_MULTI_FILE_INSTRUCTIONS)
      assert.equal(request.schemaName, CHANGE_SET_SCHEMA_NAME)
      const body = request.messages.map((entry) => entry.content).join('\n')
      assert.ok(body.includes('[TARGET T1]'), 'input must carry opaque target IDs')
      assert.ok(body.includes('[TARGET T2]'), 'input must carry opaque target IDs')
      assert.ok(body.includes('f0.ts'), 'target path is informational only')
      assert.ok(!JSON.stringify(request.messages).includes('sk-test'))
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('OpenAI adapter uses json_schema strict, store:false, no tools, no previous_response_id', async () => {
    let seen: unknown = null
    const factory: OpenAiClientFactory = () => ({
      models: {
        list: () => Promise.resolve({ data: [] as readonly { id: string }[] })
      },
      responses: {
        create: (params?: unknown) => {
          seen = params
          return Promise.resolve({
            output_text: JSON.stringify({ summary: 's', changes: [{ targetId: 'T1', summary: 'x', proposedContent: 'y\n' }] })
          })
        }
      }
    })
    const adapter = new OpenAiProviderAdapter(factory)
    await adapter.generateStructured({
      apiKey: 'sk-test',
      model: 'gpt-4o',
      instructions: STAGE_17_FIXED_MULTI_FILE_INSTRUCTIONS,
      messages: [{ role: 'user', content: '[TARGET T1]\nPath: f0.ts\nContent:\na\n' }],
      maxOutputTokens: 4096,
      schemaName: CHANGE_SET_SCHEMA_NAME,
      schema: buildChangeSetJsonSchema(2)
    })
    const params = seen as Record<string, unknown>
    assert.equal(params['model'], 'gpt-4o')
    assert.equal(params['store'], false)
    const text = params['text'] as Record<string, unknown>
    const format = text['format'] as Record<string, unknown>
    assert.equal(format['type'], 'json_schema')
    assert.equal(format['strict'], true)
    assert.equal(format['name'], CHANGE_SET_SCHEMA_NAME)
    for (const forbidden of ['tools', 'tool_choice', 'conversation', 'previous_response_id', 'previousResponseId']) {
      assert.ok(!(forbidden in params), `request must not contain ${forbidden}`)
    }
  })
})
