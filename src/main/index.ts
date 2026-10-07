import { app, BrowserWindow } from 'electron'
import { createServices } from './application/create-services'
import { StarkDatabase } from './database/database'
import { resolveDatabaseFile } from './database/paths'
import { registerIpcHandlers } from './ipc'
import { applyContentSecurityPolicy } from './security/session'
import { createAppWindow } from './windows/app-window'

let mainWindow: BrowserWindow | null = null

/**
 * The single database owner for the STARK process. Created here and
 * nowhere else; repositories hang off this instance.
 */
const starkDatabase = new StarkDatabase()

function createMainWindow(): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    return
  }

  mainWindow = createAppWindow()
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
    changeTransactions: starkDatabase.getChangeTransactions()
  })
  registerIpcHandlers({
    settingsService: services.settingsService,
    profileService: services.profileService,
    workspaceService: services.workspaceService,
    workspaceFilesService: services.workspaceFilesService,
    workspaceFileWriteService: services.workspaceFileWriteService,
    workspaceSearchService: services.workspaceSearchService,
    changeTransactionService: services.changeTransactionService
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
app.on('before-quit', () => {
  starkDatabase.close()
})
