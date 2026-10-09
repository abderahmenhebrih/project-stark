import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { StarkAuthProvider } from '../../shared/cloud-account/types'
import { CloudAuthExchangeFailedError } from './cloud-account-errors'
import type {
  AuthenticatedIdentity,
  CloudAuthAdapter,
  CloudSessionEnvelope,
  NormalizedCloudIdentity
} from './cloud-account-types'
import {
  MAX_CLOUD_AVATAR_URL_CODEPOINTS,
  MAX_CLOUD_DISPLAY_NAME_CODEPOINTS,
  MAX_CLOUD_EMAIL_CODEPOINTS,
  MAX_CLOUD_USER_ID_CODEPOINTS,
  STARK_AUTH_REDIRECT_URI
} from './cloud-account-limits'
import { validateSessionEnvelope } from './cloud-auth-session-store'

/** Supabase public client configuration (application-owned, never secret). */
export interface SupabasePublicConfig {
  readonly url: string
  readonly anonKey: string
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

function cleanBoundedText(value: unknown, maxCodePoints: number): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.includes('\0') || hasUnpairedSurrogate(trimmed)) {
    return null
  }
  const bounded = [...trimmed].slice(0, maxCodePoints).join('')
  return bounded === '' ? null : bounded
}

/**
 * Normalizes a Supabase user payload into the minimal local identity.
 * Drops user_metadata/app_metadata/identities/provider payloads —
 * only the five bounded fields survive.
 */
export function normalizeSupabaseIdentity(input: {
  id: unknown
  provider: StarkAuthProvider
  email?: unknown
  displayName?: unknown
  avatarUrl?: unknown
}): NormalizedCloudIdentity {
  const { id, provider } = input
  if (typeof id !== 'string' || id === '' || id.includes('\0') || countCodePoints(id) > MAX_CLOUD_USER_ID_CODEPOINTS) {
    throw new CloudAuthExchangeFailedError()
  }
  let email: string | null = null
  if (typeof input.email === 'string' && input.email.trim() !== '') {
    const candidate = input.email.trim()
    if (candidate.includes('\0') || hasUnpairedSurrogate(candidate) || countCodePoints(candidate) > MAX_CLOUD_EMAIL_CODEPOINTS) {
      throw new CloudAuthExchangeFailedError()
    }
    email = candidate
  }
  const displayName = cleanBoundedText(input.displayName, MAX_CLOUD_DISPLAY_NAME_CODEPOINTS)
  let avatarUrl: string | null = cleanBoundedText(input.avatarUrl, MAX_CLOUD_AVATAR_URL_CODEPOINTS)
  if (avatarUrl !== null && !avatarUrl.toLowerCase().startsWith('https://')) {
    avatarUrl = null
  }
  return { cloudUserId: id, provider, email, displayName, avatarUrl }
}

/**
 * Loads Supabase public configuration from application-owned runtime
 * config. Public client values only — never service_role, database
 * passwords, or management tokens.
 */
export function loadSupabasePublicConfig(env: NodeJS.ProcessEnv = process.env): SupabasePublicConfig | null {
  const url = env['SUPABASE_URL']
  const anonKey = env['SUPABASE_ANON_KEY'] ?? env['SUPABASE_PUBLISHABLE_KEY']
  if (typeof url !== 'string' || url.trim() === '' || typeof anonKey !== 'string' || anonKey.trim() === '') {
    return null
  }
  const trimmedUrl = url.trim()
  if (
    trimmedUrl.toLowerCase().includes('service_role') ||
    anonKey.toLowerCase().includes('service_role')
  ) {
    return null
  }
  if (!trimmedUrl.toLowerCase().startsWith('https://')) {
    return null
  }
  return { url: trimmedUrl, anonKey: anonKey.trim() }
}

/** Minimal in-memory PKCE key-value storage (main-process only). */
function createMemoryStorage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void } {
  const backing = new Map<string, string>()
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value)
    },
    removeItem: (key: string) => {
      backing.delete(key)
    }
  }
}

/**
 * Production Supabase Auth adapter (MAIN PROCESS ONLY).
 *
 * Uses the official @supabase/supabase-js client with PKCE-compatible
 * OAuth, explicit single attempts, and uncontrolled background refresh
 * disabled (no timers/retry loops). Auth logic never lives in the
 * renderer; tokens never cross IPC.
 */
export class SupabaseAuthAdapter implements CloudAuthAdapter {
  private readonly client: SupabaseClient | null
  private readonly config: SupabasePublicConfig | null

  constructor(config: SupabasePublicConfig | null, clientFactory?: (config: SupabasePublicConfig) => SupabaseClient) {
    this.config = config
    if (config === null) {
      this.client = null
      return
    }
    try {
      this.client =
        clientFactory !== undefined
          ? clientFactory(config)
          : createClient(config.url, config.anonKey, {
              auth: {
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false,
                storage: createMemoryStorage()
              }
            })
    } catch {
      this.client = null
    }
  }

  isConfigured(): boolean {
    return this.config !== null && this.client !== null
  }

  private requireClient(): SupabaseClient {
    if (this.client === null) {
      throw new CloudAuthExchangeFailedError()
    }
    return this.client
  }

