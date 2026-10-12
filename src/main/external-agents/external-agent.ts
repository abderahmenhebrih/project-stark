/**
 * External coding-agent adapter architecture (composer hardening).
 *
 * Typed abstraction so the composer never carries Kilo-specific
 * conditionals: SessionPanel talks to the registry, Kilo is the first
 * registered adapter. Adapters propose; they never write — any file
 * changes must enter the existing Change Transaction / Change Set +
 * human-Accept flow via WorkspaceFileWriteService.
 */

import type { KiloAvailability } from '../../shared/agent-target/types'

/** Capabilities an external adapter may advertise (all read/propose-only). */
export interface ExternalAgentCapabilities {
  /** Adapter can stream textual output (else single final message). */
  readonly streaming: boolean
  /** Adapter can return proposed diffs for STARK Review import. */
  readonly proposalImport: boolean
  /** Adapter runs read-only / proposal-only (never live writes). */
  readonly readOnly: boolean
}

/** Sanitized run input: session references only, never secrets. */
export interface ExternalAgentRunInput {
  readonly workspaceId: number
  readonly sessionId: number
  readonly prompt: string
}

/** Sanitized run outcome: assistant-visible text + optional proposals. */
export interface ExternalAgentRunOutcome {
  readonly text: string
  readonly proposedFiles: readonly { readonly relativePath: string; readonly proposedContent: string }[]
}

export interface ExternalAgentAdapter {
  readonly id: string
  readonly displayName: string
  availability(): Promise<KiloAvailability> | KiloAvailability
  readonly capabilities: ExternalAgentCapabilities
  /**
   * Starts one sanitized run. Implementations that cannot prove a
   * safe proposal-only mechanism must refuse (never fake output,
   * never write). Input stays optional so refusing adapters need no
   * unused parameters.
   */
  startRun(input?: ExternalAgentRunInput): Promise<ExternalAgentRunOutcome>
  cancel?(): Promise<void> | void
}

/** Typed registry: one adapter per id, no dynamic module loading. */
export class ExternalAgentRegistry {
  private readonly adapters = new Map<string, ExternalAgentAdapter>()

  register(adapter: ExternalAgentAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(adapterId: string): ExternalAgentAdapter | undefined {
    return this.adapters.get(adapterId)
  }

  ids(): readonly string[] {
    return [...this.adapters.keys()]
  }
}
