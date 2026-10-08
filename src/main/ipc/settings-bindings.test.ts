import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { ChangeSetService } from '../change-sets/change-set-service'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { ProfileService } from '../profile/profile-service'
import { SettingsService } from '../settings/settings-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { WorkspaceService } from '../workspace/workspace-service'
import { GitProcessRunner } from '../git/git-process-runner'
import { GitService } from '../git/git-service'
import { AiBrainService } from '../ai/ai-brain-service'
import { AiCodeProposalService } from '../ai/ai-code-proposal-service'
import { AiMultiFileProposalService } from '../ai/ai-multi-file-proposal-service'
import { AiCompletionService } from '../ai/ai-completion-service'
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import { AiProviderService } from '../ai/ai-provider-service'
import type { CredentialProtector } from '../ai/credential-protector'
import { OpenAiProviderAdapter } from '../ai/openai-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { TerminalManager } from '../terminal/terminal-manager'
import { TerminalService } from '../terminal/terminal-service'
import { createIpcBindings } from './index'
import { createSettingsBindings } from './settings'

function openService(): {
  db: DatabaseSync
  service: SettingsService
  profile: ProfileService
  workspace: WorkspaceService
  files: WorkspaceFilesService
  fileWrites: WorkspaceFileWriteService
  search: WorkspaceSearchService
  changes: ChangeTransactionService
  terminal: TerminalService
  git: GitService
  sessions: CodingSessionService
  sessionContext: SessionContextService
  aiProviders: AiProviderService
  aiCompletion: AiCompletionService
  aiCodeProposal: AiCodeProposalService
  aiMultiProposal: AiMultiFileProposalService
  changeSets: ChangeSetService
  aiBrain: AiBrainService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const repository = new KeyValueRepository(db)
  const workspaces = new WorkspaceRepository(db)
  const changeTransactions = new ChangeTransactionRepository(db)
  const codingSessions = new CodingSessionRepository(db)
  const aiProviderRows = new AiProviderRepository(db)
  const fileWrites = new WorkspaceFileWriteService(workspaces)
  const filesService = new WorkspaceFilesService(workspaces)
  // Surface-only construction: the registry factory throws if any test
  // ever touches the network, and the protector is never invoked here.
  const registry = new ProviderRegistry()
  registry.register(
    new OpenAiProviderAdapter(() => {
      throw new Error('network must not run in surface tests')
    })
  )
  const aiProviders = new AiProviderService(aiProviderRows, new FakeSurfaceProtector(), registry)
  const changeSetRows = new ChangeSetRepository(db)
  const orchestrationRows = new OrchestrationRepository(db)
  const changeSets = new ChangeSetService(workspaces, changeSetRows, changeTransactions)
  return {
    db,
    service: new SettingsService(repository),
    profile: new ProfileService(repository),
    workspace: new WorkspaceService(workspaces),
    files: filesService,
    fileWrites,
    search: new WorkspaceSearchService(workspaces),
    changes: new ChangeTransactionService(workspaces, changeTransactions, fileWrites),
    terminal: new TerminalService(workspaces),
    git: new GitService(workspaces, new GitProcessRunner()),
    sessions: new CodingSessionService(workspaces, codingSessions),
    sessionContext: new SessionContextService(workspaces, filesService),
    aiProviders,
    aiCompletion: new AiCompletionService(workspaces, codingSessions, aiProviderRows, aiProviders, registry),
    aiCodeProposal: new AiCodeProposalService(
      workspaces,
      codingSessions,
      aiProviderRows,
      aiProviders,
      registry,
      filesService,
      new ChangeTransactionService(workspaces, changeTransactions, fileWrites)
    ),
    aiMultiProposal: new AiMultiFileProposalService(
      workspaces,
      codingSessions,
      aiProviderRows,
      aiProviders,
      registry,
      filesService,
      changeSets
    ),
    changeSets,
    aiBrain: (() => {
      const heart = new HeartService(new HeartRepository(db), aiProviderRows, registry)
      return new AiBrainService(workspaces, codingSessions, aiProviders, orchestrationRows, heart)
    })()
  }
}

/** Never-used protector for surface tests: availability checks stay local. */
class FakeSurfaceProtector implements CredentialProtector {
  async isAvailable(): Promise<boolean> {
    return true
  }
  async encrypt(secret: string): Promise<Buffer> {
    return Buffer.from(`enc:${secret}`, 'utf8')
  }
  async decrypt(ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
    return { secret: ciphertext.toString('utf8').replace(/^enc:/, ''), shouldReEncrypt: false }
  }
}

const EXPECTED_CHANNELS = ['stark:settings:get', 'stark:settings:reset', 'stark:settings:update']

