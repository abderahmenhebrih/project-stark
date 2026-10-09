/**
 * Startup failure classification (Stage 30).
 *
 * Fatal-local failures cannot produce a usable application and get one
 * minimal safe dialog. Recoverable-optional failures degrade to local
 * use and must never fail startup.
 */

/** Fatal-local: no usable app without this. Recoverable-optional: local use continues. */
export type StartupFailureKind = 'fatal-local' | 'recoverable-optional'

/** Minimal safe fatal-startup presentation copy. Never paths, SQL, or stacks. */
export const FATAL_START_MESSAGE = 'STARK could not start.'

/** Fatal category shown beside the start message (safe, enumerable). */
export type FatalStartCategory = 'local-data' | 'application-resources'

/** Safe recovery guidance shown with the fatal dialog. */
export const FATAL_START_GUIDANCE =
  'Your project files are untouched. Restart STARK, and if the problem continues, rename the STARK data folder to start fresh with an empty local library.'

/** Newer-schema guard copy: never migrate backwards, never open writable. */
export const NEWER_SCHEMA_MESSAGE = 'This STARK data was created by a newer version of STARK.'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Classifies a startup failure. Database open/migration failures and
 * missing application resources are fatal-local; cloud config, auth
 * restore, usage cleanup, and provider discovery failures are
 * recoverable-optional.
 */
export function classifyStartupError(error: unknown): StartupFailureKind {
  const message = messageOf(error).toLowerCase()
  if (
    message.includes('migration') ||
    message.includes('database') ||
    message.includes('sqlite') ||
    message.includes('schema') ||
    message.includes('newer version') ||
    message.includes('pragma') ||
    message.includes('journal') ||
    message.includes('preload') ||
    message.includes('renderer entry') ||
    message.includes('user_version')
  ) {
    return 'fatal-local'
  }
  return 'recoverable-optional'
}

/**
 * Maps a fatal-local failure to safe dialog copy: the fixed start
 * message, a bounded category, and fixed guidance. Raw bodies, paths,
 * SQL, and stacks never reach the dialog.
 */
export function toSafeFatalCopy(error: unknown): { category: FatalStartCategory; guidance: string } {
  const message = messageOf(error).toLowerCase()
  if (message.includes('preload') || message.includes('renderer entry') || message.includes('resource')) {
    return { category: 'application-resources', guidance: FATAL_START_GUIDANCE }
  }
  return { category: 'local-data', guidance: FATAL_START_GUIDANCE }
}
