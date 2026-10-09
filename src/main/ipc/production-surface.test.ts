import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { createServices } from '../application/create-services'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { HeartRepository } from '../heart/heart-repository'
import { LooplinkRepository } from '../looplink/looplink-repository'
import { RecoveryRepository } from '../recovery/recovery-repository'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { WorkerCommandRepository } from '../worker-tools/worker-command-repository'
import { ProjectRuntimeRepository } from '../project-runtime/project-runtime-repository'
import { WorkerToolRepository } from '../worker-tools/worker-tool-repository'
import { AiUsageRepository } from '../usage/ai-usage-repository'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { TerminalManager } from '../terminal/terminal-manager'
import type { CredentialProtector } from '../ai/credential-protector'
import type { AiProviderAdapter, ProviderGenerateRequest, ProviderGenerateResult } from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { createIpcBindings } from './index'

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

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }
}

/**
 * Authoritative production IPC/preload surface test (Stage 18
 * pre-flight cleanup): mirrors the production wiring shape in
 * src/main/index.ts exactly — every repository, every service,
 * every binding. No focused harness may claim completeness; this one
 * test owns the complete-surface assertion. Focused harnesses that
 * omit optional newer services remain valid for their own domains.
 */
function openProductionShapedServices(): { db: DatabaseSync; services: ReturnType<typeof createServices> } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter())
  return {
    db,
    services: createServices(
      {
        keyValue: new KeyValueRepository(db),
        workspaces: new WorkspaceRepository(db),
        changeTransactions: new ChangeTransactionRepository(db),
        changeSets: new ChangeSetRepository(db),
        orchestrationRuns: new OrchestrationRepository(db),
        heartStore: new HeartRepository(db),
        looplinkStore: new LooplinkRepository(db),
        recoveryStore: new RecoveryRepository(db),
        capabilityStore: new CapabilityRepository(db),
        workerToolStore: new WorkerToolRepository(db),
        workerCommandStore: new WorkerCommandRepository(db),
        runtimeStore: new ProjectRuntimeRepository(db),
        usageStore: new AiUsageRepository(db),
        codingSessions: new CodingSessionRepository(db),
        aiProviders: new AiProviderRepository(db)
      },
      { credentialProtector: new FakeProtector(), registry }
    )
  }
}

