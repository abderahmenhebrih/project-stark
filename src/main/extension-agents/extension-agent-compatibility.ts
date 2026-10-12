/**
 * Agent-provider compatibility detection (main-side, pure).
 *
 * Reads an installed extension's normalized manifest `contributes`
 * as DATA and derives agent-provider candidates — never from the
 * extension's name. The recognized agent signal is the standard
 * `chatParticipants` contribution point: each participant that
 * declares a `command` present in the manifest's contributed
 * `commands` becomes one eligible provider, executed later through
 * the existing trust-gated bounded `invokeCommand` boundary.
 *
 * - Formatter/linter/theme/language manifests declare no chat
 *   participants → zero candidates → never a composer target.
 * - An agent-sounding name WITHOUT contributions → zero candidates
 *   (names are never evidence).
 * - A participant without a contributed command → candidate marked
 *   unavailable with an honest reason (no fake execution path).
 */

export interface ManifestAgentInputs {
  /** Owning extension coordinates. */
  readonly namespace: string
  readonly name: string
  readonly version: string
  /** Manifest display name (bounded, already normalized). */
  readonly displayName: string
  /** Raw `contributes` subset (bounded data only, never executed). */
  readonly contributes: Record<string, unknown> | null
}

export interface AssessedAgentProvider {
  readonly namespace: string
  readonly name: string
  readonly version: string
  readonly providerId: string
  readonly displayName: string
  readonly command: string | null
  /** True when STARK can execute this provider through its command boundary. */
  readonly eligible: boolean
  /** Honest reason when ineligible (generic copy, no vendor cases). */
  readonly reason: string | null
}

/** Bounds for one assessed provider (display- and wire-safe). */
const MAX_PROVIDERS_PER_MANIFEST = 8
const MAX_PROVIDER_ID_LENGTH = 128
const MAX_COMMAND_LENGTH = 128
const MAX_NAME_LENGTH = 128

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value === '' || value.length > maxLength || value.includes('\0')) {
    return null
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function contributedCommands(contributes: Record<string, unknown> | null): Set<string> {
  const out = new Set<string>()
  if (contributes === null) {
    return out
  }
  const raw = contributes['commands']
  if (!Array.isArray(raw)) {
    return out
  }
  for (const entry of raw.slice(0, 256)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue
    }
    const command = (entry as Record<string, unknown>)['command']
    if (typeof command === 'string' && command !== '' && command.length <= MAX_COMMAND_LENGTH && !command.includes('\0')) {
      out.add(command)
    }
  }
  return out
}

function chatParticipants(contributes: Record<string, unknown> | null): readonly Record<string, unknown>[] {
  if (contributes === null) {
    return []
  }
  const raw = contributes['chatParticipants']
  if (!Array.isArray(raw)) {
    return []
  }
  const out: Record<string, unknown>[] = []
  for (const entry of raw.slice(0, MAX_PROVIDERS_PER_MANIFEST)) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      out.push(entry as Record<string, unknown>)
    }
  }
  return out
}

/**
 * Derives agent-provider candidates from manifest contributions.
 * Pure and deterministic: the same manifest always yields the same
 * candidates. Never infers agency from names, publishers, or
 * descriptions.
 */
export function assessAgentProviders(input: ManifestAgentInputs): readonly AssessedAgentProvider[] {
  const participants = chatParticipants(input.contributes)
  if (participants.length === 0) {
    return []
  }
  const commands = contributedCommands(input.contributes)
  const seen = new Set<string>()
  const out: AssessedAgentProvider[] = []
  for (const entry of participants) {
    if (out.length >= MAX_PROVIDERS_PER_MANIFEST) {
      break
    }
    const providerId = cleanText(entry['id'], MAX_PROVIDER_ID_LENGTH)
    if (providerId === null || seen.has(providerId)) {
      continue
    }
    seen.add(providerId)
    const displayName =
      cleanText(entry['fullName'], MAX_NAME_LENGTH) ??
      cleanText(entry['name'], MAX_NAME_LENGTH) ??
      input.displayName
    const command = cleanText(entry['command'], MAX_COMMAND_LENGTH)
    if (command !== null && commands.has(command)) {
      out.push({
        namespace: input.namespace,
        name: input.name,
        version: input.version,
        providerId,
        displayName,
        command,
        eligible: true,
        reason: null
      })
      continue
    }
    // Contribution without an executable command: visible with an
    // honest reason, never executed, never faked.
    out.push({
      namespace: input.namespace,
      name: input.name,
      version: input.version,
      providerId,
      displayName,
      command: null,
      eligible: false,
      reason: 'Extension does not expose a compatible agent command.'
    })
  }
  return out
}
