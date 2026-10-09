import { redactForLog } from '../diagnostics/diagnostic-redaction'

/**
 * Bounded global error handling (Stage 30).
 *
 * Installs uncaughtException + unhandledRejection handling exactly
 * once per process. Fatal programmer errors are never silently
 * swallowed and never dump secrets: one redacted safe line is logged,
 * then controlled shutdown proceeds through the caller's quit hook.
 * Duplicate fatal handling is suppressed by an internal once-guard.
 */

/** Minimal process-event surface (real process in production, fake in tests). */
export interface GlobalErrorEmitter {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): void
  removeListener(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): void
}

/** Safe-log sink + controlled-quit hook owned by the app root. */
export interface GlobalErrorHandling {
  logFatal(category: string, detail: string): void
  quitAfterFatal(): void
}

function safeDetail(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return redactForLog(raw).slice(0, 500)
}

/**
 * Installs both handlers. Returns an uninstall function. Installing
 * twice without uninstalling keeps exactly one active pair.
 */
export function installGlobalErrorHandlers(
  emitter: GlobalErrorEmitter,
  handling: GlobalErrorHandling
): () => void {
  let fatalSeen = false

  const onUncaughtException = (error: unknown): void => {
    if (fatalSeen) {
      return
    }
    fatalSeen = true
    try {
      handling.logFatal('uncaught-exception', safeDetail(error))
    } catch {
      // Logging must never break fatal handling.
    }
    try {
      handling.quitAfterFatal()
    } catch {
      // Quit must never throw.
    }
  }

  const onUnhandledRejection = (error: unknown): void => {
    try {
      handling.logFatal('unhandled-rejection', safeDetail(error))
    } catch {
      // Best effort: rejections never crash the process here.
    }
  }

  emitter.on('uncaughtException', onUncaughtException)
  emitter.on('unhandledRejection', onUnhandledRejection)
  return () => {
    emitter.removeListener('uncaughtException', onUncaughtException)
    emitter.removeListener('unhandledRejection', onUnhandledRejection)
  }
}
