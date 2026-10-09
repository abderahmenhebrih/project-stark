import type { WorkspaceSlice } from '../../app/app-context'
import { confirmDiscardUnsavedDraft } from '../explorer/editor-guard'
import {
  closeActiveTerminalForSwitch,
  confirmCloseTerminalAndSwitch,
  hasActiveTerminal
} from '../terminal/terminal-guard'

/**
 * Shared guarded workspace-switch flows (single implementation for the
 * AppChrome project button, the drawer overflow menu, and the welcome
 * surface). Switching consults the editor discard guard and the
 * terminal switch guard first: a declined confirmation keeps the
 * current workspace (and its dirty draft / running terminal) in place.
 * An accepted terminal prompt kills the session with bounded cleanup
 * before switching; nothing is ever re-created automatically. No
 * duplicate workspace state, no new persistence.
 */
export async function chooseWorkspaceWithGuards(workspace: WorkspaceSlice): Promise<void> {
  if (!confirmDiscardUnsavedDraft()) {
    return
  }
  if (hasActiveTerminal() && !confirmCloseTerminalAndSwitch()) {
    return
  }
  await closeActiveTerminalForSwitch()
  await workspace.chooseWorkspace()
}

/** Guarded switch to a recent workspace by id (same guards as above). */
export async function openWorkspaceWithGuards(workspace: WorkspaceSlice, workspaceId: number): Promise<void> {
  if (!confirmDiscardUnsavedDraft()) {
    return
  }
  if (hasActiveTerminal() && !confirmCloseTerminalAndSwitch()) {
    return
  }
  await closeActiveTerminalForSwitch()
  await workspace.openWorkspace(workspaceId)
}
