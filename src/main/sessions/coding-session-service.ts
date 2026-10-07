import type {
  CodingMessage,
  CodingMessagePage,
  CodingSession,
  SendUserMessageResult
} from '../../shared/sessions/types'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { InvalidSessionRequestError, SessionNotFoundError, SessionWorkspaceMismatchError, SessionWorkspaceUnavailableError } from './errors'
import { NEW_SESSION_TITLE, MAX_MESSAGE_PAGE_SIZE, MAX_RECENT_SESSIONS } from './limits'
import { validateUserMessageContent } from './message-validation'
import { deriveSessionTitle } from './session-title'

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function hasStrictShape(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return false
    }
  }
  return true
}

export interface CodingSessionServiceOptions {
  /** Clock override for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number
}

/**
 * Coding-session domain service (Stage 13): the only main-process
 * gateway to persisted sessions and messages. Owns workspace
 * authority, request validation, message validation, deterministic
 * title derivation, and bounded pagination. SQL stays in the
 * repository; no renderer, network, provider, or AI concerns here.
 *
 * The renderer can create USER messages only: the role is forced to
 * 'user' in code, and no assistant-writing method exists on this class.
 */
export class CodingSessionService {
  private readonly now: () => number

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly sessions: CodingSessionRepository,
    options?: CodingSessionServiceOptions
  ) {
    this.now = options?.now ?? Date.now
  }

  private requireWorkspace(workspaceId: number): void {
    if (this.workspaces.findById(workspaceId) === undefined) {
      throw new SessionWorkspaceUnavailableError()
    }
  }

  private toPublicSession(stored: {
    readonly id: number
    readonly workspaceId: number
    readonly title: string
    readonly createdAt: number
    readonly updatedAt: number
  }): CodingSession {
    return {
      id: stored.id,
      workspaceId: stored.workspaceId,
      title: stored.title,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt
    }
  }

  private toPublicMessage(stored: {
    readonly id: number
    readonly sessionId: number
    readonly role: 'user' | 'assistant'
    readonly content: string
    readonly createdAt: number
  }): CodingMessage {
    return {
      id: stored.id,
      sessionId: stored.sessionId,
      role: stored.role,
      content: stored.content,
      createdAt: stored.createdAt
    }
  }

  /**
   * Creates a session titled 'New session' for a persisted workspace.
   * No initial assistant message, no AI.
   */
  async createSession(payload: unknown): Promise<CodingSession> {
    if (!hasStrictShape(payload, ['workspaceId'])) {
      throw new InvalidSessionRequestError('session creation request is invalid')
    }
    const { workspaceId } = payload
    if (!isValidId(workspaceId)) {
      throw new InvalidSessionRequestError('workspace reference is invalid')
    }
    this.requireWorkspace(workspaceId)
    const now = this.now()
    const id = this.sessions.createSession({ workspaceId, title: NEW_SESSION_TITLE, now })
    const stored = this.sessions.findSessionById(id)
    if (stored === undefined) {
      throw new SessionNotFoundError()
    }
    return this.toPublicSession(stored)
  }

  /**
   * Recent sessions for one workspace, newest-first, capped at
   * MAX_RECENT_SESSIONS. Never returns other workspaces' sessions.
   */
  async listSessions(payload: unknown): Promise<readonly CodingSession[]> {
    if (!hasStrictShape(payload, ['workspaceId'])) {
      throw new InvalidSessionRequestError('session list request is invalid')
    }
    const { workspaceId } = payload
    if (!isValidId(workspaceId)) {
      throw new InvalidSessionRequestError('workspace reference is invalid')
    }
    this.requireWorkspace(workspaceId)
    return this.sessions.listRecentSessions(workspaceId, MAX_RECENT_SESSIONS).map((stored) => this.toPublicSession(stored))
  }

  /**
   * One bounded message page for a workspace-owned session, returned
   * oldest-first. Latest page when `beforeMessageId` is omitted.
   */
  async listMessages(payload: unknown): Promise<CodingMessagePage> {
    if (!hasStrictShape(payload, ['workspaceId', 'sessionId', 'beforeMessageId'])) {
      throw new InvalidSessionRequestError('message list request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, sessionId } = record
    if (!isValidId(workspaceId) || !isValidId(sessionId)) {
      throw new InvalidSessionRequestError('session reference is invalid')
    }
    const beforeMessageId = record['beforeMessageId']
    if (beforeMessageId !== undefined && !isValidId(beforeMessageId)) {
      throw new InvalidSessionRequestError('message page reference is invalid')
    }
    this.requireWorkspace(workspaceId)
    const session = this.sessions.findSessionById(sessionId)
    if (session === undefined) {
      throw new SessionNotFoundError()
    }
    if (session.workspaceId !== workspaceId) {
      throw new SessionWorkspaceMismatchError()
    }
    const probe = this.sessions.listMessagesNewestFirst(
      sessionId,
      MAX_MESSAGE_PAGE_SIZE,
      (beforeMessageId as number | undefined) ?? null
    )
    const hasMore = probe.length > MAX_MESSAGE_PAGE_SIZE
    const page = (hasMore ? probe.slice(0, MAX_MESSAGE_PAGE_SIZE) : probe).reverse()
    return { messages: page.map((stored) => this.toPublicMessage(stored)), hasMore }
  }

  /**
   * Persists one user message (role forced to 'user') and advances the
   * session timestamp, deriving the deterministic title when the first
   * message lands on an untitled session — all atomically.
   */
  async sendUserMessage(payload: unknown): Promise<SendUserMessageResult> {
    if (!hasStrictShape(payload, ['workspaceId', 'sessionId', 'content'])) {
      throw new InvalidSessionRequestError('message request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, sessionId, content } = record
    if (!isValidId(workspaceId) || !isValidId(sessionId)) {
      throw new InvalidSessionRequestError('session reference is invalid')
    }
    const validated = validateUserMessageContent(content)
    this.requireWorkspace(workspaceId)
    const session = this.sessions.findSessionById(sessionId)
    if (session === undefined) {
      throw new SessionNotFoundError()
    }
    if (session.workspaceId !== workspaceId) {
      throw new SessionWorkspaceMismatchError()
    }
    const now = this.now()
    const retitle =
      session.title === NEW_SESSION_TITLE
        ? { expectedTitle: NEW_SESSION_TITLE, newTitle: deriveSessionTitle(validated) }
        : null
    const { messageId } = this.sessions.appendMessage({
      sessionId,
      role: 'user',
      content: validated,
      now,
      retitle
    })
    const message = this.sessions.findMessageById(messageId)
    const updated = this.sessions.findSessionById(sessionId)
    if (message === undefined || updated === undefined) {
      throw new SessionNotFoundError()
    }
    return { session: this.toPublicSession(updated), message: this.toPublicMessage(message) }
  }
}
