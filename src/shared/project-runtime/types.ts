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

/** Lifecycle of one human (Live Review) preview. Memory-only, never persisted. */
export type HumanPreviewState = 'starting' | 'running' | 'stopped' | 'failed'

/** Renderer-safe human preview summary: bounded tails, no PID/env/paths. */
export interface HumanPreviewSummary {
  readonly workspaceId: number
  readonly state: HumanPreviewState
  /** Detected package.json script (`dev`, `preview`, `serve`, `start`). */
  readonly script: string
  readonly packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun'
  readonly program: string
  readonly args: readonly string[]
  /** Discovered loopback URL, or null until the server prints one. */
  readonly url: string | null
  readonly stdoutTail: string
  readonly stderrTail: string
  readonly logsTruncated: boolean
  readonly startedAt: number
  readonly endedAt: number | null
  /** Sanitized failure/note copy, or null. Never raw stacks or secrets. */
  readonly error: string | null
}

/** Explicit human Start outcome: already-running reuses, unknown projects report honestly. */
export interface StartHumanPreviewResult {
  readonly status: 'started' | 'active' | 'no-preview' | 'failed'
  readonly preview: HumanPreviewSummary | null
}

/** Detection result for one workspace: launch plan or an honest reason. */
export interface DetectPreviewResult {
  readonly workspaceId: number
  readonly script: string | null
  readonly packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null
  readonly program: string | null
  readonly args: readonly string[]
  /** Machine-readable reason when script is null: `no-package-json` | `invalid-manifest` | `no-preview-script`. */
  readonly reason: string | null
}

/** Workspace-only request: main derives every run fact itself. */
export interface HumanPreviewWorkspaceRequest {
  readonly workspaceId: number
}

/** Live update pushed main → renderer for human previews (no polling). */
export interface HumanPreviewUpdatedEvent {
  readonly workspaceId: number
  readonly preview: HumanPreviewSummary | null
}

export type HumanPreviewUpdatedListener = (event: HumanPreviewUpdatedEvent) => void

/** Human-preview slice of the preload bridge (`window.stark.preview`). */
export interface HumanPreviewApi {
  detectPreview: (request: HumanPreviewWorkspaceRequest) => Promise<DetectPreviewResult>
  getPreview: (request: HumanPreviewWorkspaceRequest) => Promise<HumanPreviewSummary | null>
  startPreview: (request: HumanPreviewWorkspaceRequest) => Promise<StartHumanPreviewResult>
  stopPreview: (request: HumanPreviewWorkspaceRequest) => Promise<HumanPreviewSummary | null>
  restartPreview: (request: HumanPreviewWorkspaceRequest) => Promise<StartHumanPreviewResult>
  onPreviewUpdated: (listener: HumanPreviewUpdatedListener) => (() => void)
}
