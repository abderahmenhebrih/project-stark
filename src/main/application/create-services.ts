import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import type { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import type { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { KeyValueRepository } from '../database/repositories/key-value-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { GitProcessRunner } from '../git/git-process-runner'
import { GitService } from '../git/git-service'
import { ProfileService } from '../profile/profile-service'
import { AiCompletionService } from '../ai/ai-completion-service'
import { AiProviderService } from '../ai/ai-provider-service'
import { ElectronSafeStorageCredentialProtector, type CredentialProtector } from '../ai/credential-protector'
import { OpenAiProviderAdapter, createOpenAiClient, type OpenAiClientFactory } from '../ai/openai-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SettingsService } from '../settings/settings-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { WorkspaceService } from '../workspace/workspace-service'
import { TerminalService } from '../terminal/terminal-service'

/**
 * Application composition root.
 *
 * All domain services are constructed here, explicitly, from already
 * initialized infrastructure — no hidden global mutable service state,
 * no dependency-injection framework. Add future domains (workspaces,
 * sessions, …) as additional explicit fields.
 */
export interface ApplicationServices {
  readonly settingsService: SettingsService
  readonly profileService: ProfileService
  readonly workspaceService: WorkspaceService
  readonly workspaceFilesService: WorkspaceFilesService
  readonly workspaceFileWriteService: WorkspaceFileWriteService
  readonly workspaceSearchService: WorkspaceSearchService
  readonly changeTransactionService: ChangeTransactionService
  readonly terminalService: TerminalService
  readonly gitService: GitService
  readonly codingSessionService: CodingSessionService
  readonly aiProviderService: AiProviderService
  readonly aiCompletionService: AiCompletionService
}

export interface ServiceDependencies {
  readonly keyValue: KeyValueRepository
  readonly workspaces: WorkspaceRepository
  readonly changeTransactions: ChangeTransactionRepository
  readonly codingSessions: CodingSessionRepository
  readonly aiProviders: AiProviderRepository
}

/**
 * Provider-construction overrides. Defaults build the production
 * Electron credential protector and the official OpenAI client
 * factory; tests inject fakes without touching Electron or network.
 */
export interface ProviderConstruction {
  readonly credentialProtector?: CredentialProtector
  readonly openAiClientFactory?: OpenAiClientFactory
  /**
   * Fully prebuilt registry (tests only). When supplied, the default
   * OpenAI registration is skipped so suites can register fakes.
   */
  readonly registry?: ProviderRegistry
}

export function createServices(deps: ServiceDependencies, providers?: ProviderConstruction): ApplicationServices {
  // One shared writer: the Stage 8 mutation primitive used both directly
  // by IPC writes and indirectly by transaction accept/rollback.
  const fileWriteService = new WorkspaceFileWriteService(deps.workspaces)
  // Provider foundation: explicit registry with exactly one adapter.
  // No dynamic loading, no renderer-defined providers.
  const registry = providers?.registry ?? new ProviderRegistry()
  if (providers?.registry === undefined) {
    registry.register(new OpenAiProviderAdapter(providers?.openAiClientFactory ?? createOpenAiClient))
  }
  const protector = providers?.credentialProtector ?? new ElectronSafeStorageCredentialProtector()
  const aiProviderService = new AiProviderService(deps.aiProviders, protector, registry)
  return {
    settingsService: new SettingsService(deps.keyValue),
    profileService: new ProfileService(deps.keyValue),
    workspaceService: new WorkspaceService(deps.workspaces),
    workspaceFilesService: new WorkspaceFilesService(deps.workspaces),
    workspaceFileWriteService: fileWriteService,
    workspaceSearchService: new WorkspaceSearchService(deps.workspaces),
    changeTransactionService: new ChangeTransactionService(
      deps.workspaces,
      deps.changeTransactions,
      fileWriteService
    ),
    terminalService: new TerminalService(deps.workspaces),
    gitService: new GitService(deps.workspaces, new GitProcessRunner()),
    codingSessionService: new CodingSessionService(deps.workspaces, deps.codingSessions),
    aiProviderService,
    aiCompletionService: new AiCompletionService(
      deps.workspaces,
      deps.codingSessions,
      deps.aiProviders,
      aiProviderService,
      registry
    )
  }
}
