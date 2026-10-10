import { BrowserWindow, dialog } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { ChatAttachmentError } from './errors'

/**
 * Native file-picker boundary.
 *
 * Only this module (plus its tests) touches Electron's file dialog.
 * The renderer never sends paths and never calls dialog: it invokes
 * the fixed choose channel, the main process opens the OS picker as
 * the already-validated sender's window with multi-selection, and the
 * picked paths flow into ChatAttachmentService for validation. The
 * dialog offers images and documents first but always allows every
 * file kind; enforcement lives main-side. Cancellation resolves to
 * undefined — never an error, never attachments.
 */
export interface AttachmentPicker {
  pickFiles(parentWindow: BrowserWindow | undefined): Promise<string[] | undefined>
}

/** Exact native dialog configuration. Pure — unit-tested as data. */
export function buildAttachmentDialogOptions(): {
  readonly title: string
  readonly buttonLabel: string
  readonly properties: readonly ['openFile', 'multiSelections']
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[]
} {
  return {
    title: 'Attach files',
    buttonLabel: 'Attach',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      { name: 'Documents', extensions: ['pdf', 'md', 'markdown', 'txt', 'json'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
}

/** Production picker: multi-file OS dialog, cancellation-safe. */
export const electronAttachmentPicker: AttachmentPicker = {
  async pickFiles(parentWindow: BrowserWindow | undefined): Promise<string[] | undefined> {
    const options = buildAttachmentDialogOptions()
    let result: { canceled: boolean; filePaths: string[] }
    try {
      const shaped = {
        title: options.title,
        buttonLabel: options.buttonLabel,
        properties: [...options.properties],
        filters: options.filters.map((entry) => ({ name: entry.name, extensions: [...entry.extensions] }))
      }
      result =
        parentWindow === undefined
          ? await dialog.showOpenDialog(shaped)
          : await dialog.showOpenDialog(parentWindow, shaped)
    } catch (error) {
      console.warn(`[STARK] native attachment picker failed: ${error instanceof Error ? error.message : String(error)}`)
      throw new ChatAttachmentError('File picker failed.')
    }
    if (result.canceled || result.filePaths.length === 0) {
      return undefined
    }
    return result.filePaths.filter((entry) => typeof entry === 'string' && entry !== '')
  }
}

/** Resolves the validated sender window for modal dialogs, if any. */
export function senderWindow(event: IpcMainInvokeEvent | undefined): BrowserWindow | undefined {
  if (event === undefined) {
    return undefined
  }
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}
