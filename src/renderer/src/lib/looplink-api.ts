import type {
  CreateLooplinkRequest,
  CreateLooplinkResult,
  LooplinkApi,
  LooplinkForSessionRequest,
  LooplinkPreview
} from '../../../shared/looplink/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the Looplink domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getLooplinkApi(): LooplinkApi | undefined {
  return getStarkApi()?.looplink
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('We couldn’t prepare this continuity.'))
}

/**
 * Typed Looplink callers. Components use these helpers instead of
 * reaching the bridge object directly. Creating continuity sends no
 * message and starts no AI work — it only prepares the handoff.
 */
export function createSessionContinuation(request: CreateLooplinkRequest): Promise<CreateLooplinkResult> {
  const api = getLooplinkApi()?.createContinuation
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function getSessionLooplink(request: LooplinkForSessionRequest): Promise<LooplinkPreview | null> {
  const api = getLooplinkApi()?.getForSession
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function dismissSessionLooplink(request: LooplinkForSessionRequest): Promise<LooplinkPreview> {
  const api = getLooplinkApi()?.dismiss
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t dismiss this continuity.'))
  }
  return api(request)
}
