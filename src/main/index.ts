import { app, BrowserWindow, dialog, protocol, utilityProcess } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC_CHANNELS } from '../shared/constants'
import type { CloudAccountStatus } from '../shared/cloud-account/types'
import type { ProjectRuntimeUpdatedEvent } from '../shared/project-runtime/types'
import { setStarkAiDiagEnabled } from './ai/ai-provider-service'
import { createOpenAiClient } from './ai/openai-adapter'
import { createServices, type ApplicationServices } from './application/create-services'
import { extractDeepLinkFromArgv } from './cloud-account/deep-link'
import { StarkDatabase } from './database/database'
import { resolveDatabaseFile } from './database/paths'
import { DiagnosticLogger } from './diagnostics/diagnostic-logger'
import { redactForLog } from './diagnostics/diagnostic-redaction'
import {
  cleanupStaleInstallStaging,
  EXTENSION_INSTALL_DIR_NAME,
  ExtensionInstallService
} from './extension-install/extension-install-service'
import { ExtensionHostManager, type ExtensionHostLauncher } from './extension-host/extension-host-manager'
import { ExtensionActivationService } from './extension-host/extension-activation-service'
import { ExtensionRuntimeService } from './extension-host/extension-runtime-service'
import {
  devExtensionHostSourceDir,
  ensureExtensionHostArtifacts,
  extensionHostArtifactsComplete,
  missingExtensionHostArtifacts
} from './extension-host/extension-host-paths'
import { createWorkspaceFileAccess } from './extension-host/extension-workspace-access'
import { FormatterService } from './formatter/formatter-service'
import { electronAttachmentPicker } from './chat-attachments/picker'
import { ATTACHMENT_PROTOCOL, serveAttachmentRequest } from './chat-attachments/protocol'
import { EXTENSION_ICON_PROTOCOL, serveExtensionIconRequest } from './extension-icons/protocol'
import { registerIpcHandlers } from './ipc'
import { createTerminalEventSink } from './ipc/terminal'
import { applyContentSecurityPolicy } from './security/session'
import { FatalStartupPresenter } from './startup/fatal-startup'
import { installGlobalErrorHandlers } from './startup/global-errors'
import { performOrderedShutdown, ShutdownGuard } from './startup/shutdown'
import { parseSmokeConfig, smokeDatabaseFile, writeSmokeMarker } from './startup/smoke-mode'
import { runStartupRecoveryPasses } from './startup/startup-order'
import { createNodePtyFactory } from './terminal/node-pty-adapter'
import { TerminalManager } from './terminal/terminal-manager'
import { createAppWindow } from './windows/app-window'

let mainWindow: BrowserWindow | null = null

/**
 * The single database owner for the STARK process. Created here and
 * nowhere else; repositories hang off this instance.
 */
const starkDatabase = new StarkDatabase()

/**
 * The single terminal owner for the STARK process (Stage 11, human
 * only). Created once the app is ready alongside services; destroyed
 * renderers and app quit terminate sessions with bounded cleanup so no
 * orphan shells remain. No agent authority flows through this manager.
 */
let terminalManager: TerminalManager | null = null

/**
 * Bounded managed-runtime shutdown hook, installed once services are
 * constructed. Stops exact runtime trees created by this process and
 * persists their final state before the database connection closes.
 */
let shutdownRuntimes: (() => void) | null = null

/**
 * Release diagnostics owner (Stage 30): bounded in-memory ring, no
 * file sink in the default path, redacted lines only. Never carries
 * prompts, keys, tokens, file contents, or terminal output.
 */
const diagnostics = new DiagnosticLogger()

/** Process-lifetime shutdown guard: late child events drop after quit begins. */
const shutdownGuard = new ShutdownGuard()

/**
 * Registers the stark-attachment:// content scheme before app ready
 * (Electron requires scheme privileges up front). The request handler
 * itself is installed once services exist below; the scheme serves
 * STARK-owned attachment bytes by opaque ID only.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: ATTACHMENT_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: false, corsEnabled: false }
  },
  {
    scheme: EXTENSION_ICON_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: false, corsEnabled: false }
  }
])

/**
 * Exactly-once fatal-startup presenter: one minimal safe dialog
 * ("STARK could not start." + category + guidance) then Quit. No
 * relaunch loop, no second presentation per process.
 */
