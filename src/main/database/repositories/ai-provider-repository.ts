import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { DatabaseError } from '../errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Raw provider config row as stored. */
export interface StoredAiProviderConfig {
  readonly providerId: string
  readonly selectedModel: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

function mapConfig(row: unknown): StoredAiProviderConfig {
  if (!isRecord(row)) {
    throw new DatabaseError('stored AI provider config row is invalid')
  }
  const providerId = row['provider_id']
  const selectedModel = row['selected_model']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (
    typeof providerId !== 'string' ||
    (selectedModel !== null && typeof selectedModel !== 'string') ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    throw new DatabaseError('stored AI provider config row is invalid')
  }
  return { providerId, selectedModel, createdAt, updatedAt }
}

function asStoredBytes(value: unknown): Buffer {
  if (value instanceof Buffer) {
    return value
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value)
  }
  throw new DatabaseError('stored AI provider credential row is invalid')
}

/**
 * Typed main-process repository over ai_provider_configs and
 * ai_provider_credentials. Persistence only: prepared statements, no
 * Electron, no network, no provider SDK. Callers handle only opaque
 * ciphertext — this layer never sees plaintext and cannot decrypt.
 */
export class AiProviderRepository {
  private readonly insertConfigStmt: StatementSync
  private readonly findConfigStmt: StatementSync
  private readonly setModelStmt: StatementSync
  private readonly upsertCredentialStmt: StatementSync
  private readonly findCredentialStmt: StatementSync
  private readonly deleteCredentialStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.insertConfigStmt = db.prepare(
      'INSERT INTO ai_provider_configs (provider_id, selected_model, created_at, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(provider_id) DO NOTHING'
    )
    this.findConfigStmt = db.prepare(
      'SELECT provider_id, selected_model, created_at, updated_at FROM ai_provider_configs WHERE provider_id = ?'
    )
    this.setModelStmt = db.prepare('UPDATE ai_provider_configs SET selected_model = ?, updated_at = ? WHERE provider_id = ?')
    this.upsertCredentialStmt = db.prepare(
      'INSERT INTO ai_provider_credentials (provider_id, encrypted_api_key, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(provider_id) DO UPDATE SET encrypted_api_key = excluded.encrypted_api_key, updated_at = excluded.updated_at'
    )
    this.findCredentialStmt = db.prepare(
      'SELECT encrypted_api_key FROM ai_provider_credentials WHERE provider_id = ?'
    )
    this.deleteCredentialStmt = db.prepare('DELETE FROM ai_provider_credentials WHERE provider_id = ?')
  }

  /** Ensures a config row exists; returns it either way. */
  ensureConfig(providerId: string, now: number): StoredAiProviderConfig {
    this.insertConfigStmt.run(providerId, null, now, now)
    const stored = this.findConfig(providerId)
    if (stored === undefined) {
      throw new DatabaseError('AI provider config row could not be created')
    }
    return stored
  }

  /** Finds one config row by provider id, or undefined. */
  findConfig(providerId: string): StoredAiProviderConfig | undefined {
    const row: unknown = this.findConfigStmt.get(providerId)
    return row === undefined ? undefined : mapConfig(row)
  }

  /** Persists the selected model for a provider. */
  setSelectedModel(providerId: string, model: string, now: number): void {
    this.ensureConfig(providerId, now)
    this.setModelStmt.run(model, now, providerId)
  }

  /** Stores (insert or replace) opaque ciphertext for a provider. */
  setEncryptedCredential(providerId: string, ciphertext: Buffer, now: number): void {
    this.ensureConfig(providerId, now)
    this.upsertCredentialStmt.run(providerId, ciphertext, now)
  }

  /** Returns a Buffer copy of the stored ciphertext, or undefined. */
  findEncryptedCredential(providerId: string): Buffer | undefined {
    const row: unknown = this.findCredentialStmt.get(providerId)
    if (row === undefined) {
      return undefined
    }
    if (!isRecord(row)) {
      throw new DatabaseError('stored AI provider credential row is invalid')
    }
    return asStoredBytes(row['encrypted_api_key'])
  }

  /** Removes the stored credential, if any. */
  clearEncryptedCredential(providerId: string): void {
    this.deleteCredentialStmt.run(providerId)
  }
}
