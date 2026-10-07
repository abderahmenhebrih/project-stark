import { app, BrowserWindow } from 'electron'
import { createServices } from './application/create-services'
import { StarkDatabase } from './database/database'
import { resolveDatabaseFile } from './database/paths'
import { registerIpcHandlers } from './ipc'
import { createTerminalEventSink } from './ipc/terminal'
import { applyContentSecurityPolicy } from './security/session'
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

void app.whenReady().then(() => {
  applyContentSecurityPolicy()
  if (!initializePersistence()) {
    app.quit()
    return
  }
  // Services are constructed from initialized infrastructure first, then
  // handed explicitly to the IPC layer — no database-backed handler
  // exists before its dependencies do.
  const services = createServices({
    keyValue: starkDatabase.getKeyValue(),
    workspaces: starkDatabase.getWorkspaces(),
    changeTransactions: starkDatabase.getChangeTransactions(),
    codingSessions: starkDatabase.getCodingSessions(),
    aiProviders: starkDatabase.getAiProviders()
  })
  terminalManager = new TerminalManager(createNodePtyFactory(), createTerminalEventSink())
  registerIpcHandlers({
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
    aiProviderService: services.aiProviderService,
    aiCompletionService: services.aiCompletionService
  })
  createMainWindow()

  // Standard macOS behavior: re-create the window when the dock icon is
  // clicked and no windows are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})
// Quit on Windows/Linux when every window closes; stay alive on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Close the SQLite connection cleanly during shutdown. Idempotent.
// Terminals are terminated first with bounded cleanup so quit never
// waits indefinitely on a shell process.
app.on('before-quit', () => {
  shutdownTerminals()
  starkDatabase.close()
})