const EXPECTED_PRODUCTION_CHANNELS: readonly string[] = [
  IPC_CHANNELS.settingsGet,
  IPC_CHANNELS.settingsUpdate,
  IPC_CHANNELS.settingsReset,
  IPC_CHANNELS.profileGet,
  IPC_CHANNELS.profileSetDisplayName,
  IPC_CHANNELS.workspaceGetCurrent,
  IPC_CHANNELS.workspaceListRecent,
  IPC_CHANNELS.workspaceChooseDirectory,
  IPC_CHANNELS.workspaceOpen,
  IPC_CHANNELS.workspaceFilesListDirectory,
  IPC_CHANNELS.workspaceFilesReadTextFile,
  IPC_CHANNELS.workspaceFilesWriteTextFile,
  IPC_CHANNELS.workspaceSearch,
  IPC_CHANNELS.changesCreate,
  IPC_CHANNELS.changesGet,
  IPC_CHANNELS.changesListRecent,
  IPC_CHANNELS.changesAccept,
  IPC_CHANNELS.changesReject,
  IPC_CHANNELS.changesRollback,
  IPC_CHANNELS.terminalCreate,
  IPC_CHANNELS.terminalWrite,
  IPC_CHANNELS.terminalResize,
  IPC_CHANNELS.terminalKill,
  IPC_CHANNELS.gitGetStatus,
  IPC_CHANNELS.gitGetDiff,
  IPC_CHANNELS.sessionsCreate,
  IPC_CHANNELS.sessionsList,
  IPC_CHANNELS.sessionsListMessages,
  IPC_CHANNELS.sessionsSendUserMessage,
  IPC_CHANNELS.sessionContextPrepareExcerpt,
  IPC_CHANNELS.sessionContextPrepareFile,
  IPC_CHANNELS.sessionContextPrepareSearchMatch,
  IPC_CHANNELS.sessionContextPrepareNote,
  IPC_CHANNELS.providersGetState,
  IPC_CHANNELS.providersSaveCredential,
  IPC_CHANNELS.providersClearCredential,
  IPC_CHANNELS.providersTestConnection,
  IPC_CHANNELS.providersListModels,
  IPC_CHANNELS.providersSetModel,
  IPC_CHANNELS.aiGenerateResponse,
  IPC_CHANNELS.aiProposeFileChange,
  IPC_CHANNELS.aiProposeChangeSet,
  IPC_CHANNELS.aiRunBrain,
  IPC_CHANNELS.changeSetsGet,
  IPC_CHANNELS.changeSetsListRecent,
  IPC_CHANNELS.orchestrationGet,
  IPC_CHANNELS.orchestrationListRecent,
  IPC_CHANNELS.heartGet,
  IPC_CHANNELS.heartUpdate,
  IPC_CHANNELS.looplinkCreateContinuation,
  IPC_CHANNELS.looplinkGetForSession,
  IPC_CHANNELS.looplinkDismiss,
  IPC_CHANNELS.recoveryGetConfig,
  IPC_CHANNELS.recoveryUpdateConfig,
  IPC_CHANNELS.recoveryGetForSource,
  IPC_CHANNELS.recoveryGetForTarget,
  IPC_CHANNELS.recoveryDismiss,
  IPC_CHANNELS.capabilitiesGetWorkspaceConfig,
  IPC_CHANNELS.capabilitiesUpdateWorkspaceConfig,
  IPC_CHANNELS.workerToolsGetPendingApproval,
  IPC_CHANNELS.workerToolsApproveAndResume,
  IPC_CHANNELS.workerToolsDenyAndResume,
  IPC_CHANNELS.runtimesGetActive,
  IPC_CHANNELS.runtimesListRecent,
  IPC_CHANNELS.runtimesStop,
  IPC_CHANNELS.runtimesOpenPreview,
  IPC_CHANNELS.runtimesReloadPreview,
  IPC_CHANNELS.usageGetConfig,
  IPC_CHANNELS.usageUpdateConfig,
  IPC_CHANNELS.usageGetSummary
]

