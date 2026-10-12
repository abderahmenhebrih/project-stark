import type { CloudAccountRepository } from '../cloud-account/cloud-account-repository'
import type { CloudAuthAdapter } from '../cloud-account/cloud-account-types'
import { CloudAuthSignInRequiredError, CloudAuthSecureStorageUnavailableError, CloudAuthUnavailableError } from '../cloud-account/cloud-account-errors'
import { SessionProtector } from '../cloud-account/cloud-auth-session-store'
import { loadSupabasePublicConfig } from '../cloud-account/supabase-auth-adapter'
import {
  StarkHostedSignInRequiredError,
  StarkHostedUnavailableError
} from '../ai/errors'
import type { HostedSessionProvider } from '../ai/provider-adapter'
import { getValidHostedAccessToken } from '../cloud-account/hosted-access-token'

export interface HostedSessionDeps {
  readonly repository: CloudAccountRepository
  readonly protector: SessionProtector
  readonly adapter: CloudAuthAdapter
  readonly now?: () => number
}

/**
 * Resolves the Edge Function URL from application-owned Supabase
 * public config (same source as desktop auth — no new config
 * plumbing, no packaged secrets). Null when unconfigured.
 */
export function hostedFunctionUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const config = loadSupabasePublicConfig(env)
  if (config === null) {
    return null
  }
  return `${config.url.replace(/\/+$/, '')}/functions/v1/stark-infer`
}

/**
 * Main-owned hosted session provider: bridges the cloud-account
 * session to the AI domain without either side importing the other.
 * Cloud failures map to the two hosted AI errors only — token
 * material never escapes, and nothing here reaches the renderer.
 */
export function createHostedSessionProvider(deps: HostedSessionDeps): HostedSessionProvider {
  return {
    async getAccessToken(): Promise<string> {
      try {
        return await getValidHostedAccessToken({
          repository: deps.repository,
          protector: deps.protector,
          adapter: deps.adapter,
          now: deps.now
        })
      } catch (error) {
        if (error instanceof CloudAuthSignInRequiredError) {
          throw new StarkHostedSignInRequiredError()
        }
        if (error instanceof CloudAuthSecureStorageUnavailableError) {
          throw new StarkHostedUnavailableError()
        }
        if (error instanceof CloudAuthUnavailableError) {
          throw new StarkHostedUnavailableError()
        }
        if (error instanceof StarkHostedSignInRequiredError || error instanceof StarkHostedUnavailableError) {
          throw error
        }
        throw new StarkHostedSignInRequiredError()
      }
    }
  }
}
