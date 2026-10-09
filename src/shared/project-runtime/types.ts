/**
 * Shared project-runtime contract (Stage 26).
 *
 * Managed long-lived dev-server sessions owned by the main process.
 * Plain TypeScript only — no Node.js or DOM APIs. The renderer never
 * submits programs, args, URLs, hosts, ports, or PIDs; main derives
 * the loopback preview origin from the persisted approved port.
 * Worker tools never observe or stop runtimes — only the immediate
 * runtime_started result. Humans own Stop/Preview/Reload.
 */

/** Lifecycle of one managed runtime session. Terminal states never transition back. */
export type ProjectRuntimeStatus =
  | 'starting'
  | 'running'
  | 'stopped'
  | 'exited'
  | 'timed_out'
  | 'spawn_failed'
  | 'interrupted'

/** Service-owned stop reason. Never a renderer string. */
export type ProjectRuntimeStopReason =
  | 'user'
  | 'lifetime_limit'
  | 'app_shutdown'
  | 'process_exit'
  | 'spawn_failed'
  | 'interrupted'

/** Renderer-safe runtime summary: bounded tails only, no PID/env/paths. */
export interface ProjectRuntimeSummary {
  readonly id: number
  readonly workspaceId: number
  readonly program: string
  readonly args: readonly string[]
  readonly previewPort: number
  readonly previewUrl: string
  readonly status: ProjectRuntimeStatus
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdoutTail: string
  readonly stderrTail: string
  readonly logsTruncated: boolean
  readonly totalOutputBytes: number
  readonly stopReason: ProjectRuntimeStopReason | null
  readonly createdAt: number
  readonly startedAt: number | null
  readonly endedAt: number | null
}

/** Active-runtime lookup request: workspace only. */
export interface GetActiveRuntimeRequest {
  readonly workspaceId: number
}

/** Recent-history request: workspace only, newest-first, capped at 10. */
export interface ListRecentRuntimesRequest {
  readonly workspaceId: number
}

/** Stop/open/reload request: IDs only — main derives URL and ownership. */
export interface RuntimeRefRequest {
  readonly workspaceId: number
  readonly runtimeId: number
}

/** Live update pushed main → renderer (no polling). */
export interface ProjectRuntimeUpdatedEvent {
  readonly workspaceId: number
  readonly runtime: ProjectRuntimeSummary | null
}

export type ProjectRuntimeUpdatedListener = (event: ProjectRuntimeUpdatedEvent) => void

/** Runtimes slice of the preload bridge (`window.stark.runtimes`). */
export interface ProjectRuntimesApi {
  getActive: (request: GetActiveRuntimeRequest) => Promise<ProjectRuntimeSummary | null>
  listRecent: (request: ListRecentRuntimesRequest) => Promise<readonly ProjectRuntimeSummary[]>
  stop: (request: RuntimeRefRequest) => Promise<ProjectRuntimeSummary>
  openPreview: (request: RuntimeRefRequest) => Promise<ProjectRuntimeSummary>
  reloadPreview: (request: RuntimeRefRequest) => Promise<ProjectRuntimeSummary>
  onUpdated: (listener: ProjectRuntimeUpdatedListener) => (() => void)
}

/** Derives the loopback-only preview origin from an approved port. */
export function previewUrlForPort(port: number): string {
  return `http://127.0.0.1:${String(port)}/`
}
