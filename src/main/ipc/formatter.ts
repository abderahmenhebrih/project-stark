import { IPC_CHANNELS } from '../../shared/constants'
import type { FormatDocumentResult } from '../../shared/formatter/types'
import { InvalidFormatterRequestError, toPublicFormatterError } from '../formatter/errors'
import type { FormatterService } from '../formatter/formatter-service'
import type { IpcBinding } from './binding'

function readFormatRequest(payload: unknown): { workspaceId: number; relativePath: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new InvalidFormatterRequestError()
  }
  const keys = Object.keys(payload)
  if (keys.length !== 2 || !keys.includes('workspaceId') || !keys.includes('relativePath')) {
    throw new InvalidFormatterRequestError()
  }
  return payload as { workspaceId: number; relativePath: string }
}

/**
 * Document-formatter IPC bindings (Prettier pilot): exactly one
 * invoke channel (format-document). The renderer supplies workspace
 * identity plus a relative path only — text, revisions, absolute
 * paths, and extension paths are all main-derived. The response
 * carries the snapshot revision plus formatted text; the renderer
 * must propose (never write) through change transactions. No generic
 * extension execution surface. Registration through handleSecureIpc
 * happens in ./index.ts.
 */
export function createFormatterBindings(service: FormatterService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.formatterFormatDocument,
      invoke: (payload): Promise<FormatDocumentResult> =>
        Promise.resolve()
          .then(() => readFormatRequest(payload))
          .then((request) => service.formatDocument(request))
          .catch((error: unknown) => {
            throw toPublicFormatterError(error)
          })
    }
  ]
}
