import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiCodeProposalService, PROPOSAL_JSON_SCHEMA, PROPOSAL_SCHEMA_NAME } from './ai-code-proposal-service'
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
import { STAGE_16_FIXED_PROPOSAL_INSTRUCTIONS } from './limits'
import {
  OpenAiProviderAdapter,
  type OpenAiClientFactory
} from './openai-adapter'

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

  async generateStructured(
    request: ProviderStructuredRequest & { apiKey: string }
  ): Promise<ProviderStructuredResult> {
    this.seen.push(request)
    return { outputText: JSON.stringify({ summary: 's', proposedContent: 'const alpha = 2\nconst beta = 2\nconst gamma = 3\n' }) }
  }
}

function openServiceHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  context: SessionContextService
  sessions: CodingSessionService
  proposals: AiCodeProposalService
  adapter: CapturingAdapter
  providerService: AiProviderService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const writer = new WorkspaceFileWriteService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-propose-struct-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const alpha = 1\nconst beta = 2\nconst gamma = 3\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const transactions = new ChangeTransactionService(workspaces, changeRows, writer)
  const adapter = new CapturingAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const proposals = new AiCodeProposalService(
    workspaces,
    codingRows,
    providerRows,
    providerService,
    registry,
    files,
    transactions,
    { operationGuard: new AiOperationGuard() }
  )
  return { db, dir, workspaceId, context, sessions, proposals, adapter, providerService }
}

describe('structured provider request', () => {
  it('service sends model, fixed instructions, bounded context, schema, store:false semantics', async () => {
    const harness = openServiceHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Bump alpha.',
        context: [whole]
      })
      await harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(harness.adapter.seen.length, 1)
      const request = harness.adapter.seen[0]
      assert.ok(request !== undefined)
      assert.equal(request.model, 'gpt-4o')
      assert.equal(request.instructions, STAGE_16_FIXED_PROPOSAL_INSTRUCTIONS)
      assert.ok(request.messages.length >= 1)
      assert.equal(request.schemaName, PROPOSAL_SCHEMA_NAME)
      assert.deepEqual(request.schema, PROPOSAL_JSON_SCHEMA)
      // No API key leakage into the stored shape beyond transport.
      assert.ok(!JSON.stringify(request.messages).includes('sk-test'))
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('schema contains summary/proposedContent and no path/command/tool/revision', () => {
    const schema = PROPOSAL_JSON_SCHEMA as unknown as Record<string, unknown>
    assert.equal(schema['type'], 'object')
    assert.equal(schema['additionalProperties'], false)
    assert.deepEqual(schema['required'], ['summary', 'proposedContent'])
    const properties = schema['properties'] as Record<string, unknown>
    assert.deepEqual(Object.keys(properties).sort(), ['proposedContent', 'summary'])
    const serialized = JSON.stringify(schema)
    for (const forbidden of ['relativePath', 'command', 'tool', 'apply', 'revision', 'path']) {
      assert.ok(!serialized.includes(`"${forbidden}"`), `schema must not contain ${forbidden}`)
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
          return Promise.resolve({ output_text: JSON.stringify({ summary: 's', proposedContent: 'x\n' }) })
        }
      }
    })
    const adapter = new OpenAiProviderAdapter(factory)
    const result = await adapter.generateStructured({
      apiKey: 'sk-test',
      model: 'gpt-4o',
      instructions: STAGE_16_FIXED_PROPOSAL_INSTRUCTIONS,
      messages: [{ role: 'user', content: 'change it' }],
      maxOutputTokens: 4096,
      schemaName: PROPOSAL_SCHEMA_NAME,
      schema: PROPOSAL_JSON_SCHEMA
    })
    assert.ok(typeof result.outputText === 'string')
    const params = seen as Record<string, unknown>
    assert.equal(params['model'], 'gpt-4o')
    assert.equal(params['store'], false)
    const text = params['text'] as Record<string, unknown>
    const format = text['format'] as Record<string, unknown>
    assert.equal(format['type'], 'json_schema')
    assert.equal(format['strict'], true)
    assert.equal(format['name'], PROPOSAL_SCHEMA_NAME)
    assert.deepEqual(format['schema'], PROPOSAL_JSON_SCHEMA)
    for (const forbidden of ['tools', 'tool_choice', 'conversation', 'previous_response_id', 'previousResponseId']) {
      assert.ok(!(forbidden in params), `request must not contain ${forbidden}`)
    }
  })
})
