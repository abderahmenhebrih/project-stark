import { IPC_CHANNELS } from '../../shared/constants'
import type { SessionUsageSummary, UsageConfig, UsageSummary } from '../../shared/usage/types'
import type { HeartService } from '../heart/heart-service'
import type { AiUsageService } from '../usage/ai-usage-service'
import { validateUsageEmptyRequest } from '../usage/ai-usage-service'
import { toPublicUsageError } from '../usage/ai-usage-errors'
import type { IpcBinding } from './binding'

/**
 * Local usage-awareness IPC bindings: read the usage-routing config,
 * save a complete config, read the bounded local 24-hour summary, and
 * read one bounded per-session summary. One local DB query per call,
 * zero provider calls. No recording, reset, or force-route surface
 * exists: the renderer can never fabricate usage or switch models.
 */
export function createUsageBindings(service: AiUsageService, heart?: HeartService): readonly IpcBinding[] {
  const heartAssignments = (): { providerId: string; model: string }[] => {
    if (heart === undefined) {
      return []
    }
    try {
      const config = heart.getConfig()
      if (config === null) {
        return []
      }
      const out: { providerId: string; model: string }[] = [{ ...config.brain }]
      for (const assignment of [
        config.workerFixed,
        config.workerDefault,
        config.workerRoutes.general,
        config.workerRoutes.coding,
        config.workerRoutes.reasoning,
        config.workerRoutes.fast
      ]) {
        if (assignment !== null) {
          out.push({ ...assignment })
        }
      }
      return out
    } catch {
      return []
    }
  }
  return [
    {
      channel: IPC_CHANNELS.usageGetConfig,
      invoke: (payload): Promise<UsageConfig> =>
        Promise.resolve()
          .then(() => {
            validateUsageEmptyRequest(payload)
            return service.getConfig()
          })
          .catch((error: unknown) => {
            throw toPublicUsageError('get', error)
          })
    },
    {
      channel: IPC_CHANNELS.usageUpdateConfig,
      invoke: (payload): Promise<UsageConfig> =>
        Promise.resolve()
          .then(() => service.updateConfig(payload))
          .catch((error: unknown) => {
            throw toPublicUsageError('update', error)
          })
    },
    {
      channel: IPC_CHANNELS.usageGetSummary,
      invoke: (payload): Promise<UsageSummary> =>
        Promise.resolve()
          .then(() => {
            validateUsageEmptyRequest(payload)
            return service.get24HourSummary(heartAssignments())
          })
          .catch((error: unknown) => {
            throw toPublicUsageError('summary', error)
          })
    },
    {
      channel: IPC_CHANNELS.usageGetSessionSummary,
      invoke: (payload): Promise<SessionUsageSummary> =>
        Promise.resolve()
          .then(() => {
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
              return service.getSessionSummary(undefined)
            }
            const record = payload as Record<string, unknown>
            if (Object.keys(record).length !== 1) {
              return service.getSessionSummary(undefined)
            }
            return service.getSessionSummary(record['sessionId'])
          })
          .catch((error: unknown) => {
            throw toPublicUsageError('summary', error)
          })
    }
  ]
}
