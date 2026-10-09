import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { ChangeSetService } from '../change-sets/change-set-service'
import type { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import type { ChangeSetRepository } from '../database/repositories/change-set-repository'
import type { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { HeartRepository } from '../heart/heart-repository'
import type { LooplinkRepository } from '../looplink/looplink-repository'
import type { KeyValueRepository } from '../database/repositories/key-value-repository'
import type { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { GitProcessRunner } from '../git/git-process-runner'
import { GitService } from '../git/git-service'
import { ProfileService } from '../profile/profile-service'
import { AiBrainService } from '../ai/ai-brain-service'
import { AiCodeProposalService } from '../ai/ai-code-proposal-service'
import { AiMultiFileProposalService } from '../ai/ai-multi-file-proposal-service'
import { AiCompletionService } from '../ai/ai-completion-service'
import { AiOperationGuard } from '../ai/ai-operation-guard'
import { AiProviderService } from '../ai/ai-provider-service'
import { ElectronSafeStorageCredentialProtector, type CredentialProtector } from '../ai/credential-protector'
import { OpenAiProviderAdapter, createOpenAiClient, type OpenAiClientFactory } from '../ai/openai-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import { CodingSessionService } from '../sessions/coding-session-service'
import { HeartService } from '../heart/heart-service'
import { LooplinkService } from '../looplink/looplink-service'
import { RecoveryRepository } from '../recovery/recovery-repository'
import { RecoveryService } from '../recovery/recovery-service'
import { AiRecoveryCoordinator } from '../recovery/recovery-coordinator'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityService } from '../capabilities/capability-service'
import { CapabilityGate } from '../capabilities/capability-gate'
import { WorkerCommandRepository } from '../worker-tools/worker-command-repository'
import { WorkerCommandService } from '../worker-tools/worker-command-service'
import { ProjectRuntimeRepository } from '../project-runtime/project-runtime-repository'
import { ProjectRuntimeService } from '../project-runtime/project-runtime-service'
import { RuntimeObservationService } from '../runtime-observation/runtime-observation-service'
import { PreviewInspectionService } from '../preview-inspection/preview-inspection-service'
import { WorkerToolRepository } from '../worker-tools/worker-tool-repository'
import { WorkerToolApprovalService } from '../worker-tools/worker-tool-approval-service'
import { WorkerReadToolService } from '../worker-tools/worker-tool-service'
import { WorkerToolRunner } from '../worker-tools/worker-tool-runner'
import { AiUsageRepository } from '../usage/ai-usage-repository'
import { AiUsageService } from '../usage/ai-usage-service'
import { AiUsageTracker } from '../usage/ai-usage-tracker'
import { SessionContextService } from '../session-context/session-context-service'
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
  readonly sessionContextService: SessionContextService
  readonly aiProviderService: AiProviderService
  readonly aiCompletionService: AiCompletionService
  readonly aiCodeProposalService: AiCodeProposalService
  /** Stage 17 grouped proposals. Absent in older harnesses without a change-set repository. */
  readonly changeSetService?: ChangeSetService
  readonly aiMultiFileProposalService?: AiMultiFileProposalService
  /** Stage 18 Brain orchestration. Absent in older harnesses without an orchestration repository. */
  readonly aiBrainService?: AiBrainService
  /** Stage 19 Heart routing. Absent in older harnesses without a heart repository. */
  readonly heartService?: HeartService
  /** Stage 20 continuity. Absent in older harnesses without a looplink repository. */
  readonly looplinkService?: LooplinkService
  /** Stage 21 recovery. Absent in older harnesses without a recovery repository. */
  readonly recoveryStore?: RecoveryRepository
  readonly recoveryService?: RecoveryService
  readonly recoveryCoordinator?: AiRecoveryCoordinator
  /** Stage 22 capabilities. Absent in older harnesses without a capability repository. */
  readonly capabilityStore?: CapabilityRepository
  readonly capabilityService?: CapabilityService
  readonly capabilityGate?: CapabilityGate
  /** Stage 23 worker tools. Absent in older harnesses without a worker-tool repository. */
  readonly workerToolStore?: WorkerToolRepository
  readonly workerToolApprovalService?: WorkerToolApprovalService
  readonly workerReadToolService?: WorkerReadToolService
  readonly workerToolRunner?: WorkerToolRunner
  /** Stage 25 worker commands. Absent in older harnesses without a command repository. */
  readonly workerCommandStore?: WorkerCommandRepository
  readonly workerCommandService?: WorkerCommandService
  /** Stage 26 managed project runtimes. Absent in older harnesses without a runtime repository. */
  readonly runtimeStore?: ProjectRuntimeRepository
  readonly projectRuntimeService?: ProjectRuntimeService
  /** Stage 27 read-only observations. Absent in older harnesses without a runtime repository. */
  readonly runtimeObservationService?: RuntimeObservationService
  readonly previewInspectionService?: PreviewInspectionService
  /** Stage 28 local usage awareness. Absent in older harnesses without a usage repository. */
  readonly usageStore?: AiUsageRepository
  readonly usageService?: AiUsageService
}

export interface ServiceDependencies {
  readonly keyValue: KeyValueRepository
  readonly workspaces: WorkspaceRepository
  readonly changeTransactions: ChangeTransactionRepository
  readonly codingSessions: CodingSessionRepository
  readonly aiProviders: AiProviderRepository
  /** Stage 17 change-set repository. Optional so older harnesses keep working. */
  readonly changeSets?: ChangeSetRepository
  /** Stage 18 orchestration repository. Optional so older harnesses keep working. */
  readonly orchestrationRuns?: OrchestrationRepository
  /** Stage 19 heart repository. Optional so older harnesses keep working. */
  readonly heartStore?: HeartRepository
  /** Stage 20 looplink repository. Optional so older harnesses keep working. */
  readonly looplinkStore?: LooplinkRepository
  /** Stage 21 recovery repository. Optional so older harnesses keep working. */
  readonly recoveryStore?: RecoveryRepository
  /** Stage 22 capability repository. Optional so older harnesses keep working. */
  readonly capabilityStore?: CapabilityRepository
  /** Stage 23 worker-tool repository. Optional so older harnesses keep working. */
  readonly workerToolStore?: WorkerToolRepository
  /** Stage 25 worker command-execution repository. Optional so older harnesses keep working. */
  readonly workerCommandStore?: WorkerCommandRepository
  /** Stage 26 project-runtime repository. Optional so older harnesses keep working. */
  readonly runtimeStore?: ProjectRuntimeRepository
  /** Stage 28 usage repository. Optional so older harnesses keep working. */
  readonly usageStore?: AiUsageRepository
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
  const heartService =
    deps.heartStore === undefined
      ? undefined
      : new HeartService(deps.heartStore, deps.aiProviders, registry)
  // Stage 28 local usage awareness: one ledger repository, one
  // validating service, one central call tracker shared by every AI
  // service below. Absent in older harnesses (legacy untracked).
  // Threshold routing stays off until the user explicitly opts in.
  const usageStore = deps.usageStore
  const usageService =
    usageStore === undefined
      ? undefined
      : new AiUsageService(usageStore, registry, {
          heartBaseResolver:
            heartService === undefined
              ? undefined
              : (routeKey) => {
                  try {
                    const config = heartService.getConfig()
                    if (config === null) {
                      return null
                    }
                    if (routeKey === 'brain.primary') {
                      return { ...config.brain }
                    }
                    if (routeKey === 'worker.fixed') {
                      return config.workerFixed === null ? null : { ...config.workerFixed }
                    }
                    if (routeKey === 'worker.default') {
                      return config.workerDefault === null ? null : { ...config.workerDefault }
                    }
                    const profile = routeKey.replace(/^worker\./, '')
                    if (profile === 'general' || profile === 'coding' || profile === 'reasoning' || profile === 'fast') {
                      const route = config.workerRoutes[profile]
                      return route === null ? null : { ...route }
                    }
                    return null
                  } catch {
                    return null
                  }
                }
        })
  const usageTracker = usageStore === undefined ? undefined : new AiUsageTracker(usageStore)
  const usage = usageService === undefined || usageTracker === undefined ? undefined : { tracker: usageTracker, service: usageService }
  const workspaceFilesService = new WorkspaceFilesService(deps.workspaces)
  const workspaceSearchService = new WorkspaceSearchService(deps.workspaces)
  const sessionContextService = new SessionContextService(deps.workspaces, workspaceFilesService)
  // Shared per-session AI lock: normal generation and code proposals
  // for the same session exclude each other.
  const aiOperationGuard = new AiOperationGuard()
  // Stage 23 pending approvals (optional): while an approval waits,
  // new Ask/Work/Proposal operations in the same session are blocked
  // with a safe error instead of holding the AI guard.
  const workerToolStoreEarly = deps.workerToolStore
  const pendingApprovals =
    workerToolStoreEarly === undefined
      ? undefined
      : { hasPending: (sessionId: number): boolean => workerToolStoreEarly.hasPending(sessionId) }
  const changeTransactionService = new ChangeTransactionService(
    deps.workspaces,
    deps.changeTransactions,
    fileWriteService
  )
  // Stage 17 grouped proposals: built only when a change-set
  // repository is supplied; older harnesses omit it.
  const changeSetService =
    deps.changeSets === undefined
      ? undefined
      : new ChangeSetService(deps.workspaces, deps.changeSets, deps.changeTransactions)
  const aiMultiFileProposalService =
    changeSetService === undefined
      ? undefined
      : new AiMultiFileProposalService(
          deps.workspaces,
          deps.codingSessions,
          deps.aiProviders,
          aiProviderService,
          registry,
          workspaceFilesService,
          changeSetService,
          { operationGuard: aiOperationGuard, pendingApprovals, usage }
        )
  // Stage 20 continuity: built only when a looplink repository is
  // supplied; older harnesses omit it and keep legacy AI behavior.
  // Stage 21 couples handoff_ready dismissal with the recovery event
  // when a recovery store is present (one atomic transaction).
  const looplinkStore = deps.looplinkStore
  const looplinkService =
    looplinkStore === undefined
      ? undefined
      : new LooplinkService(
          deps.workspaces,
          deps.codingSessions,
          looplinkStore,
          aiOperationGuard,
          deps.orchestrationRuns,
          deps.changeSets,
          deps.changeTransactions,
          Date.now,
          deps.recoveryStore
        )
  const looplinkOption =
    looplinkService === undefined || looplinkStore === undefined
      ? undefined
      : { service: looplinkService, store: looplinkStore }
  const aiBrainService =
    deps.orchestrationRuns === undefined || heartService === undefined
      ? undefined
      : new AiBrainService(
          deps.workspaces,
          deps.codingSessions,
          aiProviderService,
          deps.orchestrationRuns,
          heartService,
          { operationGuard: aiOperationGuard, looplink: looplinkOption, pendingApprovals, usage }
        )
  const aiCompletionService = new AiCompletionService(
      deps.workspaces,
      deps.codingSessions,
      deps.aiProviders,
      aiProviderService,
      registry,
      { operationGuard: aiOperationGuard, looplink: looplinkOption, pendingApprovals, usage }
    )
  // Stage 21 recovery: built only when a recovery repository is
  // supplied; older harnesses omit it and keep legacy AI behavior.
  // Recovery defaults to off — never silently enabled.
  const recoveryStore = deps.recoveryStore
  const recoveryService =
    recoveryStore === undefined
      ? undefined
      : new RecoveryService(recoveryStore, deps.aiProviders, registry)
  const recoveryCoordinator =
    recoveryStore === undefined ||
    recoveryService === undefined ||
    looplinkService === undefined ||
    looplinkStore === undefined
      ? undefined
      : new AiRecoveryCoordinator({
          workspaces: deps.workspaces,
          sessions: deps.codingSessions,
          orchestrationRuns: deps.orchestrationRuns,
          completion: aiCompletionService,
          brain: aiBrainService,
          looplinkService,
          looplinkStore,
          recoveryStore,
          recoveryService
        })
  // Stage 22 capabilities: built only when a capability repository
  // is supplied; older harnesses omit it. Default is deny everywhere
  // with the master switch off — never silently enabled.
  const capabilityStore = deps.capabilityStore
  const capabilityService =
    capabilityStore === undefined
      ? undefined
      : new CapabilityService(capabilityStore, deps.workspaces)
  const capabilityGate =
    capabilityStore === undefined
      ? undefined
      : new CapabilityGate(deps.workspaces, deps.codingSessions, capabilityStore)
  // Stage 23 worker tools: approval + read-only execution share the
  // worker-tool repository.
  const workerToolStore = deps.workerToolStore
  const workerToolApprovalService =
    workerToolStore === undefined || deps.orchestrationRuns === undefined
      ? undefined
      : new WorkerToolApprovalService(deps.workspaces, deps.codingSessions, deps.orchestrationRuns, workerToolStore)
  const gitService = new GitService(deps.workspaces, new GitProcessRunner())
  // Stage 25 worker commands: reservation + bounded non-interactive
  // execution share the command repository. Built only when the command
  // repository, capability gate, and worker-tool storage are present.
  const workerCommandStore = deps.workerCommandStore
  const workerCommandService =
    workerCommandStore === undefined || capabilityGate === undefined || workerToolStore === undefined
      ? undefined
      : new WorkerCommandService({
          workspaces: deps.workspaces,
          gate: capabilityGate,
          commands: workerCommandStore
        })
  // Stage 26 managed project runtimes: reservation + lifecycle share
  // the runtime repository. Built only when the runtime repository,
  // capability gate, worker-tool storage, and orchestration runs are
  // present. The renderer-update sink is wired by the app root after
  // construction (tests inject their own listeners).
  const runtimeStore = deps.runtimeStore
  const projectRuntimeService =
    runtimeStore === undefined || capabilityGate === undefined || workerToolStore === undefined
      ? undefined
      : new ProjectRuntimeService({
          workspaces: deps.workspaces,
          gate: capabilityGate,
          runtimes: runtimeStore,
          runs: deps.orchestrationRuns
        })
  // Stage 27 read-only observations: bounded runtime state/logs and
  // bounded rendered Preview snapshots. Built only when the runtime
  // repository exists; the hidden inspector defaults to unavailable
  // in headless harnesses (tests inject fakes) and the visible target
  // resolves from the live Preview map when present.
  const runtimeObservationService =
    runtimeStore === undefined ? undefined : new RuntimeObservationService({ runtimes: runtimeStore })
  const previewInspectionService =
    runtimeStore === undefined
      ? undefined
      : new PreviewInspectionService({
          runtimes: runtimeStore,
          getVisiblePreviewUrl:
            projectRuntimeService === undefined
              ? undefined
              : (runtimeId: number) => projectRuntimeService.getVisiblePreviewUrl(runtimeId)
        })
  const workerReadToolService =
    workerToolStore === undefined || capabilityGate === undefined
      ? undefined
      : new WorkerReadToolService({
          gate: capabilityGate,
          files: workspaceFilesService,
          search: new WorkspaceSearchService(deps.workspaces),
          git: gitService,
          tools: workerToolStore,
          transactions: changeTransactionService,
          changeSets: changeSetService,
          commands: workerCommandService,
          runtimes: projectRuntimeService,
          runtimeObservation: runtimeObservationService,
          previewInspection: previewInspectionService
        })
  // Stage 23 tool-enabled Work runner: built only when Heart, gate,
  // files/search/git, and worker-tool storage are all present.
  // Older harnesses omit it and keep legacy Work.
  const workerToolRunner =
    workerToolStore === undefined ||
    capabilityGate === undefined ||
    workerReadToolService === undefined ||
    workerToolApprovalService === undefined ||
    aiBrainService === undefined ||
    heartService === undefined ||
    deps.orchestrationRuns === undefined
      ? undefined
      : new WorkerToolRunner(
          {
            workspaces: deps.workspaces,
            sessions: deps.codingSessions,
            providerService: aiProviderService,
            runs: deps.orchestrationRuns,
            heart: heartService,
            guard: aiOperationGuard,
            looplink: looplinkOption,
            gate: capabilityGate,
            files: workspaceFilesService,
            search: workspaceSearchService,
            git: gitService,
            tools: workerToolStore,
            approvals: workerToolApprovalService,
            executor: workerReadToolService,
            runtimes: projectRuntimeService,
            runtimeObservation: runtimeObservationService,
            previewInspection: previewInspectionService,
            usage
          },
          undefined
        )
  return {
    settingsService: new SettingsService(deps.keyValue),
    profileService: new ProfileService(deps.keyValue),
    workspaceService: new WorkspaceService(deps.workspaces),
    workspaceFilesService,
    workspaceFileWriteService: fileWriteService,
    workspaceSearchService,
    changeTransactionService,
    terminalService: new TerminalService(deps.workspaces),
    gitService,
    codingSessionService: new CodingSessionService(deps.workspaces, deps.codingSessions, {
      contextService: sessionContextService
    }),
    sessionContextService,
    aiProviderService,
    aiCompletionService,
    aiCodeProposalService: new AiCodeProposalService(
      deps.workspaces,
      deps.codingSessions,
      deps.aiProviders,
      aiProviderService,
      registry,
      workspaceFilesService,
      changeTransactionService,
      { operationGuard: aiOperationGuard, pendingApprovals, usage }
    ),
    changeSetService,
    aiMultiFileProposalService,
    aiBrainService,
    heartService,
    looplinkService,
    recoveryStore,
    recoveryService,
    recoveryCoordinator,
    capabilityStore,
    capabilityService,
    capabilityGate,
    workerToolStore,
    workerToolApprovalService,
    workerReadToolService,
    workerToolRunner,
    workerCommandStore,
    workerCommandService,
    runtimeStore,
    projectRuntimeService,
    runtimeObservationService,
    previewInspectionService,
    usageStore,
    usageService
  }
}