const fatalPresenter = new FatalStartupPresenter({
  showFatalSync: ({ title, message, detail }) => {
    dialog.showMessageBoxSync({ type: 'error', title, message, detail, buttons: ['Quit'], noLink: true })
  },
  quit: () => {
    app.quit()
  }
})

function logFatalDiagnostic(category: string, detail: string): void {
  try {
    diagnostics.log({ severity: 'error', subsystem: 'main', category, operation: 'fatal', message: detail })
  } catch {
    // Diagnostics must never break fatal handling.
  }
  if (!app.isPackaged) {
    try {
      console.error(`[STARK] fatal (${category}): ${redactForLog(detail).slice(0, 200)}`)
    } catch {
      // Best effort.
    }
  }
}

installGlobalErrorHandlers(process, {
  logFatal: logFatalDiagnostic,
  quitAfterFatal: () => {
    shutdownGuard.beginShutdown()
    fatalPresenter.presentFatal('local-data')
  }
})

/**
 * STARK cloud-account wiring (Stage 29, main-process only).
 * Holds the constructed services so platform deep-link callbacks
 * (second-instance argv, macOS open-url) reach the account service
 * without launching a second app instance.
 */
let accountServices: ApplicationServices | null = null

function broadcastAccountStatus(status: CloudAccountStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.accountUpdated, status)
      }
    } catch {
      // Best effort streaming: a destroyed renderer stops receiving.
    }
  }
}

/**
 * Fans extension runtime events (prompts, notifications, clipboard,
 * diagnostics, proposals) out to every open renderer. Payloads are
 * bounded, validated management records only — no paths, no code.
 */
function broadcastExtensionEvent(event: { kind: string; payload: Record<string, unknown> }): void {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.extensionsEvent, event)
      }
    } catch {
      // Best effort streaming: a destroyed renderer stops receiving.
    }
  }
}

/**
 * Handles one raw deep-link URL from the OS. Forwards exactly
 * stark:// callbacks to the account service; anything else is
 * ignored safely. Never logs the URL, code, or tokens — only a
 * secret-free outcome category.
 */
function handleAuthDeepLink(rawUrl: string): void {
  const service = accountServices?.cloudAccountService
  if (service === undefined || service === null) {
    return
  }
  void service
    .handleAuthCallback(rawUrl)
    .then((status) => {
      broadcastAccountStatus(status)
    })
    .catch(() => {
      // Safe log: outcome category only, never the URL or code.
      if (!app.isPackaged) {
        console.log('[STARK] account callback rejected')
      }
      const fallback = service.getStatus()
      broadcastAccountStatus(fallback)
    })
}

function handleSecondInstanceArgv(argv: readonly string[]): void {
  const deepLink = extractDeepLinkFromArgv(argv)
  if (deepLink !== null) {
    handleAuthDeepLink(deepLink)
  }
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    try {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.focus()
    } catch {
      // Best effort focus during callback handling.
    }
  } else {
    createMainWindow()
  }
}

function shutdownTerminals(): void {
  try {
    terminalManager?.shutdownAll()
  } catch {
    // Best effort during quit; shutdown must stay bounded.
  } finally {
    terminalManager = null
  }
}

