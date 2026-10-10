/**
 * Shared coding-session domain contract (Stage 13).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * A coding session is a persistent, workspace-scoped conversation.
 * Stage 13 stores user messages only; the schema already permits
 * assistant rows so later provider/Brain stages can append replies.
 * Messages are append-only: no edit, delete, regenerate, or branch.
 * Stage 15 adds explicit user-attached project context per message.
 */

import type { SessionContextDraft, SessionContextItem } from '../context/types'
import type { ChatAttachment } from '../chat-attachments/types'

/** A persisted coding session belonging to exactly one workspace. */
export interface CodingSession {
  readonly id: number
  readonly workspaceId: number
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Message roles stored in Stage 13. No system/tool roles yet. */
export type CodingMessageRole = 'user' | 'assistant'

/** One persisted message. Content is the exact user-supplied text. */
export interface CodingMessage {
  readonly id: number
  readonly sessionId: number
  readonly role: CodingMessageRole
  readonly content: string
  readonly createdAt: number
  /**
   * Context items actually sent with this message (Stage 15).
   * Always populated by list/send paths; empty when none.
   */
  readonly context?: readonly SessionContextItem[]
  /**
   * Local file/image attachments persisted with this message.
   * Always populated by list/send paths; empty when none. Inert
   * metadata only — never forwarded to any AI provider.
   */
  readonly attachments?: readonly ChatAttachment[]
}

/** Session creation carries the workspace reference only. */
export interface CreateCodingSessionRequest {
  readonly workspaceId: number
}

/** Recent-session history for one workspace (capped, no pagination). */
export interface ListCodingSessionsRequest {
  readonly workspaceId: number
}

/**
 * Bounded message-page request. `beforeMessageId` pages backward from
 * the oldest currently loaded message; omit it for the latest page.
 */
export interface ListSessionMessagesRequest {
  readonly workspaceId: number
  readonly sessionId: number
  readonly beforeMessageId?: number
}

/** One bounded message page, oldest-first for display. */
export interface CodingMessagePage {
  readonly messages: readonly CodingMessage[]
  readonly hasMore: boolean
}

/**
 * Renderer → main user-message request. The renderer never chooses
 * role, timestamps, or IDs — main forces `role: 'user'`.
 * Optional `context` carries draft descriptors; file-based items are
 * re-resolved from disk by main, so submitted content is not trusted.
 * Optional `attachments` carries main-issued attachment IDs chosen
 * through the native picker; main re-validates every ID from the
 * attachment store at send time. Empty text is allowed when at least
 * one valid attachment is present.
 */
export interface SendUserMessageRequest {
  readonly workspaceId: number
  readonly sessionId: number
  readonly content: string
  readonly context?: readonly SessionContextDraft[]
  readonly attachments?: readonly string[]
}

/**
 * Send response: the persisted message plus the updated session, so
 * the UI can refresh title/ordering atomically from one round trip.
 * Includes the persisted context items and chat attachments actually
 * stored.
 */
export interface SendUserMessageResult {
  readonly session: CodingSession
  readonly message: CodingMessage
  readonly context?: readonly SessionContextItem[]
  readonly attachments?: readonly ChatAttachment[]
}

/** Sessions slice of the preload bridge (`window.stark.sessions`). */
export interface SessionsApi {
  create: (workspaceId: number) => Promise<CodingSession>
  list: (workspaceId: number) => Promise<readonly CodingSession[]>
  listMessages: (request: ListSessionMessagesRequest) => Promise<CodingMessagePage>
  sendUserMessage: (request: SendUserMessageRequest) => Promise<SendUserMessageResult>
}
