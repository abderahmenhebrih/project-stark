import { IPC_CHANNELS } from '../../shared/constants'
import type {
  ExtensionAgentProviderInfo,
  ExtensionAgentRunResult
} from '../../shared/extension-agents/types'
import type { ExtensionAgentService } from '../extension-agents/extension-agent-service'
import { toPublicExtensionAgentError } from '../extension-agents/extension-agent-errors'
import type { IpcBinding } from './binding'

/**
 * Extension-agent IPC bindings: exactly two narrow channels — provider
 * discovery (sanitized rows for the composer menu) and one bounded
 * agent run. The renderer submits session/extension references only;
 * prompts derive main-side from the trailing user message, outcomes
 * persist as ordinary assistant messages, and file edits enter the
 * existing Change Transaction pipeline (human Accept required).
 */
export function createExtensionAgentBindings(service: ExtensionAgentService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.extensionAgentsListProviders,
      invoke: (): Promise<readonly ExtensionAgentProviderInfo[]> =>
        service.listProviders().catch((error: unknown) => {
          throw toPublicExtensionAgentError('listing', error)
        })
    },
    {
      channel: IPC_CHANNELS.extensionAgentsRun,
      invoke: (payload: unknown): Promise<ExtensionAgentRunResult> =>
        service.runAgent(payload).catch((error: unknown) => {
          throw toPublicExtensionAgentError('run', error)
        })
    }
  ]
}
