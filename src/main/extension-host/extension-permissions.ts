/**
 * Extension capability gating (main-side, pure).
 *
 * Dangerous host operations require explicit user permission; harmless
 * pure APIs never trigger a prompt. Capabilities are derived from
 * observed API use + manifest shape (data only), never guessed.
 */

export type ExtensionCapability =
  | 'filesystem-outside-workspace'
  | 'process-execution'
  | 'network'
  | 'external-url'
  | 'secrets'
  | 'terminal'
  | 'workspace-write'
  | 'debug-execution'

export interface CapabilityRequest {
  readonly extensionId: string
  readonly capability: ExtensionCapability
  readonly reason: string
}

/** Harmless APIs that never require a permission prompt. */
const HARMLESS_API_PREFIXES: readonly string[] = [
  'commands.',
  'languages.',
  'workspace.getConfiguration',
  'window.showInformationMessage',
  'extensions.'
]

/**
 * Whether an observed API requires a capability grant. Returns the
 * capability or null (harmless). Pure and bounded.
 */
export function capabilityForApi(api: string): ExtensionCapability | null {
  if (typeof api !== 'string' || api === '') {
    return null
  }
  for (const prefix of HARMLESS_API_PREFIXES) {
    if (api.startsWith(prefix)) {
      return null
    }
  }
  if (api.startsWith('workspace.fs.') || api.startsWith('FileSystemProvider')) {
    return 'filesystem-outside-workspace'
  }
  if (api.includes('child_process') || api.includes('spawn') || api.startsWith('tasks.')) {
    return 'process-execution'
  }
  if (api.startsWith('env.openExternal')) {
    return 'external-url'
  }
  if (api.startsWith('secrets') || api.startsWith('authentication.')) {
    return 'secrets'
  }
  if (api.startsWith('terminal') || api.startsWith('window.createTerminal')) {
    return 'terminal'
  }
  if (api.startsWith('workspace.applyEdit') || api.startsWith('WorkspaceEdit')) {
    return 'workspace-write'
  }
  if (api.startsWith('debug.')) {
    return 'debug-execution'
  }
  return null
}
