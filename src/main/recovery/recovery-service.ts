import type {
  RecoveryAssignment,
  RecoveryConfig,
  RecoveryMode,
  RecoveryRole,
  UpdateRecoveryConfigRequest
} from '../../shared/recovery/types'
import type { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import type { ProviderRegistry } from '../ai/provider-adapter'
import type { RecoveryRepository } from './recovery-repository'
import { MAX_RECOVERY_MODEL_ID_CODEPOINTS, MAX_RECOVERY_PROVIDER_ID_CODEPOINTS } from './recovery-limits'
import {
  InvalidRecoveryConfigError,
  InvalidRecoveryRequestError,
  RecoveryProviderUnavailableError
} from './recovery-errors'

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

function countCodePoints(value: string): number {
  return [...value].length
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

function validateId(value: unknown, maxCodePoints: number, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new InvalidRecoveryRequestError(`recovery ${what} is invalid`)
  }
  if (value.includes('\0') || hasUnpairedSurrogate(value)) {
    throw new InvalidRecoveryRequestError(`recovery ${what} is invalid`)
  }
  if (countCodePoints(value) > maxCodePoints) {
    throw new InvalidRecoveryRequestError(`recovery ${what} is invalid`)
  }
  return value
}

function parseAssignment(value: unknown, what: string): RecoveryAssignment | null {
  if (value === null) {
    return null
  }
  if (!hasStrictShape(value, ['providerId', 'model'])) {
    throw new InvalidRecoveryRequestError(`recovery ${what} is invalid`)
  }
  const record = value as Record<string, unknown>
  return {
    providerId: validateId(record['providerId'], MAX_RECOVERY_PROVIDER_ID_CODEPOINTS, `${what} provider`),
    model: validateId(record['model'], MAX_RECOVERY_MODEL_ID_CODEPOINTS, `${what} model`)
  }
}

export const RECOVERY_ROLES: readonly RecoveryRole[] = ['ask', 'brain', 'worker']

function isRecoveryMode(value: unknown): value is RecoveryMode {
  return value === 'off' || value === 'handoff' || value === 'auto_once'
}

/**
 * Recovery configuration service (Stage 21): validates and atomically
 * saves user configuration, resolves explicit recovery assignments.
 * Zero provider calls — saving performs no network. No credentials
 * are stored here; assignments carry IDs only.
 */
export class RecoveryService {
  private readonly now: () => number

  constructor(
    private readonly store: RecoveryRepository,
    private readonly providerConfigs: AiProviderRepository,
    private readonly registry: ProviderRegistry,
    now: () => number = Date.now
  ) {
    void this.providerConfigs
    this.now = now
  }

  /** Active configuration, or null when recovery was never configured. */
  getConfig(): RecoveryConfig | null {
    const settings = this.store.findSettings()
    if (settings === undefined) {
      return null
    }
    if (!isRecoveryMode(settings.mode)) {
      throw new InvalidRecoveryConfigError()
    }
    let ask: RecoveryAssignment | null = null
    let brain: RecoveryAssignment | null = null
    let worker: RecoveryAssignment | null = null
    for (const row of this.store.listAssignments()) {
      const assignment: RecoveryAssignment = { providerId: row.providerId, model: row.model }
      if (row.role === 'ask') {
        ask = assignment
      } else if (row.role === 'brain') {
        brain = assignment
      } else if (row.role === 'worker') {
        worker = assignment
      }
    }
    return { mode: settings.mode, ask, brain, worker }
  }

  /** Returns the active config, defaulting to off when never configured. */
  ensureConfig(): RecoveryConfig {
    const existing = this.getConfig()
    if (existing !== null) {
      return existing
    }
    return { mode: 'off', ask: null, brain: null, worker: null }
  }

  /** Validates and atomically saves a complete recovery configuration. */
  updateConfig(raw: unknown): RecoveryConfig {
    if (!hasStrictShape(raw, ['mode', 'ask', 'brain', 'worker'])) {
      throw new InvalidRecoveryRequestError('recovery configuration is invalid')
    }
    const record = raw as Record<string, unknown>
    const mode = record['mode']
    if (!isRecoveryMode(mode)) {
      throw new InvalidRecoveryRequestError('recovery mode is invalid')
    }
    const ask = parseAssignment(record['ask'], 'ask assignment')
    const brain = parseAssignment(record['brain'], 'brain assignment')
    const worker = parseAssignment(record['worker'], 'worker assignment')
    if (mode === 'auto_once' && (ask === null || brain === null || worker === null)) {
      throw new InvalidRecoveryRequestError('recovery auto_once requires ask, brain, and worker assignments')
    }
    for (const assignment of [ask, brain, worker]) {
      if (assignment !== null) {
        this.requireKnownProvider(assignment.providerId)
      }
    }
    const assignments: { role: string; providerId: string; model: string }[] = []
    if (ask !== null) {
      assignments.push({ role: 'ask', providerId: ask.providerId, model: ask.model })
    }
    if (brain !== null) {
      assignments.push({ role: 'brain', providerId: brain.providerId, model: brain.model })
    }
    if (worker !== null) {
      assignments.push({ role: 'worker', providerId: worker.providerId, model: worker.model })
    }
    this.store.saveConfig({ mode, assignments, now: this.now() })
    const saved = this.getConfig()
    if (saved === null) {
      throw new InvalidRecoveryConfigError()
    }
    return saved
  }

  private requireKnownProvider(providerId: string): void {
    if (!this.registry.isKnown(providerId)) {
      throw new RecoveryProviderUnavailableError()
    }
  }
}

/** Validates a complete recovery update request shape for IPC use. */
export function validateRecoveryUpdateRequest(raw: unknown): UpdateRecoveryConfigRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidRecoveryRequestError('recovery configuration is invalid')
  }
  return raw as UpdateRecoveryConfigRequest
}
