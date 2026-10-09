/**
 * Database-specific errors.
 *
 * Messages identify the failed operation but never include user data,
 * stored values, or filesystem paths — those stay in `cause`, which the
 * main process only prints in development.
 */

export class DatabaseError extends Error {
  override readonly name: string = 'DatabaseError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

export class MigrationError extends DatabaseError {
  override readonly name = 'MigrationError'

  constructor(migrationVersion: number, migrationName: string, options?: { cause?: unknown }) {
    super(`migration ${migrationVersion} (${migrationName}) failed`, options)
  }
}

/**
 * Thrown when the stored user_version is newer than this build
 * supports. The database must NOT be migrated backwards or opened
 * writable — fail safely with guidance to use a newer STARK build.
 */
export class NewerSchemaError extends DatabaseError {
  override readonly name = 'NewerSchemaError'

  constructor(storedVersion: number, supportedVersion: number, options?: { cause?: unknown }) {
    super(
      `This STARK data was created by a newer version of STARK (data v${storedVersion}, this build supports v${supportedVersion}).`,
      options
    )
  }
}

/**
 * Thrown when a persisted value cannot be decoded safely.
 * Carries the key, never the corrupted payload.
 */
export class CorruptValueError extends DatabaseError {
  override readonly name = 'CorruptValueError'

  constructor(key: string, options?: { cause?: unknown }) {
    super(`stored value for key '${key}' is corrupt`, options)
  }
}
