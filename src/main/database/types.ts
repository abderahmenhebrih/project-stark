import type { DatabaseSync } from 'node:sqlite'

/**
 * Shared persistence-layer types.
 *
 * These describe the contract between the database owner
 * (src/main/database/database.ts) and its consumers. Feature modules must
 * depend on repositories typed with these — never on raw SQL.
 */

/** JSON scalar values that survive a serialize/deserialize round-trip. */
export type JsonPrimitive = string | number | boolean | null

/**
 * Any value that can be persisted as JSON without silent corruption.
 * Functions, class instances, undefined, symbols, bigints, and
 * non-finite numbers are excluded on purpose (see json.ts).
 */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/**
 * A single ordered schema migration.
 * `up` must be idempotent-friendly DDL/DML; downgrades are not supported.
 */
export interface Migration {
  readonly version: number
  readonly name: string
  up(db: DatabaseSync): void
}