function createMainWindow(): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    return
  }

  mainWindow = createAppWindow()
  const ownerId = mainWindow.webContents.id
  mainWindow.webContents.on('destroyed', () => {
    try {
      terminalManager?.handleWebContentsDestroyed(ownerId)
    } catch {
      // Best effort during teardown.
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Opens the local database and runs pending migrations. The main window
 * is only created after this succeeds. Returns false when startup must
 * abort instead of continuing partially initialized.
 */
function initializePersistence(): boolean {
  try {
    const dbFile = resolveDatabaseFile(app.isPackaged, app.getPath('userData'))
    starkDatabase.initialize(dbFile)
    if (!app.isPackaged) {
      console.log(`[STARK] Database ready (schema v${starkDatabase.getSchemaVersion()})`)
    }
    return true
  } catch (error) {
    console.error(
      `[STARK] Database initialization failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}

/**
 * TEMPORARY Stage 14C diagnostic — remove after root cause is
 * identified. Dev-only: proves the RUNNING main bundle (not just
 * source) constructs the OpenAI client with the 14B explicit
 * endpoint/org/project/retry configuration, using a dummy key that
 * never touches the network. Secret-free output only; failures are
 * swallowed so startup can never break on diagnostics.
 */
function printTemporaryAiBuildDiag(): void {
  if (app.isPackaged) {
    return
  }
  try {
    setStarkAiDiagEnabled(true)
    const client = createOpenAiClient('diag-unused-dummy-key') as unknown as Record<string, unknown>
    let origin = 'unknown'
    try {
      origin = new URL(String(client['baseURL'])).origin
    } catch {
      // Keep 'unknown' — that itself is diagnostic signal.
    }
    console.log(
      '[STARK AI DIAG] ' +
        `adapterConfigVersion=14B baseUrlOrigin=${origin === 'https://api.openai.com' ? 'api.openai.com' : 'unexpected'} ` +
        `organizationConfigured=${String(client['organization'] !== null && client['organization'] !== undefined)} ` +
        `projectConfigured=${String(client['project'] !== null && client['project'] !== undefined)} ` +
        `maxRetries=${String(client['maxRetries'])}`
    )
  } catch {
    // Diagnostics must never break startup.
  }
}

void app.whenReady().then(() => {
  // Release smoke mode (test packaging only): isolated userdata,
  // full migrations, one bounded ready marker, clean quit. No
  // security bypass, no providers, no OAuth, no runtimes.
  const smokeConfig = parseSmokeConfig()
  if (smokeConfig !== null) {
    try {
      app.setPath('userData', smokeConfig.userDataDir)
    } catch {
      // Best effort: the isolated DB path below still applies.
    }
    try {
      starkDatabase.initialize(smokeDatabaseFile(smokeConfig.userDataDir))
      const schemaVersion = starkDatabase.getSchemaVersion()
      starkDatabase.close()
      writeSmokeMarker(smokeConfig.markerPath, { ok: true, schemaVersion, appVersion: app.getVersion() })
    } catch (error) {
      logFatalDiagnostic('smoke', error instanceof Error ? error.message : String(error))
      try {
        starkDatabase.close()
      } catch {
        // Best effort.
      }
      try {
        writeSmokeMarker(smokeConfig.markerPath, { ok: false, schemaVersion: 0, appVersion: app.getVersion() })
      } catch {
        // Best effort marker.
      }
    }
    app.quit()
    return
  }
  applyContentSecurityPolicy()
  try {
    app.setAsDefaultProtocolClient('stark')
  } catch {
    // Best effort: protocol registration must never block startup.
  }
  if (!initializePersistence()) {
    fatalPresenter.presentFatal('local-data')
    return
  }
  // Extension-install crash safety: drop only STARK-owned stale
  // staging/temp names under <userData>/extensions (bounded, never
  // throws). Nothing is installed or executed at startup.
  try {
    cleanupStaleInstallStaging(app.getPath('userData'))
  } catch {
    // Best effort: startup must never break on staging cleanup.
  }
  // Services are constructed from initialized infrastructure first, then
  // handed explicitly to the IPC layer — no database-backed handler
  // exists before its dependencies do.
  const services = createServices({
    keyValue: starkDatabase.getKeyValue(),
    workspaces: starkDatabase.getWorkspaces(),
    changeTransactions: starkDatabase.getChangeTransactions(),
    changeSets: starkDatabase.getChangeSets(),
    orchestrationRuns: starkDatabase.getOrchestrationRuns(),
    heartStore: starkDatabase.getHeart(),
    looplinkStore: starkDatabase.getLooplink(),
    recoveryStore: starkDatabase.getRecovery(),
    capabilityStore: starkDatabase.getCapabilities(),
    workerToolStore: starkDatabase.getWorkerTools(),
    workerCommandStore: starkDatabase.getWorkerCommands(),
    runtimeStore: starkDatabase.getProjectRuntimes(),
    usageStore: starkDatabase.getUsage(),
    cloudAccountStore: starkDatabase.getCloudAccount(),
    codingSessions: starkDatabase.getCodingSessions(),
    aiProviders: starkDatabase.getAiProviders(),
    attachmentStoreRoot: join(app.getPath('userData'), 'attachments')
  })
  accountServices = services
  // Bounded startup recovery, once, in explicit order: leftover
  // running orchestration/recovery rows, launching/running Worker
  // commands (parked runs fail with safe copy), managed runtimes,
  // and usage telemetry become interrupted. No resume, no
  // continuation, no provider calls, no retries.
  runStartupRecoveryPasses(
    {
      markOrchestrationRunningInterrupted: (now) => {
        starkDatabase.getOrchestrationRuns().markRunningAsInterrupted(now)
      },
      markRecoveryRunningInterrupted: (now) => {
        starkDatabase.getRecovery().markRunningAsInterrupted(now)
      },
      markWorkerCommandsInterrupted: (now) => starkDatabase.getWorkerCommands().markLaunchingAndRunningAsInterrupted(now),
      failParkedRuns: (runIds, now) => {
        for (const runId of runIds) {
          try {
            const run = starkDatabase.getOrchestrationRuns().findRunById(runId)
            if (run !== undefined && run.status === 'waiting_for_approval') {
              starkDatabase.getOrchestrationRuns().updateRunState({
                id: runId,
                status: 'failed',
                action: run.action,
                planSummary: run.planSummary,
                finalMessageId: run.finalMessageId,
                errorCategory: 'An approved Worker command was interrupted. Start the Work request again.',
                now
              })
            }
          } catch {
            // Best effort per run.
          }
        }
      },
      recoverProjectRuntimes: (now) => {
        services.projectRuntimeService?.recoverAtStartup(now)
      },
      cleanupUsage: (now) => {
        services.usageService?.startupCleanup(now)
      }
    },
    Date.now()
  )
  // Live runtime updates fan out to every open STARK renderer. Only
  // trusted senders can invoke runtime IPC, and payloads are bounded
  // renderer-safe summaries (no PID, env, or paths). Dropped once
  // shutdown begins so late events never write after DB close.
  services.projectRuntimeService?.setUpdatedListener((event: ProjectRuntimeUpdatedEvent) => {
    shutdownGuard.runIfActive(() => {
      for (const window of BrowserWindow.getAllWindows()) {
        try {
          if (!window.isDestroyed()) {
            window.webContents.send(IPC_CHANNELS.runtimeUpdated, event)
          }
        } catch {
          // Best effort streaming: a destroyed renderer stops receiving.
        }
      }
    })
  })
  terminalManager = new TerminalManager(createNodePtyFactory(), createTerminalEventSink())
  // Extension Host foundation: isolated utility process running
  // STARK-owned bootstrap only. Never autostarted; the renderer may
  // start/stop it explicitly through narrow IPC. No extension code
  // is ever loaded here.
  //
  // Artifact guarantee (corrective pass): the fork path below must
  // exist BEFORE any activation attempt. A missing bootstrap
  // previously surfaced as a bare `host-unavailable` with stderr
  // suppressed — in dev the artifacts self-heal here from the
  // audited source tree (app-path-derived, never hardcoded); in
  // packaged builds a missing artifact logs an actionable main-side
  // error (the build copy step owns delivery there).
  if (!extensionHostArtifactsComplete(__dirname)) {
    if (!app.isPackaged) {
      try {
        const copied = ensureExtensionHostArtifacts(__dirname, devExtensionHostSourceDir(app.getAppPath()))
        if (copied.length > 0 && !app.isPackaged) {
          console.log(`[STARK] extension host artifacts restored: ${copied.join(', ')}`)
        }
      } catch (error: unknown) {
        console.error(
          `[STARK] extension host artifacts are missing and could not be restored: ${missingExtensionHostArtifacts(__dirname).join(', ')}`
        )
        void error
      }
    } else {
      console.error(
        `[STARK] extension host artifacts are missing from the package: ${missingExtensionHostArtifacts(__dirname).join(', ')}`
      )
    }
  }
  const extensionHostLauncher: ExtensionHostLauncher = {
    fork: (modulePath, options) => utilityProcess.fork(modulePath, [], options)
  }
  const extensionHostManager = new ExtensionHostManager({
    bootstrapPath: join(__dirname, 'extension-host-bootstrap.js'),
    userDataDir: app.getPath('userData'),
    launcher: extensionHostLauncher,
    onLog: (message: string) => {
      if (!app.isPackaged) {
        console.log(`[STARK] ${message}`)
      }
    }
  })
  shutdownRuntimes = () => {
    try {
      void services.projectRuntimeService?.shutdownAll(Date.now())
    } catch {
      // Best effort during quit.
    }
  }
  // Document formatter (Prettier pilot): allowlisted extension code
  // executes ONLY inside the Extension Host, on explicit user Format
  // actions. The install service below is the single instance shared
  // with install/uninstall/setEnabled IPC so enabled state is one
  // source of truth. Disabling or uninstalling unloads the formatter
  // best-effort (future formats re-check state regardless).
  const extensionInstallService = new ExtensionInstallService(
    join(app.getPath('userData'), EXTENSION_INSTALL_DIR_NAME),
    undefined,
    services.extensionIconService
  )
  // Generic activation core (demand-driven only, never at startup):
  // any installed + enabled extension with a verified `main`
  // entrypoint may activate inside the isolated host. Prettier uses
  // the same pipeline (no allowlist).
  const extensionActivationService = new ExtensionActivationService({
    manager: extensionHostManager,
    installService: extensionInstallService,
    installRoot: join(app.getPath('userData'), EXTENSION_INSTALL_DIR_NAME)
  })
  // Generic runtime coordinator (trust, triggers, providers, prompts,
  // diagnostics, proposals, updates). Workspace file access is
  // root-contained and read-only; catalog versions feed manual update
  // checks (offline-safe). Events fan out to renderers above.
  const extensionWorkspaceFiles = createWorkspaceFileAccess({
    workspaceRootProvider: () => {
      try {
        return starkDatabase.getWorkspaces().getMostRecentlyOpened()?.rootPath ?? null
      } catch {
        return null
      }
    }
  })
  const extensionRuntimeService = new ExtensionRuntimeService({
    manager: extensionHostManager,
    activationService: extensionActivationService,
    installService: extensionInstallService,
    installRoot: join(app.getPath('userData'), EXTENSION_INSTALL_DIR_NAME),
    workspaceFiles: extensionWorkspaceFiles,
    workspaceRootProvider: () => {
      try {
        return starkDatabase.getWorkspaces().getMostRecentlyOpened()?.rootPath ?? null
      } catch {
        return null
      }
    },
    catalogVersions: {
      latestVersion: ({ namespace, name }: { namespace: string; name: string }): Promise<string | null> => {
        const registry = services.extensionRegistryService
        if (registry === undefined) {
          return Promise.resolve(null)
        }
        return registry.latestVersion(namespace, name)
      }
    }
  })
  extensionRuntimeService.setPromptListener((prompt) => {
    broadcastExtensionEvent({ kind: 'prompt', payload: { ...(prompt as unknown as Record<string, unknown>) } })
  })
  extensionRuntimeService.setEventListener((event) => {
    broadcastExtensionEvent(event)
  })
  const formatterService = new FormatterService({
    manager: extensionHostManager,
    installService: extensionInstallService,
    filesService: services.workspaceFilesService,
    workspaces: starkDatabase.getWorkspaces(),
    formatterModuleUrl: pathToFileURL(join(__dirname, 'formatter-host.mjs')).href,
    activationService: extensionActivationService
  })
  registerIpcHandlers({    settingsService: services.settingsService,
    profileService: services.profileService,
    workspaceService: services.workspaceService,
    workspaceFilesService: services.workspaceFilesService,
    workspaceFileWriteService: services.workspaceFileWriteService,
    workspaceSearchService: services.workspaceSearchService,
    extensionRegistryService: services.extensionRegistryService,
    extensionInstallService,
    extensionHostManager,
    extensionActivationService,
    extensionRuntimeService,
    formatterService,
    attachmentService: services.chatAttachmentService,
    attachmentPicker: electronAttachmentPicker,
    voiceTranscriptionService: services.voiceTranscriptionService,
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
    recoveryCoordinator: services.recoveryCoordinator,
    capabilityService: services.capabilityService,
    workerToolRunner: services.workerToolRunner,
    projectRuntimeService: services.projectRuntimeService,
    usageService: services.usageService,
    cloudAccountService: services.cloudAccountService,
    workspaces: starkDatabase.getWorkspaces(),
    codingSessions: starkDatabase.getCodingSessions()
  })
  // STARK account status fans out to every open renderer. Payloads are
  // trusted safe statuses only (no tokens) via the preload validator.
  services.cloudAccountService?.setEmitter(broadcastAccountStatus)
  // Attachment bytes serve by opaque ID only: the handler resolves
  // through the attachment store, so URL pathnames never reach the
  // filesystem. Unknown IDs answer 404 with no detail.
  if (services.chatAttachmentService !== undefined) {
    const attachmentService = services.chatAttachmentService
    protocol.handle(ATTACHMENT_PROTOCOL, (request) => serveAttachmentRequest(request.url, (id) => attachmentService.readAttachmentContent(id)))
  }
  // Extension-icon bytes serve by opaque ID only: the handler resolves
  // through the icon service cache populated during catalog loads, so
  // icon URLs never reach the filesystem and unknown IDs answer 404
  // with no detail. Icons only — never a generic remote-image proxy.
  {
    const iconService = services.extensionIconService
    protocol.handle(EXTENSION_ICON_PROTOCOL, (request) =>
      serveExtensionIconRequest(request.url, (id) => iconService.readIconContent(id))
    )
  }
  printTemporaryAiBuildDiag()
  createMainWindow()
  // STARK startup never blocks on authentication: the window is already
  // created above; the single bounded session restore runs detached and
  // broadcasts its safe outcome when done. Offline, unconfigured, or
  // corrupt sessions all degrade to local use.
  if (services.cloudAccountService !== undefined) {
    const accountService = services.cloudAccountService
    void accountService.restoreAtStartup().then(
      (status) => {
        broadcastAccountStatus(status)
      },
      () => {
        // Restore failures are already safe statuses; stay local.
      }
    )
    // Windows/Linux protocol launch: the OS may have started STARK
    // with a stark://auth/callback argument.
    const initialDeepLink = extractDeepLinkFromArgv(process.argv)
    if (initialDeepLink !== null) {
      handleAuthDeepLink(initialDeepLink)
    }
  }

  // Standard macOS behavior: re-create the window when the dock icon is
  // clicked and no windows are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

// Single-instance lock: a second protocol launch forwards its exact
// callback to the primary instance and exits — no duplicate windows,
// no independent auth handling. Release smoke mode uses isolated
// userdata and must never quit over a held lock.
const singleInstanceLock = (() => {
  try {
    return app.requestSingleInstanceLock()
  } catch {
    return true
  }
})()
const smokeBypassesLock = parseSmokeConfig() !== null
if (!singleInstanceLock && !smokeBypassesLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    try {
      handleSecondInstanceArgv(argv)
    } catch {
      // Callback forwarding must never crash the primary instance.
    }
  })
  // macOS protocol callback.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    try {
      handleAuthDeepLink(url)
    } catch {
      // Callback handling must never crash the primary instance.
    }
  })
}
// Quit on Windows/Linux when every window closes; stay alive on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Close the SQLite connection cleanly during shutdown. Ordered and
// bounded (MAX_APP_SHUTDOWN_MS): Preview/inspection surfaces first,
// then exact runtime trees with persisted final state, then human
// terminals, then the database — so quit never waits indefinitely and
// late child events never write after DB close. Idempotent.
app.on('before-quit', () => {
  const report = performOrderedShutdown([
    {
      id: 'stop-accepting-work',
      run: () => {
        shutdownGuard.beginShutdown()
      }
    },
    {
      id: 'close-preview-surfaces',
      run: () => {
        for (const window of BrowserWindow.getAllWindows()) {
          try {
            if (window !== mainWindow && !window.isDestroyed()) {
              window.destroy()
            }
          } catch {
            // Best effort during quit.
          }
        }
      }
    },
    {
      id: 'stop-runtime-trees',
      run: () => {
        try {
          shutdownRuntimes?.()
        } catch {
          // Best effort during quit.
        } finally {
          shutdownRuntimes = null
        }
      }
    },
    {
      id: 'terminate-terminals',
      run: () => {
        shutdownTerminals()
      }
    },
    {
      id: 'flush-runtime-state',
      run: () => {
        // Runtime shutdown above already persists final session state
        // to SQLite; this step records the flush point in order.
      }
    },
    {
      id: 'close-database',
      run: () => {
        starkDatabase.close()
      }
    },
    {
      id: 'exit',
      run: () => {
        // Exit proceeds via Electron after before-quit returns.
      }
    }
  ])
  if (!app.isPackaged && report.deadlineExceeded) {
    console.warn('[STARK] shutdown exceeded the global deadline; finishing best-effort')
  }
})
