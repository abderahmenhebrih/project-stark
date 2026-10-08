/**
 * Shared Agent Capability contract (Stage 22).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * Permissions govern FUTURE Worker tool actions only. They never grant
 * filesystem, terminal, Git, or transaction authority by themselves —
 * underlying bounded services still enforce their own security.
 * Default is deny everywhere; the workspace master switch is the kill
 * switch. Terminal can never be persistent allow. Brain has no tool
 * authority.
 */

/** Exactly the five Stage 22 capabilities. No more. */
export type AgentCapability =
  | 'workspace.read'
  | 'workspace.search'
  | 'git.read'
  | 'change.propose'
  | 'terminal.execute'

/** Policy modes. Terminal may use only deny/ask. */
export type CapabilityPolicyMode = 'deny' | 'ask' | 'allow'

/** One capability policy row. */
export interface WorkspaceCapabilityPolicy {
  readonly capability: AgentCapability
  readonly mode: CapabilityPolicyMode
}

/** Complete workspace capability configuration. */
export interface WorkspaceCapabilityConfig {
  readonly workspaceId: number
  readonly enabled: boolean
  readonly policies: readonly WorkspaceCapabilityPolicy[]
}

/** Update request: complete replacement, exactly one row per capability. */
export interface UpdateWorkspaceCapabilityConfigRequest {
  readonly workspaceId: number
  readonly enabled: boolean
  readonly policies: readonly WorkspaceCapabilityPolicy[]
}

/** Read request: workspace only. */
export interface GetWorkspaceCapabilityConfigRequest {
  readonly workspaceId: number
}

/** Capabilities slice of the preload bridge (`window.stark.capabilities`). */
export interface CapabilitiesApi {
  getWorkspaceConfig: (request: GetWorkspaceCapabilityConfigRequest) => Promise<WorkspaceCapabilityConfig>
  updateWorkspaceConfig: (config: UpdateWorkspaceCapabilityConfigRequest) => Promise<WorkspaceCapabilityConfig>
}
