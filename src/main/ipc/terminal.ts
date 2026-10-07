import { webContents } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { TerminalDataEvent, TerminalExitEvent } from '../../shared/terminal/types'
import { toPublicTerminalError } from '../terminal/errors'
import { buildTerminalEnv } from '../terminal/terminal-environment'
import { TerminalManager } from '../terminal/terminal-manager'
import { TerminalService } from '../terminal/terminal-service'
import { selectShell } from '../terminal/shell-policy'
import type { IpcBinding } from './binding'

async function withPublicTerminalError<T>(operation: 'create' | 'write' | 'resize' | 'kill', run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toPublicTerminalError(operation, error)
  }
}

function sendToOwner(ownerWebContentsId: number, channel: string, payload: unknown): void {
  const contents = webContents.fromId(ownerWebContentsId)
  if (contents === undefined || contents.isDestroyed()) {
    return
  }
  try {
    contents.send(channel, payload)
  } catch {
    // Best effort streaming: a destroyed renderer simply stops receiving.
  }
}

/**
 * Creates the terminal event sink that routes PTY output/exit ONLY to
 * the owning WebContents. No broadcasting, no cross-session subscribe.
 */
export function createTerminalEventSink(): {
  sendData: (ownerWebContentsId: number, event: TerminalDataEvent) => void
  sendExit: (ownerWebContentsId: number, event: TerminalExitEvent) => void
} {
  return {
    sendData: (ownerWebContentsId, event) => {
      sendToOwner(ownerWebContentsId, IPC_CHANNELS.terminalData, event)
    },
    sendExit: (ownerWebContentsId, event) => {
      sendToOwner(ownerWebContentsId, IPC_CHANNELS.terminalExit, event)
    }
  }
}

/**
 * Terminal IPC bindings: exactly four invoke channels (create/write/
 * resize/kill). No shell/executable/cwd/env choice, no generic
 * spawn/exec, no child_process surface. Ownership derives from the
 * validated invoke sender; every operation verifies it in the manager.
 * Fixed data/exit event channels flow main → owner renderer only.
 */
export function createTerminalBindings(
  service: TerminalService,
  manager: TerminalManager
): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.terminalCreate,
      invoke: (payload, event) =>
        withPublicTerminalError('create', async () => {
          if (event === undefined || event.sender.isDestroyed()) {
            throw toPublicTerminalError('create', new Error('untrusted sender'))
          }
          const ownerWebContentsId = event.sender.id
          const request = service.validateCreateRequest(payload)
          const cwd = await service.resolveWorkspaceCwd(request.workspaceId)
          const shell = selectShell(process.platform)
          const env = buildTerminalEnv()
          return manager.createSessionWithEnv({
            ownerWebContentsId,
            workspaceId: request.workspaceId,
            cwd,
            shellFile: shell.file,
            shellArgs: shell.args,
            shellLabel: shell.label,
            cols: request.cols,
            rows: request.rows,
            env
          })
        })
    },
    {
      channel: IPC_CHANNELS.terminalWrite,
      invoke: (payload, event) =>
        withPublicTerminalError('write', async () => {
          if (event === undefined || event.sender.isDestroyed()) {
            throw toPublicTerminalError('write', new Error('untrusted sender'))
          }
          const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
          manager.writeSession(event.sender.id, record['sessionId'], record['data'])
        })
    },
    {
      channel: IPC_CHANNELS.terminalResize,
      invoke: (payload, event) =>
        withPublicTerminalError('resize', async () => {
          if (event === undefined || event.sender.isDestroyed()) {
            throw toPublicTerminalError('resize', new Error('untrusted sender'))
          }
          const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
          manager.resizeSession(event.sender.id, record['sessionId'], record['cols'], record['rows'])
        })
    },
    {
      channel: IPC_CHANNELS.terminalKill,
      invoke: (payload, event) =>
        withPublicTerminalError('kill', async () => {
          if (event === undefined || event.sender.isDestroyed()) {
            throw toPublicTerminalError('kill', new Error('untrusted sender'))
          }
          const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
          manager.killSession(event.sender.id, record['sessionId'])
        })
    }
  ]
}
