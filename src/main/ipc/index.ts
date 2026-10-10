import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { APP_NAME, IPC_CHANNELS, type IpcChannel } from '../../shared/constants'
import { RENDERER_DEV_URL, RENDERER_ENTRY } from '../security/app-urls'
import type { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import type { ChangeSetService } from '../change-sets/change-set-service'
import type { HeartService } from '../heart/heart-service'
import type { LooplinkService } from '../looplink/looplink-service'
import type { RecoveryService } from '../recovery/recovery-service'
import type { CapabilityService } from '../capabilities/capability-service'
import type { WorkerToolRunner } from '../worker-tools/worker-tool-runner'
import type { ProjectRuntimeService } from '../project-runtime/project-runtime-service'
import type { AiUsageService } from '../usage/ai-usage-service'
import type { AiRecoveryCoordinator } from '../recovery/recovery-coordinator'
import type { RecoveryRepository } from '../recovery/recovery-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { CloudAccountService } from '../cloud-account/cloud-account-service'
import type { AiBrainService } from '../ai/ai-brain-service'
import type { AiCodeProposalService } from '../ai/ai-code-proposal-service'
import type { AiCompletionService } from '../ai/ai-completion-service'
import type { AiMultiFileProposalService } from '../ai/ai-multi-file-proposal-service'
import type { AiProviderService } from '../ai/ai-provider-service'
import type { GitService } from '../git/git-service'
import type { CodingSessionService } from '../sessions/coding-session-service'
import type { SessionContextService } from '../session-context/session-context-service'
import type { SettingsService } from '../settings/settings-service'
import type { ProfileService } from '../profile/profile-service'
import type { TerminalManager } from '../terminal/terminal-manager'
import type { TerminalService } from '../terminal/terminal-service'
import type { WorkspaceService } from '../workspace/workspace-service'
import type { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import type { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import type { ExtensionRegistryService } from '../extension-registry/extension-registry-service'
import type { ExtensionInstallService } from '../extension-install/extension-install-service'
import type { ExtensionHostManager } from '../extension-host/extension-host-manager'
import type { ExtensionActivationService } from '../extension-host/extension-activation-service'
import type { ExtensionRuntimeService } from '../extension-host/extension-runtime-service'
import type { FormatterService } from '../formatter/formatter-service'
import type { AttachmentPicker } from '../chat-attachments/picker'
import type { ChatAttachmentService } from '../chat-attachments/service'
import type { VoiceTranscriptionService } from '../voice/voice-transcription-service'
import { getAppInfo } from '../services/app-info'
import type { IpcBinding } from './binding'
import { createAiBindings } from './ai'
import { createCapabilityBindings } from './capabilities'
import { createWorkerToolBindings } from './worker-tools'
import { createUsageBindings } from './usage'
import { createRuntimeBindings } from './runtimes'
import { createChangeSetBindings } from './change-sets'
import { createHeartBindings } from './heart'
import { createLooplinkBindings } from './looplink'
import { createRecoveryBindings } from './recovery'
import { createOrchestrationBindings } from './orchestration'
import { createChangeTransactionBindings } from './change-transactions'
import { createGitBindings } from './git'
import { createProfileBindings } from './profile'
import { createProviderBindings } from './providers'
import { createSessionBindings } from './sessions'
import { createSessionContextBindings } from './session-context'
import { createSettingsBindings } from './settings'
import { createTerminalBindings } from './terminal'
import { isTrustedIpcSender } from './trust'
import { createWorkspaceBindings, electronDirectoryPicker } from './workspace'
import { createWorkspaceFilesBindings } from './workspace-files'
import { createWorkspaceSearchBindings } from './workspace-search'
import { createExtensionsBindings } from './extensions'
import { createExtensionInstallBindings } from './extension-install'
import { createExtensionHostBindings } from './extension-host'
import { createExtensionActivationBindings } from './extension-activation'
import { createExtensionManagementBindings } from './extension-management'
import { createFormatterBindings } from './formatter'
import { createAttachmentBindings } from './attachments'
import { createAccountBindings } from './account'
import { createVoiceBindings } from './voice'

/**
 * Registers an IPC handler that first proves the caller is STARK's own
 * renderer (dev-server origin in development, packaged document in
 * production). Untrusted callers are rejected with an error, which
 * surfaces to the renderer as a rejected invoke promise.
 *
 * Every privileged handler must use this instead of ipcMain.handle.
 */
export function handleSecureIpc<TArgs extends unknown[], TReturn>(
  channel: IpcChannel,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => TReturn | Promise<TReturn>
): void {
  ipcMain.handle(channel, (event, ...args: TArgs) => {
    const trusted = isTrustedIpcSender(
      event.sender.isDestroyed(),
      event.senderFrame?.url ?? event.sender.getURL(),
      { devServerUrl: RENDERER_DEV_URL, rendererEntryFile: RENDERER_ENTRY }
    )
    if (!trusted) {
      console.warn(`[${APP_NAME}] rejected IPC '${channel}' from an untrusted sender`)
      throw new Error(`[stark] untrusted IPC sender for '${channel}'`)
    }
    return handler(event, ...args)
  })
}

/** Dependencies handed to every database-backed IPC handler. */
export interface IpcDependencies {
  readonly settingsService: SettingsService
  readonly profileService: ProfileService
  readonly workspaceService: WorkspaceService
  readonly workspaceFilesService: WorkspaceFilesService
  readonly workspaceFileWriteService: WorkspaceFileWriteService
  readonly workspaceSearchService: WorkspaceSearchService
  /** Extension catalog (display only). Optional in older harnesses; absent means no catalog channels. */
  readonly extensionRegistryService?: ExtensionRegistryService
  /** Extension installer (store only). Optional in older harnesses; absent means no install channels. */
  readonly extensionInstallService?: ExtensionInstallService
  /** Extension Host broker (foundation only). Optional in older harnesses; absent means no host channels. */
  readonly extensionHostManager?: ExtensionHostManager
  /**
   * Generic activation service (demand-driven only). Optional in
   * older harnesses; absent means no activate/deactivate/list-active
   * channels. Constructed in main/index.ts from the host manager
   * plus the install service.
   */
  readonly extensionActivationService?: ExtensionActivationService
  /**
   * Generic runtime coordinator (trust, triggers, providers, prompts,
   * diagnostics, proposals). Optional in older harnesses; absent
   * means no extension-management channels.
   */
  readonly extensionRuntimeService?: ExtensionRuntimeService
  /**
   * Document formatter (Prettier pilot). Optional; absent means no
   * formatter channel. Constructed in main/index.ts from the host
   * manager plus install/files/workspace services.
   */
  readonly formatterService?: FormatterService
  /** Chat attachments (local files + images). Optional in older harnesses; absent means no attachment channels. */
  readonly attachmentService?: ChatAttachmentService
  readonly attachmentPicker?: AttachmentPicker
  /** Step 4 voice transcription. Optional in older harnesses; absent means no voice channel. */
  readonly voiceTranscriptionService?: VoiceTranscriptionService
  readonly changeTransactionService: ChangeTransactionService
  readonly terminalService: TerminalService
  readonly terminalManager: TerminalManager
  readonly gitService: GitService
  readonly codingSessionService: CodingSessionService
  readonly sessionContextService: SessionContextService
  readonly aiProviderService: AiProviderService
  readonly aiCompletionService: AiCompletionService
  /** Stage 16 proposal service. Optional in older harnesses; absent means no proposal channel. */
  readonly aiCodeProposalService?: AiCodeProposalService
  /** Stage 17 grouped proposals. Optional in older harnesses; absent means no change-set channels. */
  readonly aiMultiFileProposalService?: AiMultiFileProposalService
  readonly changeSetService?: ChangeSetService
  /** Stage 18 Brain orchestration. Optional in older harnesses; absent means no orchestration channels. */
  readonly aiBrainService?: AiBrainService
  /** Stage 19 Heart routing. Optional in older harnesses; absent means no heart channels. */
  readonly heartService?: HeartService
  /** Stage 20 continuity. Optional in older harnesses; absent means no looplink channels. */
  readonly looplinkService?: LooplinkService
  /** Stage 21 recovery. Optional in older harnesses; absent means no recovery channels. */
  readonly recoveryService?: RecoveryService
  readonly recoveryStore?: RecoveryRepository
  readonly recoveryCoordinator?: AiRecoveryCoordinator
  /** Stage 22 capabilities. Optional in older harnesses; absent means no capability channels. */
  readonly capabilityService?: CapabilityService
  /** Stage 23 worker tools. Optional; absent means no approval channels and legacy Work. */
  readonly workerToolRunner?: WorkerToolRunner
  /** Stage 26 managed project runtimes. Optional; absent means no runtime channels. */
  readonly projectRuntimeService?: ProjectRuntimeService
  /** Stage 28 local usage awareness. Optional; absent means no usage channels. */
  readonly usageService?: AiUsageService
  /** Stage 29 optional cloud account. Optional; absent means no account channels. */
  readonly cloudAccountService?: CloudAccountService
  readonly workspaces?: WorkspaceRepository
  readonly codingSessions?: CodingSessionRepository
}

/**
 * The complete, enumerable IPC surface. Pure data — no Electron calls —
 * so tests can assert exactly which channels exist. Registration below
 * is the only place ipcMain.handle is reachable.
 */
export function createIpcBindings(deps: IpcDependencies): readonly IpcBinding[] {
  const bindings: IpcBinding[] = [
    ...createSettingsBindings(deps.settingsService),
    ...createProfileBindings(deps.profileService),
    ...createWorkspaceBindings(deps.workspaceService, electronDirectoryPicker),
    ...createWorkspaceFilesBindings(deps.workspaceFilesService, deps.workspaceFileWriteService),
    ...createWorkspaceSearchBindings(deps.workspaceSearchService),
    ...createChangeTransactionBindings(deps.changeTransactionService),
    ...createTerminalBindings(deps.terminalService, deps.terminalManager),
    ...createGitBindings(deps.gitService),
    ...createSessionBindings(deps.codingSessionService),
    ...createSessionContextBindings(deps.sessionContextService),
    ...createProviderBindings(deps.aiProviderService),
    ...createAiBindings(
      deps.aiCompletionService,
      deps.aiCodeProposalService,
      deps.aiMultiFileProposalService,
      deps.recoveryCoordinator
    )
  ]
  if (deps.changeSetService !== undefined) {
    bindings.push(...createChangeSetBindings(deps.changeSetService))
  }
  if (deps.aiBrainService !== undefined) {
    bindings.push(...createOrchestrationBindings(deps.aiBrainService, deps.recoveryCoordinator, deps.workerToolRunner))
  }
  if (deps.heartService !== undefined) {
    bindings.push(...createHeartBindings(deps.heartService))
  }
  if (deps.looplinkService !== undefined) {
    bindings.push(...createLooplinkBindings(deps.looplinkService))
  }
  if (deps.recoveryService !== undefined && deps.recoveryStore !== undefined) {
    if (deps.workspaces !== undefined && deps.codingSessions !== undefined) {
      bindings.push(
        ...createRecoveryBindings(deps.recoveryService, deps.recoveryStore, deps.workspaces, deps.codingSessions)
      )
    }
  }
  if (deps.capabilityService !== undefined) {
    bindings.push(...createCapabilityBindings(deps.capabilityService))
  }
  if (deps.workerToolRunner !== undefined) {
    bindings.push(...createWorkerToolBindings(deps.workerToolRunner))
  }
  if (deps.projectRuntimeService !== undefined) {
    bindings.push(...createRuntimeBindings(deps.projectRuntimeService))
  }
  if (deps.usageService !== undefined) {
    bindings.push(...createUsageBindings(deps.usageService, deps.heartService))
  }
  if (deps.extensionRegistryService !== undefined) {
    bindings.push(...createExtensionsBindings(deps.extensionRegistryService))
  }
  if (deps.extensionInstallService !== undefined) {
    const formatter = deps.formatterService
    const activation = deps.extensionActivationService
    const runtime = deps.extensionRuntimeService
    const hostManager = deps.extensionHostManager
    const deactivateExact = (identity: { namespace: string; name: string; version: string }): Promise<unknown> => {
      // The runtime path additionally releases watchers and caches;
      // the activation path is the older harness fallback.
      if (runtime !== undefined) {
        return runtime.deactivateExtension(identity)
      }
      if (activation !== undefined) {
        return activation.deactivateExtension(identity)
      }
      return Promise.resolve(true)
    }
    bindings.push(
      ...createExtensionInstallBindings(deps.extensionInstallService, {
        onEnabledStateChanged: (identity, enabled) => {
          // Unload on disable only; enabling needs no host action.
          // Fire-and-forget by design (best-effort unload). The
          // generic service deactivates the exact instance (bounded
          // deactivate + disposal, host stop on hang); the formatter
          // adapter unloads its legacy registration the same way.
          if (!enabled) {
            void (async () => {
              try {
                await deactivateExact(identity)
              } catch {
                // Best effort: the host stop below still unloads.
              }
              void formatter?.noteExtensionDisabled()
            })()
          }
        },
        beforeUninstall: async (identity) => {
          // Active modules cannot be deleted live: deactivate the
          // exact instance first (bounded); a hang stops the owned
          // host before the safe file removal below.
          try {
            const deactivated = await deactivateExact(identity)
            if (deactivated === false && hostManager !== undefined) {
              try {
                await hostManager.stop()
              } catch {
                // Best effort: removal proceeds regardless.
              }
            }
          } catch {
            try {
              await hostManager?.stop()
            } catch {
              // Best effort.
            }
          }
        },
        onUninstalled: () => {
          void formatter?.noteExtensionDisabled()
        }
      })
    )
  }
  if (deps.extensionHostManager !== undefined) {
    bindings.push(...createExtensionHostBindings(deps.extensionHostManager))
  }
  if (deps.extensionActivationService !== undefined) {
    bindings.push(...createExtensionActivationBindings(deps.extensionActivationService))
  }
  if (deps.extensionRuntimeService !== undefined) {
    bindings.push(...createExtensionManagementBindings(deps.extensionRuntimeService))
  }
  if (deps.formatterService !== undefined) {
    bindings.push(...createFormatterBindings(deps.formatterService))
  }
  if (deps.attachmentService !== undefined && deps.attachmentPicker !== undefined) {
    bindings.push(...createAttachmentBindings(deps.attachmentService, deps.attachmentPicker))
  }
  if (deps.voiceTranscriptionService !== undefined) {
    bindings.push(...createVoiceBindings(deps.voiceTranscriptionService))
  }
  if (deps.cloudAccountService !== undefined) {
    bindings.push(...createAccountBindings(deps.cloudAccountService))
  }
  return bindings
}

/**
 * Registers every IPC handler exposed to renderers.
 *
 * Rules for this module:
 * - One handler per channel declared in shared/constants IPC_CHANNELS.
 * - Handlers delegate to services; no business logic lives here.
 * - Never expose filesystem, shell, or process spawning to the renderer.
 */
export function registerIpcHandlers(deps: IpcDependencies): void {
  handleSecureIpc(IPC_CHANNELS.getAppInfo, () => getAppInfo())
  for (const binding of createIpcBindings(deps)) {
    handleSecureIpc(binding.channel, (event, payload: unknown) => binding.invoke(payload, event))
  }
}
