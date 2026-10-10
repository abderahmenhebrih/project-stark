import type { FormatDocumentResult } from '../../../shared/formatter/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the document-formatter domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getFormatterApi(): import('../../../shared/formatter/types').FormatterApi | undefined {
  return getStarkApi()?.formatter
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('Document formatting is unavailable.'))
}

/**
 * Typed document-format caller (Prettier pilot).
 *
 * Sends workspace identity plus the relative path only; main reads
 * the snapshot, formats inside the Extension Host, and returns
 * revision plus formatted text. The caller must propose (never
 * write) through change transactions.
 */
export function formatDocumentWithPrettier(
  workspaceId: number,
  relativePath: string
): Promise<FormatDocumentResult> {
  const api = getFormatterApi()?.formatDocument
  if (api === undefined) {
    return unavailable()
  }
  return api({ workspaceId, relativePath })
}
