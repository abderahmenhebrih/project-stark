import { shell } from 'electron'

/**
 * Moves one absolute target to the OS Trash/Recycle Bin via Electron.
 * Production Trash function for WorkspaceCrudService. Never falls back
 * to permanent deletion: when the shell bridge is unavailable (plain
 * Node harnesses) or the OS refuses, this rejects and the caller
 * surfaces safe copy with nothing deleted.
 */
export async function trashToSystem(absolutePath: string): Promise<void> {
  const bridge = shell as unknown as { trashItem?: (path: string) => Promise<void> } | undefined
  if (bridge === undefined || typeof bridge.trashItem !== 'function') {
    throw new Error('system trash is unavailable')
  }
  await bridge.trashItem(absolutePath)
}
