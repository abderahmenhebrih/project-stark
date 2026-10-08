import type {
  PrepareFileExcerptRequest,
  PrepareManualNoteRequest,
  PrepareSearchMatchRequest,
  PrepareWholeFileRequest,
  SessionContextApi,
  SessionContextDraft
} from '../../../shared/context/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the explicit project-context domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getSessionContextApi(): SessionContextApi | undefined {
  return getStarkApi()?.sessionContext
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('We couldn’t attach this context.'))
}

/**
 * Typed project-context prepare callers.
 *
 * Each call performs exactly one bounded main-process read (or none
 * for manual notes) and returns a preview draft. Components use these
 * helpers instead of reaching the bridge object directly, mirroring
 * the existing session/search helpers.
 */
export function prepareContextExcerpt(request: PrepareFileExcerptRequest): Promise<SessionContextDraft> {
  const api = getSessionContextApi()?.prepareExcerpt
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function prepareContextFile(request: PrepareWholeFileRequest): Promise<SessionContextDraft> {
  const api = getSessionContextApi()?.prepareFile
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function prepareContextSearchMatch(request: PrepareSearchMatchRequest): Promise<SessionContextDraft> {
  const api = getSessionContextApi()?.prepareSearchMatch
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function prepareContextNote(request: PrepareManualNoteRequest): Promise<SessionContextDraft> {
  const api = getSessionContextApi()?.prepareNote
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}
