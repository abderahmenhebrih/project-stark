import type { CredentialProtector } from '../ai/credential-protector'
import { SecureStorageUnavailableError } from '../ai/errors'
import {
  CloudAuthSecureStorageUnavailableError,
  CloudAuthExchangeFailedError
} from './cloud-account-errors'
import type { CloudSessionEnvelope } from './cloud-account-types'
import { MAX_CLOUD_TOKEN_CHARS } from './cloud-account-limits'

function hasNoNul(value: string): boolean {
  return !value.includes('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Strictly validates a session-envelope shape. Only the four known keys
 * are accepted; tokens are non-empty bounded strings; expiresAt is a
 * finite non-negative integer or null; userId is non-empty bounded.
 */
export function validateSessionEnvelope(value: unknown): asserts value is CloudSessionEnvelope {
  if (!isRecord(value)) {
    throw new CloudAuthExchangeFailedError()
  }
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== 'accessToken,expiresAt,refreshToken,userId') {
    throw new CloudAuthExchangeFailedError()
  }
  const accessToken = value['accessToken']
  const refreshToken = value['refreshToken']
  const expiresAt = value['expiresAt']
  const userId = value['userId']
  if (
    typeof accessToken !== 'string' ||
    accessToken === '' ||
    accessToken.length > MAX_CLOUD_TOKEN_CHARS ||
    !hasNoNul(accessToken)
  ) {
    throw new CloudAuthExchangeFailedError()
  }
  if (
    typeof refreshToken !== 'string' ||
    refreshToken === '' ||
    refreshToken.length > MAX_CLOUD_TOKEN_CHARS ||
    !hasNoNul(refreshToken)
  ) {
    throw new CloudAuthExchangeFailedError()
  }
  if (
    expiresAt !== null &&
    (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt < 0 || !Number.isSafeInteger(expiresAt))
  ) {
    throw new CloudAuthExchangeFailedError()
  }
  if (typeof userId !== 'string' || userId === '' || userId.length > 128 || !hasNoNul(userId)) {
    throw new CloudAuthExchangeFailedError()
  }
}

/** Serializes a validated envelope to canonical JSON bytes. */
export function serializeSessionEnvelope(envelope: CloudSessionEnvelope): string {
  validateSessionEnvelope(envelope)
  return JSON.stringify({
    accessToken: envelope.accessToken,
    refreshToken: envelope.refreshToken,
    expiresAt: envelope.expiresAt,
    userId: envelope.userId
  })
}

/** Parses and strictly re-validates a serialized envelope. */
export function parseSessionEnvelope(serialized: string): CloudSessionEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    throw new CloudAuthExchangeFailedError()
  }
  validateSessionEnvelope(parsed)
  return parsed
}

/**
 * Encrypted session-envelope store (Stage 29).
 *
 * Wraps the Stage 14 CredentialProtector seam (Electron safeStorage in
 * production, fakes in tests). FAILS CLOSED: when secure storage is
 * unavailable or reports an insecure fallback, sealing/opening throws
 * without ever writing or returning plaintext.
 *
 * Debug output must never stringify envelopes — this module exposes no
 * logging helpers by design.
 */
export class SessionProtector {
  constructor(private readonly protector: CredentialProtector) {}

  /** Encrypts one validated envelope into opaque ciphertext. */
  async seal(envelope: CloudSessionEnvelope): Promise<Buffer> {
    validateSessionEnvelope(envelope)
    let available: boolean
    try {
      available = await this.protector.isAvailable()
    } catch {
      available = false
    }
    if (!available) {
      throw new CloudAuthSecureStorageUnavailableError()
    }
    const serialized = serializeSessionEnvelope(envelope)
    try {
      return await this.protector.encrypt(serialized)
    } catch (error) {
      if (error instanceof SecureStorageUnavailableError) {
        throw new CloudAuthSecureStorageUnavailableError()
      }
      throw new CloudAuthSecureStorageUnavailableError()
    }
  }

  /** Decrypts opaque ciphertext back into a strictly validated envelope. */
  async open(ciphertext: Buffer): Promise<CloudSessionEnvelope> {
    let available: boolean
    try {
      available = await this.protector.isAvailable()
    } catch {
      available = false
    }
    if (!available) {
      throw new CloudAuthSecureStorageUnavailableError()
    }
    let serialized: string
    try {
      const outcome = await this.protector.decrypt(Buffer.from(ciphertext))
      serialized = outcome.secret
    } catch (error) {
      if (error instanceof SecureStorageUnavailableError) {
        throw new CloudAuthSecureStorageUnavailableError()
      }
      throw new CloudAuthExchangeFailedError({ cause: error })
    }
    try {
      return parseSessionEnvelope(serialized)
    } catch (error) {
      if (error instanceof CloudAuthSecureStorageUnavailableError) {
        throw error
      }
      throw new CloudAuthExchangeFailedError({ cause: error })
    }
  }
}
