import type { DatabaseSync } from 'node:sqlite'
import { DatabaseError } from '../database/errors'
import type { NormalizedCloudIdentity } from './cloud-account-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asStoredBytes(value: unknown): Buffer {
  if (value instanceof Buffer) {
    return Buffer.from(value)
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value)
  }
  throw new DatabaseError('stored cloud session row is invalid')
}

/** Stored cloud-account row (id=1 singleton). */
export interface StoredCloudAccount {
  readonly cloudUserId: string
  readonly provider: string
  readonly email: string | null
  readonly displayName: string | null
  readonly avatarUrl: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastAuthenticatedAt: number
}

/** Stored encrypted session row (id=1 singleton). */
export interface StoredEncryptedSession {
  readonly encryptedSession: Buffer
  readonly expiresAt: number | null
}

function mapAccountRow(row: unknown): StoredCloudAccount {
  if (!isRecord(row)) {
    throw new DatabaseError('stored cloud account row is invalid')
  }
  const cloudUserId = row['cloud_user_id']
  const provider = row['provider']
  const email = row['email']
  const displayName = row['display_name']
  const avatarUrl = row['avatar_url']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  const lastAuthenticatedAt = row['last_authenticated_at']
  if (
    typeof cloudUserId !== 'string' ||
    typeof provider !== 'string' ||
    (email !== null && typeof email !== 'string') ||
    (displayName !== null && typeof displayName !== 'string') ||
    (avatarUrl !== null && typeof avatarUrl !== 'string') ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number' ||
    typeof lastAuthenticatedAt !== 'number'
  ) {
    throw new DatabaseError('stored cloud account row is invalid')
  }
  return { cloudUserId, provider, email, displayName, avatarUrl, createdAt, updatedAt, lastAuthenticatedAt }
}

/**
 * Typed main-process repository over cloud_account + cloud_auth_session.
 *
 * Consumers never see SQL. Account identity + encrypted session persist
 * in ONE SQLite transaction (all-or-none): never a signed-in identity
 * row without a usable encrypted session outside the explicit
 * session_attention safe state.
 */
export class CloudAccountRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Singleton account row, or undefined when signed out. */
  findAccount(): StoredCloudAccount | undefined {
    const row: unknown = this.db
      .prepare(
        'SELECT cloud_user_id, provider, email, display_name, avatar_url, created_at, updated_at, last_authenticated_at ' +
          'FROM cloud_account WHERE id = 1'
      )
      .get()
    return row === undefined ? undefined : mapAccountRow(row)
  }

  /** Singleton encrypted session row, or undefined when absent. */
  findEncryptedSession(): StoredEncryptedSession | undefined {
    const row: unknown = this.db
      .prepare('SELECT encrypted_session, expires_at FROM cloud_auth_session WHERE id = 1')
      .get()
    if (row === undefined) {
      return undefined
    }
    if (!isRecord(row)) {
      throw new DatabaseError('stored cloud session row is invalid')
    }
    const encrypted = row['encrypted_session']
    const expiresAt = row['expires_at']
    if ((expiresAt !== null && typeof expiresAt !== 'number') || encrypted === undefined || encrypted === null) {
      throw new DatabaseError('stored cloud session row is invalid')
    }
    return { encryptedSession: asStoredBytes(encrypted), expiresAt }
  }

  /**
   * Atomically persists account identity + encrypted session.
   * Either both rows commit or neither does.
   */
  saveAccountAndSession(input: {
    identity: NormalizedCloudIdentity
    encryptedSession: Buffer
    expiresAt: number | null
    now: number
  }): void {
    const { identity, encryptedSession, expiresAt, now } = input
    this.db.exec('BEGIN')
    try {
      const existing: unknown = this.db.prepare('SELECT created_at FROM cloud_account WHERE id = 1').get()
      const createdAt =
        isRecord(existing) && typeof existing['created_at'] === 'number' ? existing['created_at'] : now
      this.db
        .prepare(
          'INSERT INTO cloud_account (id, cloud_user_id, provider, email, display_name, avatar_url, created_at, updated_at, last_authenticated_at) ' +
            'VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET cloud_user_id = excluded.cloud_user_id, provider = excluded.provider, ' +
            'email = excluded.email, display_name = excluded.display_name, avatar_url = excluded.avatar_url, ' +
            'updated_at = excluded.updated_at, last_authenticated_at = excluded.last_authenticated_at'
        )
        .run(
          identity.cloudUserId,
          identity.provider,
          identity.email,
          identity.displayName,
          identity.avatarUrl,
          createdAt,
          now,
          now
        )
      this.db
        .prepare(
          'INSERT INTO cloud_auth_session (id, encrypted_session, expires_at, created_at, updated_at) ' +
            'VALUES (1, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET encrypted_session = excluded.encrypted_session, ' +
            'expires_at = excluded.expires_at, updated_at = excluded.updated_at'
        )
        .run(encryptedSession, expiresAt, createdAt, now)
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort: the original persistence error below is what matters.
      }
      throw error
    }
  }

  /** Atomically clears account identity + encrypted session. Preserves all other tables. */
  clearAccountAndSession(): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM cloud_auth_session WHERE id = 1').run()
      this.db.prepare('DELETE FROM cloud_account WHERE id = 1').run()
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort.
      }
      throw error
    }
  }
}