describe('authoritative production IPC surface', () => {
  it('exposes exactly the production channel set — no more, no fewer', () => {
    const { db, services } = openProductionShapedServices()
    try {
      const terminalManager = new TerminalManager(
        {
          spawn: () => {
            throw new Error('pty spawn must not run in surface tests')
          }
        },
        { sendData: () => {}, sendExit: () => {} }
      )
      const channels = createIpcBindings({
        settingsService: services.settingsService,
        profileService: services.profileService,
        workspaceService: services.workspaceService,
        workspaceFilesService: services.workspaceFilesService,
        workspaceFileWriteService: services.workspaceFileWriteService,
        workspaceSearchService: services.workspaceSearchService,
        changeTransactionService: services.changeTransactionService,
        terminalService: services.terminalService,
        terminalManager,
        gitService: services.gitService,
        codingSessionService: services.codingSessionService,
        sessionContextService: services.sessionContextService,
        aiProviderService: services.aiProviderService,
        aiCompletionService: services.aiCompletionService,
        aiCodeProposalService: services.aiCodeProposalService,
        aiMultiFileProposalService: services.aiMultiFileProposalService,
        changeSetService: services.changeSetService,
        aiBrainService: services.aiBrainService,
        heartService: services.heartService,
        looplinkService: services.looplinkService,
        recoveryService: services.recoveryService,
        recoveryStore: services.recoveryStore,
        capabilityService: services.capabilityService,
        workerToolRunner: services.workerToolRunner,
        projectRuntimeService: services.projectRuntimeService,
        usageService: services.usageService,
        workspaces: new WorkspaceRepository(db),
        codingSessions: new CodingSessionRepository(db)
      }).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), [...EXPECTED_PRODUCTION_CHANNELS].sort())
    } finally {
      db.close()
    }
  })

  it('accounts for every shipped IPC channel exactly once', () => {
    const all = new Set<string>(Object.values(IPC_CHANNELS))
    // Channels outside createIpcBindings by design: getAppInfo is
    // registered directly, terminal data/exit and runtime updates are
    // main-to-renderer events, never invoke bindings.
    for (const standalone of [IPC_CHANNELS.getAppInfo, IPC_CHANNELS.terminalData, IPC_CHANNELS.terminalExit, IPC_CHANNELS.runtimeUpdated]) {
      assert.ok(all.delete(standalone), `${standalone} must exist`)
    }
    assert.deepEqual([...all].sort(), [...EXPECTED_PRODUCTION_CHANNELS].sort())
  })

  it('preload exposes every production AI/orchestration/change-set function', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8')
    for (const expected of [
      'IPC_CHANNELS.aiGenerateResponse',
      'IPC_CHANNELS.aiProposeFileChange',
      'IPC_CHANNELS.aiProposeChangeSet',
      'IPC_CHANNELS.aiRunBrain',
      'IPC_CHANNELS.changeSetsGet',
      'IPC_CHANNELS.changeSetsListRecent',
      'IPC_CHANNELS.orchestrationGet',
      'IPC_CHANNELS.orchestrationListRecent',
      'IPC_CHANNELS.heartGet',
      'IPC_CHANNELS.heartUpdate',
      'IPC_CHANNELS.looplinkCreateContinuation',
      'IPC_CHANNELS.looplinkGetForSession',
      'IPC_CHANNELS.looplinkDismiss',
      'IPC_CHANNELS.recoveryGetConfig',
      'IPC_CHANNELS.recoveryUpdateConfig',
      'IPC_CHANNELS.recoveryGetForSource',
      'IPC_CHANNELS.recoveryGetForTarget',
      'IPC_CHANNELS.recoveryDismiss',
      'createOrchestrationApi()',
      'orchestration: createOrchestrationApi()',
      'createChangeSetsApi()',
      'changeSets: createChangeSetsApi()',
      'createLooplinkApi()',
      'looplink: createLooplinkApi()',
      'createRecoveryApi()',
      'recovery: createRecoveryApi()',
      'IPC_CHANNELS.capabilitiesGetWorkspaceConfig',
      'IPC_CHANNELS.capabilitiesUpdateWorkspaceConfig',
      'createCapabilitiesApi()',
      'capabilities: createCapabilitiesApi()',
      'IPC_CHANNELS.workerToolsGetPendingApproval',
      'IPC_CHANNELS.workerToolsApproveAndResume',
      'IPC_CHANNELS.workerToolsDenyAndResume',
      'createWorkerToolsApi()',
      'workerTools: createWorkerToolsApi()',
      'IPC_CHANNELS.runtimesGetActive',
      'IPC_CHANNELS.runtimesListRecent',
      'IPC_CHANNELS.runtimesStop',
      'IPC_CHANNELS.runtimesOpenPreview',
      'IPC_CHANNELS.runtimesReloadPreview',
      'createRuntimesApi()',
      'runtimes: createRuntimesApi()',
      'IPC_CHANNELS.usageGetConfig',
      'IPC_CHANNELS.usageUpdateConfig',
      'IPC_CHANNELS.usageGetSummary',
      'createUsageApi()',
      'usage: createUsageApi()'
    ]) {
      assert.ok(source.includes(expected), `preload must contain ${expected}`)
    }
    assert.ok(!source.includes("'stark:ai:"), 'preload must not hardcode AI channel names')
    assert.ok(!source.includes("'stark:orchestration:"), 'preload must not hardcode orchestration channel names')
    assert.ok(!source.includes("'stark:change-sets:"), 'preload must not hardcode change-set channel names')
    assert.ok(!source.includes("'stark:looplink:"), 'preload must not hardcode looplink channel names')
    assert.ok(!source.includes("'stark:recovery:"), 'preload must not hardcode recovery channel names')
    assert.ok(!source.includes("'stark:capabilities:"), 'preload must not hardcode capability channel names')
    assert.ok(!source.includes("'stark:worker-tools:"), 'preload must not hardcode worker-tool channel names')
    assert.ok(!source.includes("'stark:runtimes:"), 'preload must not hardcode runtime channel names')
    assert.ok(!source.includes("'stark:runtime:"), 'preload must not hardcode runtime event names')
  })
})
