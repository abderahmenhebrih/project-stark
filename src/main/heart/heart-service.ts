import type {
  HeartAssignment,
  HeartConfig,
  HeartWorkerMode,
  HeartWorkerProfile
} from '../../shared/heart/types'
import type { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import type { HeartRepository } from './heart-repository'
import type { ProviderRegistry } from '../ai/provider-adapter'
import { MAX_HEART_MODEL_ID_CODEPOINTS, MAX_HEART_PROVIDER_ID_CODEPOINTS } from './heart-limits'
import {
  HeartProviderUnavailableError,
  HeartRouteMissingError,
  HeartUnconfiguredError,
  InvalidHeartConfigError,
  InvalidHeartRequestError
} from './heart-errors'

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

export const HEART_WORKER_PROFILES: readonly HeartWorkerProfile[] = ['general', 'coding', 'reasoning', 'fast']

function isWorkerProfile(value: unknown): value is HeartWorkerProfile {
  return (
    value === 'general' || value === 'coding' || value === 'reasoning' || value === 'fast'
  )
}

function validateId(value: unknown, maxCodePoints: number, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new InvalidHeartRequestError(`heart ${what} is invalid`)
  }
  if (value.includes('\0') || hasUnpairedSurrogate(value)) {
    throw new InvalidHeartRequestError(`heart ${what} is invalid`)
  }
  if (countCodePoints(value) > maxCodePoints) {
    throw new InvalidHeartRequestError(`heart ${what} is invalid`)
  }
  return value
}

function parseAssignment(value: unknown, what: string): HeartAssignment | null {
  if (value === null) {
    return null
  }
  if (!hasStrictShape(value, ['providerId', 'model'])) {
    throw new InvalidHeartRequestError(`heart ${what} is invalid`)
  }
  const record = value as Record<string, unknown>
  return {
    providerId: validateId(record['providerId'], MAX_HEART_PROVIDER_ID_CODEPOINTS, `${what} provider`),
    model: validateId(record['model'], MAX_HEART_MODEL_ID_CODEPOINTS, `${what} model`)
  }
}

/** Immutable routing snapshot captured once per Work run. */
export interface HeartSnapshot {
  readonly workerMode: HeartWorkerMode
  readonly brain: HeartAssignment
  readonly workerFixed: HeartAssignment | null
  readonly workerDefault: HeartAssignment | null
  readonly workerRoutes: Record<HeartWorkerProfile, HeartAssignment | null>
}

/** One deterministically resolved Worker route. No network, no loops. */
export interface ResolvedWorkerRoute {
  readonly assignment: HeartAssignment
  readonly routeKey: 'fixed' | 'default' | HeartWorkerProfile
}

/**
 * Heart domain service (Stage 19): deterministic model routing. Loads,
 * validates, and atomically saves user configuration; derives legacy
 * compatibility once; snapshots per-run routing; resolves Worker
 * profiles to assignments. Zero provider calls — routing is local.
 */
export class HeartService {
  private readonly now: () => number

  constructor(
    private readonly heart: HeartRepository,
    private readonly providerConfigs: AiProviderRepository,
    private readonly registry: ProviderRegistry,
    now: () => number = Date.now
  ) {
    this.now = now
  }

  /** Active configuration, or null when Heart was never configured. */
  getConfig(): HeartConfig | null {
    const settings = this.heart.findSettings()
    if (settings === undefined) {
      return null
    }
    return this.assemble(settings.workerMode)
  }

  /**
   * Returns the active configuration, initializing once from the
   * legacy selected provider/model when Heart was never configured.
   * Local only, no network, at most one initialization. Throws a safe
   * unconfigured error when no legacy model exists.
   */
  ensureReady(): HeartConfig {
    const existing = this.getConfig()
    if (existing !== null) {
      return existing
    }
    const legacy = this.findLegacyAssignment()
    if (legacy === null) {
      throw new HeartUnconfiguredError()
    }
    this.heart.saveConfig(
      {
        workerMode: 'fixed',
        assignments: [
          { role: 'brain', routeKey: 'primary', providerId: legacy.providerId, model: legacy.model },
          { role: 'worker', routeKey: 'fixed', providerId: legacy.providerId, model: legacy.model }
        ],
        now: this.now()
      }
    )
    const initialized = this.getConfig()
    if (initialized === null) {
      throw new HeartUnconfiguredError()
    }
    return initialized
  }

