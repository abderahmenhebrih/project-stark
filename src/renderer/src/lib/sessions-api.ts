import type {
  CodingMessagePage,
  CodingSession,
  ListSessionMessagesRequest,
  SendUserMessageRequest,
  SendUserMessageResult,
  SessionsApi
} from '../../../shared/sessions/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the coding-session domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getSessionsApi(): SessionsApi | undefined {
  return getStarkApi()?.sessions
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('Coding sessions are unavailable.'))
}

/**
 * Typed coding-session callers.
 *
 * One explicit action at a time — no direct `window.stark.sessions`
 * access in components, mirroring the existing changes/search helpers.
 * No polling here: callers fetch explicitly (panel open, New, select,
 * Refresh-equivalent loads, send).
 */
export function createCodingSession(workspaceId: number): Promise<CodingSession> {
  const api = getSessionsApi()?.create
  if (api === undefined) {
    return unavailable()
  }
  return api(workspaceId)
}

export function listCodingSessions(workspaceId: number): Promise<readonly CodingSession[]> {
  const api = getSessionsApi()?.list
  if (api === undefined) {
    return unavailable()
  }
  return api(workspaceId)
}

export function listSessionMessages(request: ListSessionMessagesRequest): Promise<CodingMessagePage> {
  const api = getSessionsApi()?.listMessages
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function sendSessionUserMessage(request: SendUserMessageRequest): Promise<SendUserMessageResult> {
  const api = getSessionsApi()?.sendUserMessage
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}
