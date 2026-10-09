import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_DIAGNOSTIC_LOG_BYTES } from './diagnostic-limits'
import { redactForLog } from './diagnostic-redaction'

/** Diagnostic severity (bounded vocabulary). */
export type DiagnosticSeverity = 'info' | 'warn' | 'error'

/** One bounded diagnostic record. Metadata only — never secrets. */
export interface DiagnosticRecord {
  readonly timestamp: number
  readonly severity: DiagnosticSeverity
  readonly subsystem: string
  readonly category: string
  readonly operation: string
  readonly durationMs: number | null
  readonly message: string
}

/** Logger options. File writing is opt-in and rotation-bounded. */
export interface DiagnosticLoggerOptions {
  readonly maxBytes?: number
  readonly logFilePath?: string
  readonly now?: () => number
  readonly maxMemoryRecords?: number
}

const DEFAULT_MEMORY_RECORDS = 200
const MAX_SUBSYSTEM_CHARS = 64
const MAX_CATEGORY_CHARS = 128
const MAX_OPERATION_CHARS = 128
const MAX_MESSAGE_CHARS = 2000

function boundText(value: string, maxChars: number): string {
  const trimmed = value.trim()
  if ([...trimmed].length <= maxChars) {
    return trimmed
  }
  return [...trimmed].slice(0, maxChars).join('')
}

/**
 * Bounded local diagnostic logger (Stage 30).
 *
 * Keeps a bounded in-memory ring (default 200 records) and, when a
 * file path is configured, appends redacted single-line JSON with
 * current/previous rotation at MAX_DIAGNOSTIC_LOG_BYTES. No cloud
 * upload, no analytics, no telemetry server, no Workspace content.
 */
export class DiagnosticLogger {
  private readonly records: DiagnosticRecord[] = []
  private readonly maxBytes: number
  private readonly logFilePath: string | undefined
  private readonly now: () => number
  private readonly maxMemoryRecords: number

  constructor(options?: DiagnosticLoggerOptions) {
    this.maxBytes = options?.maxBytes ?? MAX_DIAGNOSTIC_LOG_BYTES
    this.logFilePath = options?.logFilePath
    this.now = options?.now ?? Date.now
    this.maxMemoryRecords = options?.maxMemoryRecords ?? DEFAULT_MEMORY_RECORDS
  }

  /** Records one redacted diagnostic entry (memory + optional file). */
  log(input: {
    severity: DiagnosticSeverity
    subsystem: string
    category: string
    operation: string
    durationMs?: number | null
    message: string
  }): DiagnosticRecord {
    const record: DiagnosticRecord = {
      timestamp: this.now(),
      severity: input.severity,
      subsystem: boundText(input.subsystem, MAX_SUBSYSTEM_CHARS),
      category: boundText(input.category, MAX_CATEGORY_CHARS),
      operation: boundText(input.operation, MAX_OPERATION_CHARS),
      durationMs:
        typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0
          ? Math.floor(input.durationMs)
          : null,
      message: redactForLog(boundText(input.message, MAX_MESSAGE_CHARS))
    }
    this.records.push(record)
    while (this.records.length > this.maxMemoryRecords) {
      this.records.shift()
    }
    if (this.logFilePath !== undefined) {
      this.appendToFile(record)
    }
    return record
  }

  /** Bounded in-memory snapshot (copies, newest last). */
  listRecent(): DiagnosticRecord[] {
    return [...this.records]
  }

  private appendToFile(record: DiagnosticRecord): void {
    if (this.logFilePath === undefined) {
      return
    }
    try {
      mkdirSync(dirname(this.logFilePath), { recursive: true })
      this.rotateIfNeeded()
      appendFileSync(this.logFilePath, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      // Diagnostics must never break the application.
    }
  }

  private rotateIfNeeded(): void {
    if (this.logFilePath === undefined) {
      return
    }
    let size = 0
    try {
      if (existsSync(this.logFilePath)) {
        size = statSync(this.logFilePath).size
      }
    } catch {
      return
    }
    if (size < this.maxBytes) {
      return
    }
    try {
      renameSync(this.logFilePath, `${this.logFilePath}.prev`)
    } catch {
      // Best effort rotation.
    }
  }
}

/**
 * Resolves the human log-folder path from an Electron logs/userData
 * directory already chosen by the app root. Pure path join — no
 * Electron import, no AI exposure. A UI "Open Logs Folder" action
 * must call a specific main-owned opener, never a generic path IPC.
 */
export function resolveLogFilePath(logsDir: string): string {
  return join(logsDir, 'stark-diagnostics.log')
}