  /** Validates and atomically saves a complete Heart configuration. */
  updateConfig(raw: unknown): HeartConfig {
    if (!hasStrictShape(raw, ['workerMode', 'brain', 'workerFixed', 'workerDefault', 'workerRoutes'])) {
      throw new InvalidHeartRequestError('heart configuration is invalid')
    }
    const record = raw as Record<string, unknown>
    const workerMode = record['workerMode']
    if (workerMode !== 'fixed' && workerMode !== 'auto_swap') {
      throw new InvalidHeartRequestError('heart worker mode is invalid')
    }
    const brain = parseAssignment(record['brain'], 'brain assignment')
    if (brain === null) {
      throw new InvalidHeartRequestError('heart brain assignment is required')
    }
    const workerFixed = parseAssignment(record['workerFixed'], 'worker assignment')
    const workerDefault = parseAssignment(record['workerDefault'], 'worker default')
    const routes = record['workerRoutes']
    if (!hasStrictShape(routes, ['general', 'coding', 'reasoning', 'fast'])) {
      throw new InvalidHeartRequestError('heart worker routes are invalid')
    }
    const routesRecord = routes as Record<string, unknown>
    const workerRoutes = {
      general: parseAssignment(routesRecord['general'], 'general route'),
      coding: parseAssignment(routesRecord['coding'], 'coding route'),
      reasoning: parseAssignment(routesRecord['reasoning'], 'reasoning route'),
      fast: parseAssignment(routesRecord['fast'], 'fast route')
    }
    if (workerMode === 'fixed' && workerFixed === null) {
      throw new InvalidHeartRequestError('heart fixed worker assignment is required')
    }
    if (workerMode === 'auto_swap' && workerDefault === null) {
      throw new InvalidHeartRequestError('heart default worker assignment is required')
    }
    this.requireKnownProvider(brain.providerId)
    for (const assignment of [workerFixed, workerDefault, ...Object.values(workerRoutes)]) {
      if (assignment !== null) {
        this.requireKnownProvider(assignment.providerId)
      }
    }
    const assignments: { role: string; routeKey: string; providerId: string; model: string }[] = [
      { role: 'brain', routeKey: 'primary', providerId: brain.providerId, model: brain.model }
    ]
    if (workerFixed !== null) {
      assignments.push({ role: 'worker', routeKey: 'fixed', providerId: workerFixed.providerId, model: workerFixed.model })
    }
    if (workerDefault !== null) {
      assignments.push({ role: 'worker', routeKey: 'default', providerId: workerDefault.providerId, model: workerDefault.model })
    }
    for (const profile of HEART_WORKER_PROFILES) {
      const route = workerRoutes[profile]
      if (route !== null) {
        assignments.push({ role: 'worker', routeKey: profile, providerId: route.providerId, model: route.model })
      }
    }
    this.heart.saveConfig({ workerMode, assignments, now: this.now() })
    const saved = this.getConfig()
    if (saved === null) {
      throw new InvalidHeartConfigError()
    }
    return saved
  }

  /** Captures an immutable routing snapshot for one Work run. */
  snapshot(): HeartSnapshot {
    const config = this.ensureReady()
    return {
      workerMode: config.workerMode,
      brain: { ...config.brain },
      workerFixed: config.workerFixed === null ? null : { ...config.workerFixed },
      workerDefault: config.workerDefault === null ? null : { ...config.workerDefault },
      workerRoutes: {
        general: config.workerRoutes.general === null ? null : { ...config.workerRoutes.general },
        coding: config.workerRoutes.coding === null ? null : { ...config.workerRoutes.coding },
        reasoning: config.workerRoutes.reasoning === null ? null : { ...config.workerRoutes.reasoning },
        fast: config.workerRoutes.fast === null ? null : { ...config.workerRoutes.fast }
      }
    }
  }

  /**
   * Resolves one Worker profile against a snapshot: explicit route
   * first, configured default second, no further fallback. Exactly
   * one result or a safe error — no network, no loops, no heuristics.
   */
  resolveWorker(snapshot: HeartSnapshot, profile: unknown): ResolvedWorkerRoute {
    if (!isWorkerProfile(profile)) {
      throw new InvalidHeartRequestError('heart worker profile is invalid')
    }
    if (snapshot.workerMode === 'fixed') {
      if (snapshot.workerFixed === null) {
        throw new InvalidHeartConfigError()
      }
      return { assignment: snapshot.workerFixed, routeKey: 'fixed' }
    }
    const explicit = snapshot.workerRoutes[profile]
    if (explicit !== null) {
      return { assignment: explicit, routeKey: profile }
    }
    if (snapshot.workerDefault === null) {
      throw new HeartRouteMissingError()
    }
    return { assignment: snapshot.workerDefault, routeKey: 'default' }
  }

  private requireKnownProvider(providerId: string): void {
    if (!this.registry.isKnown(providerId)) {
      throw new HeartProviderUnavailableError()
    }
  }

  private findLegacyAssignment(): HeartAssignment | null {
    for (const providerId of this.registry.knownIds()) {
      const config = this.providerConfigs.findConfig(providerId)
      const model = config?.selectedModel ?? null
      if (model !== null && model !== '') {
        return { providerId, model }
      }
    }
    return null
  }

  private assemble(workerMode: string): HeartConfig {
    if (workerMode !== 'fixed' && workerMode !== 'auto_swap') {
      throw new InvalidHeartConfigError()
    }
    let brain: HeartAssignment | null = null
    let workerFixed: HeartAssignment | null = null
    let workerDefault: HeartAssignment | null = null
    const workerRoutes: Record<HeartWorkerProfile, HeartAssignment | null> = {
      general: null,
      coding: null,
      reasoning: null,
      fast: null
    }
    for (const row of this.heart.listAssignments()) {
      const assignment: HeartAssignment = { providerId: row.providerId, model: row.model }
      if (row.role === 'brain' && row.routeKey === 'primary') {
        brain = assignment
      } else if (row.role === 'worker' && row.routeKey === 'fixed') {
        workerFixed = assignment
      } else if (row.role === 'worker' && row.routeKey === 'default') {
        workerDefault = assignment
      } else if (row.role === 'worker' && isWorkerProfile(row.routeKey)) {
        workerRoutes[row.routeKey] = assignment
      }
    }
    if (brain === null) {
      throw new InvalidHeartConfigError()
    }
    return { workerMode, brain, workerFixed, workerDefault, workerRoutes }
  }
}