const EXPECTED_ALL_CHANNELS = [
  'stark:ai:generate-response',
  'stark:ai:propose-change-set',
  'stark:ai:propose-file-change',
  'stark:ai:run-brain',
  'stark:change-sets:get',
  'stark:change-sets:list-recent',
  'stark:orchestration:get',
  'stark:orchestration:list-recent',
  'stark:changes:accept',
  'stark:changes:create',
  'stark:changes:get',
  'stark:changes:list-recent',
  'stark:changes:reject',
  'stark:changes:rollback',
  'stark:git:get-diff',
  'stark:git:get-status',
  'stark:profile:get',
  'stark:profile:set-display-name',
  'stark:providers:clear-credential',
  'stark:providers:get-state',
  'stark:providers:list-models',
  'stark:providers:save-credential',
  'stark:providers:set-model',
  'stark:providers:test-connection',
  'stark:session-context:prepare-excerpt',
  'stark:session-context:prepare-file',
  'stark:session-context:prepare-note',
  'stark:session-context:prepare-search-match',
  'stark:sessions:create',
  'stark:sessions:list',
  'stark:sessions:list-messages',
  'stark:sessions:send-user-message',
  'stark:settings:get',
  'stark:settings:reset',
  'stark:settings:update',
  'stark:terminal:create',
  'stark:terminal:kill',
  'stark:terminal:resize',
  'stark:terminal:write',
  'stark:workspace-files:list-directory',
  'stark:workspace-files:read-text-file',
  'stark:workspace-files:write-text-file',
  'stark:workspace-search:search',
  'stark:workspace:choose-directory',
  'stark:workspace:get-current',
  'stark:workspace:list-recent',
  'stark:workspace:open'
]

describe('settings IPC bindings', () => {
  it('exposes exactly the settings channels and nothing else', () => {
    const { db, service } = openService()
    try {
      const channels = createSettingsBindings(service).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), EXPECTED_CHANNELS)
      for (const channel of channels) {
        assert.ok(channel.startsWith('stark:'))
        assert.ok(!channel.includes('db:'))
        assert.ok(!channel.includes('sql:'))
        assert.ok(!channel.includes('key'))
      }
    } finally {
      db.close()
    }
  })

  it('the full IPC surface contains no arbitrary channels', () => {
    const { db, service, profile, workspace, files, fileWrites, search, changes, terminal, git, sessions, sessionContext, aiProviders, aiCompletion, aiCodeProposal, aiMultiProposal, changeSets, aiBrain } = openService()
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
        settingsService: service,
        profileService: profile,
        workspaceService: workspace,
        workspaceFilesService: files,
        workspaceFileWriteService: fileWrites,
        workspaceSearchService: search,
        changeTransactionService: changes,
        terminalService: terminal,
        terminalManager,
        gitService: git,
        codingSessionService: sessions,
        sessionContextService: sessionContext,
        aiProviderService: aiProviders,
        aiCompletionService: aiCompletion,
        aiCodeProposalService: aiCodeProposal,
        aiMultiFileProposalService: aiMultiProposal,
        changeSetService: changeSets,
        aiBrainService: aiBrain
      }).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), [...EXPECTED_ALL_CHANNELS].sort())
    } finally {
      db.close()
    }
  })

  it('get delegates to the settings service', async () => {
    const { db, service } = openService()
    try {
      await service.updateSettings({ reduceMotion: true })
      const bindings = createSettingsBindings(service)
      const get = bindings.find((binding) => binding.channel === 'stark:settings:get')
      assert.ok(get !== undefined)
      assert.deepEqual(await get.invoke(), {
        appearance: 'dark',
        reduceMotion: true,
        confirmBeforeDestructiveActions: true
      })
    } finally {
      db.close()
    }
  })

  it('update validates payload before persistence', async () => {
    const { db, service } = openService()
    try {
      await service.updateSettings({ appearance: 'system' })
      const bindings = createSettingsBindings(service)
      const update = bindings.find((binding) => binding.channel === 'stark:settings:update')
      assert.ok(update !== undefined)
      await assert.rejects(update.invoke({ appearance: 'blue' }), /stark settings update failed/)
      await assert.rejects(update.invoke({ unknownSetting: true }), /stark settings update failed/)
      assert.deepEqual(await service.getSettings(), {
        appearance: 'system',
        reduceMotion: false,
        confirmBeforeDestructiveActions: true
      })
    } finally {
      db.close()
    }
  })

  it('reset works through the binding', async () => {
    const { db, service } = openService()
    try {
      await service.updateSettings({ reduceMotion: true })
      const bindings = createSettingsBindings(service)
      const reset = bindings.find((binding) => binding.channel === 'stark:settings:reset')
      assert.ok(reset !== undefined)
      assert.deepEqual(await reset.invoke(), {
        appearance: 'dark',
        reduceMotion: false,
        confirmBeforeDestructiveActions: true
      })
    } finally {
      db.close()
    }
  })

  it('corrupt storage fails cleanly without internals', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      db.exec("INSERT INTO key_value (key, value, updated_at) VALUES ('stark.settings', '{broken', 0)")
      const service = new SettingsService(new KeyValueRepository(db))
      const bindings = createSettingsBindings(service)
      const get = bindings.find((binding) => binding.channel === 'stark:settings:get')
      assert.ok(get !== undefined)
      await assert.rejects(get.invoke(), /stark settings get failed: stored settings are invalid/)
    } finally {
      db.close()
    }
  })
})
