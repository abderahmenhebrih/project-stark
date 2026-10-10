import type { AgentCapability, CapabilityPolicyMode } from '../../shared/capabilities/types'

/**
 * Static main-owned capability registry (Stage 22). The ONLY source
 * of capability definitions — never loaded from renderer, database
 * strings, provider, or Brain/Worker output. Unknown strings deny.
 */

export const AGENT_CAPABILITIES: readonly AgentCapability[] = [
  'workspace.read',
  'workspace.search',
  'git.read',
  'change.propose',
  'attachment.import',
  'image.generate',
  'terminal.execute',
  'runtime.observe',
  'preview.inspect'
]

const KNOWN: ReadonlySet<string> = new Set<string>(AGENT_CAPABILITIES)

const LEGAL_MODES: Readonly<Record<AgentCapability, readonly CapabilityPolicyMode[]>> = {
  'workspace.read': ['deny', 'ask', 'allow'],
  'workspace.search': ['deny', 'ask', 'allow'],
  'git.read': ['deny', 'ask', 'allow'],
  'change.propose': ['deny', 'ask', 'allow'],
  // Attachment import only ever creates reviewable proposals (writes
  // still need per-file Accept), but binary writes never get a
  // persistent Allow — exact-approval only, like terminal execution.
  'attachment.import': ['deny', 'ask'],
  // Image generation may incur provider cost: exact-approval only,
  // like attachment import and terminal execution. Never persistent
  // Allow — every paid generation needs explicit human approval.
  'image.generate': ['deny', 'ask'],
  'terminal.execute': ['deny', 'ask'],
  'runtime.observe': ['deny', 'ask', 'allow'],
  'preview.inspect': ['deny', 'ask', 'allow']
}

/** True for exactly the nine known capabilities. */
export function isKnownCapability(value: string): value is AgentCapability {
  return KNOWN.has(value)
}

/** Legal modes for one capability (centralized, never scattered). */
export function legalModesFor(capability: AgentCapability): readonly CapabilityPolicyMode[] {
  return LEGAL_MODES[capability]
}

/** True when the mode is legal for the capability (terminal allow forbidden). */
export function isLegalMode(capability: AgentCapability, mode: string): mode is CapabilityPolicyMode {
  return (LEGAL_MODES[capability] as readonly string[]).includes(mode)
}