  async beginOAuth(provider: StarkAuthProvider): Promise<{ url: string }> {
    const client = this.requireClient()
    // Single SDK attempt, no retries. skipBrowserRedirect keeps the URL
    // in-process so main can open the SYSTEM browser exactly once.
    const outcome = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: STARK_AUTH_REDIRECT_URI, skipBrowserRedirect: true }
    })
    const url = (outcome.data as { url?: unknown } | null)?.url
    if (typeof url !== 'string' || url === '') {
      throw new CloudAuthExchangeFailedError({ cause: outcome.error })
    }
    // Validate the returned URL belongs to the expected Supabase auth
    // flow where possible: https + auth path marker.
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new CloudAuthExchangeFailedError()
    }
    if (parsed.protocol !== 'https:') {
      throw new CloudAuthExchangeFailedError()
    }
    if (!url.includes('/auth/')) {
      throw new CloudAuthExchangeFailedError()
    }
    return { url }
  }

  async exchangeCode(code: string): Promise<AuthenticatedIdentity> {
    const client = this.requireClient()
    // Exactly one exchange per callback — callers consume the pending
    // attempt BEFORE invoking this.
    const outcome = await client.auth.exchangeCodeForSession(code)
    if (outcome.error !== null && outcome.error !== undefined) {
      throw new CloudAuthExchangeFailedError({ cause: outcome.error })
    }
    const session = (outcome.data as { session?: unknown } | null)?.session as
      | { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown; user?: { id?: unknown } }
      | undefined
    if (session === undefined || session === null) {
      throw new CloudAuthExchangeFailedError()
    }
    const envelope = toEnvelope(session)
    validateSessionEnvelope(envelope)
    const user = (outcome.data as { user?: unknown } | null)?.user as
      | { id?: unknown; email?: unknown; user_metadata?: Record<string, unknown> }
      | undefined
    const identity = normalizeSupabaseIdentity({
      id: user?.id,
      provider: inferProviderFromSession(session),
      email: user?.email,
      displayName: user?.user_metadata?.['full_name'] ?? user?.user_metadata?.['name'] ?? user?.user_metadata?.['display_name'],
      avatarUrl: user?.user_metadata?.['avatar_url'] ?? user?.user_metadata?.['picture']
    })
    return { identity, session: envelope }
  }

  async restoreSession(session: CloudSessionEnvelope): Promise<AuthenticatedIdentity | null> {
    const client = this.requireClient()
    validateSessionEnvelope(session)
    // At most one bounded restore operation: a single setSession, plus
    // at most one refresh when the SDK reports expiry. No polling.
    const setOutcome = await client.auth.setSession({
      access_token: session.accessToken,
      refresh_token: session.refreshToken
    })
    if (setOutcome.error !== null && setOutcome.error !== undefined) {
      return null
    }
    const current = (setOutcome.data as { session?: unknown; user?: unknown } | null)?.session as
      | { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown; user?: { id?: unknown } }
      | null
      | undefined
    if (current === null || current === undefined) {
      return null
    }
    try {
      const envelope = toEnvelope(current)
      validateSessionEnvelope(envelope)
      const user = (setOutcome.data as { user?: unknown } | null)?.user as
        | { id?: unknown; email?: unknown; user_metadata?: Record<string, unknown> }
        | undefined
      const identity = normalizeSupabaseIdentity({
        id: user?.id ?? session.userId,
        provider: inferProviderFromSession(current),
        email: user?.email,
        displayName: user?.user_metadata?.['full_name'] ?? user?.user_metadata?.['name'],
        avatarUrl: user?.user_metadata?.['avatar_url'] ?? user?.user_metadata?.['picture']
      })
      return { identity, session: envelope }
    } catch {
      return null
    }
  }

  async signOut(): Promise<void> {
    if (this.client === null) {
      return
    }
    // Single bounded local-scope revoke; callers treat failures as
    // non-fatal for local sign-out.
    await this.client.auth.signOut({ scope: 'local' })
  }

  async upsertOwnProfile(identity: NormalizedCloudIdentity): Promise<void> {
    if (this.client === null) {
      return
    }
    // ONE bounded upsert, no retry. Failures are non-fatal by contract
    // (callers swallow): login stays valid without a remote profile.
    await this.client.from('profiles').upsert(
      {
        user_id: identity.cloudUserId,
        display_name: identity.displayName,
        avatar_url: identity.avatarUrl
      },
      { onConflict: 'user_id' }
    )
  }
}

function toEnvelope(session: {
  access_token?: unknown
  refresh_token?: unknown
  expires_at?: unknown
  user?: { id?: unknown }
}): CloudSessionEnvelope {
  const accessToken = session.access_token
  const refreshToken = session.refresh_token
  const expiresAt = session.expires_at
  const userId = session.user?.id
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof userId !== 'string') {
    throw new CloudAuthExchangeFailedError()
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) ? expiresAt : null,
    userId
  }
}

function inferProviderFromSession(_session: unknown): StarkAuthProvider {
  // The SDK session does not reliably carry the OAuth provider after a
  // code exchange; the pending attempt already knows it. Callers that
  // need exact provider attribution pass it explicitly — this fallback
  // exists only to satisfy the adapter seam shape. Defaulting is
  // unreachable in the service path (see CloudAccountService which
  // re-stamps the attempt provider). Kept minimal by design.
  void _session
  return 'google'
}
