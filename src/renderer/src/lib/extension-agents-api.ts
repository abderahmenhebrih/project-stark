import type {
  ExtensionAgentProviderInfo,
  ExtensionAgentRunRequest,
  ExtensionAgentRunResult
} from '../../../shared/extension-agents/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessors for the generic extension-agent domain.
 * Same Electron-only availability as the bridge itself.
 *
 * Discovery reads the REAL installed-extension registry through the
 * narrow list channel — the composer menu renders whatever providers
 * are registered, with no hardcoded vendor names. Runs submit
 * session/extension references only; prompts derive main-side.
 */
export function listExtensionAgentProviders(): Promise<readonly ExtensionAgentProviderInfo[]> {
  const api = getStarkApi()?.extensionAgents.listProviders
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t list compatible agent extensions.'))
  }
  return api()
}

export function runExtensionAgent(request: ExtensionAgentRunRequest): Promise<ExtensionAgentRunResult> {
  const api = getStarkApi()?.extensionAgents.runAgent
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t run that extension agent.'))
  }
  return api(request)
}
