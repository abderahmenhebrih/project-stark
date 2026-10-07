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
 */

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
 */
export interface SendUserMessageRequest {
  readonly workspaceId: number
  readonly sessionId: number
  readonly content: string
}

/**
 * Send response: the persisted message plus the updated session, so
 * the UI can refresh title/ordering atomically from one round trip.
 */
export interface SendUserMessageResult {
  readonly session: CodingSession
  readonly message: CodingMessage
}

/** Sessions slice of the preload bridge (`window.stark.sessions`). */
export interface SessionsApi {
  create: (workspaceId: number) => Promise<CodingSession>
  list: (workspaceId: number) => Promise<readonly CodingSession[]>
  listMessages: (request: ListSessionMessagesRequest) => Promise<CodingMessagePage>
  sendUserMessage: (request: SendUserMessageRequest) => Promise<SendUserMessageResult>
}
