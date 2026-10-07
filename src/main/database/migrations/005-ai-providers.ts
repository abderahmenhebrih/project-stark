import type { Migration } from '../types'

/**
 * Migration 5 — AI provider configuration and credentials.
 *
 * `ai_provider_configs` holds one row per known provider with the
 * single globally selected model. `ai_provider_credentials` holds
 * ONLY safeStorage-encrypted key bytes (BLOB) keyed to the config row
 * with a cascading FK. No plaintext key, no key prefix, no key
 * material in `key_value` — the tables cannot even express it.
 * Existing tables and rows are untouched.
 */
export const migration005AiProviders: Migration = {
  version: 5,
  name: 'ai-providers',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_provider_configs (
        provider_id TEXT PRIMARY KEY NOT NULL,
        selected_model TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_provider_credentials (
        provider_id TEXT PRIMARY KEY NOT NULL,
        encrypted_api_key BLOB NOT NULL,
        updated_at INTEGER NOT NULL,

        FOREIGN KEY (provider_id)
          REFERENCES ai_provider_configs(provider_id)
          ON DELETE CASCADE
      )
    `)
  }
}
