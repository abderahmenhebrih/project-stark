import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DatabaseError } from './errors'
import { getUserVersion, migrations, runMigrations } from './migrations'
import { ChangeTransactionRepository } from './repositories/change-transaction-repository'
import { ChangeSetRepository } from './repositories/change-set-repository'
import { HeartRepository } from '../heart/heart-repository'
import { LooplinkRepository } from '../looplink/looplink-repository'
import { RecoveryRepository } from '../recovery/recovery-repository'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { WorkerCommandRepository } from '../worker-tools/worker-command-repository'
import { WorkerToolRepository } from '../worker-tools/worker-tool-repository'
import { OrchestrationRepository } from './repositories/orchestration-repository'
import { AiProviderRepository } from './repositories/ai-provider-repository'
import { CodingSessionRepository } from './repositories/coding-session-repository'
import { KeyValueRepository } from './repositories/key-value-repository'
import { WorkspaceRepository } from './repositories/workspace-repository'
import type { Migration } from './types'

/**
 * Single controlled owner of STARK's SQLite connection.
 *
 * Architectural note on threading: DatabaseSync is synchronous and runs
 * on the main thread. That is acceptable at this stage because startup
 * migrations and key/value access are tiny. If future workloads grow
 * heavy, the move is to back the *repository* boundary
 * (KeyValueRepository and its siblings) with a Worker Thread — feature
 * code must keep depending on repositories, never on DatabaseSync, so
 * that swap stays contained here.
 *
 * Exactly one instance is created by src/main/index.ts. Repositories are
 * constructed from this connection; no other module may open its own.
 */

const BUSY_TIMEOUT_MS = 5000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readPragmaText(db: DatabaseSync, name: string): string {
  const row: unknown = db.prepare(`PRAGMA ${name}`).get()
  if (!isRecord(row)) {
    throw new DatabaseError(`unable to read PRAGMA ${name}`)
  }
  const value = row[name]
  if (typeof value !== 'string') {
    throw new DatabaseError(`unable to read PRAGMA ${name}`)
  }
  return value
}

function readPragmaNumber(db: DatabaseSync, name: string): number {
  const row: unknown = db.prepare(`PRAGMA ${name}`).get()
  if (!isRecord(row)) {
    throw new DatabaseError(`unable to read PRAGMA ${name}`)
  }
  const value = row[name]
  if (typeof value !== 'number') {
    throw new DatabaseError(`unable to read PRAGMA ${name}`)
  }
  return value
}

/**
 * Applies the desktop-appropriate SQLite configuration:
 * - foreign_keys = ON: enforce referential integrity (verified read-back).
 * - journal_mode = WAL: crash-safe writes with concurrent readers; the
 *   standard choice for local desktop databases (file-backed only).
 * - synchronous = NORMAL: safe together with WAL, avoids a fsync per
 *   commit while preserving durability on OS crash or power loss.
 * - busy_timeout = 5000: wait up to 5s on locked reads/writes instead of
 *   failing immediately when another connection holds a lock.
 */
function applyPragmas(db: DatabaseSync, isMemoryDatabase: boolean): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  if (readPragmaNumber(db, 'foreign_keys') !== 1) {
    throw new DatabaseError('foreign key enforcement could not be enabled')
  }
  if (!isMemoryDatabase) {
    db.exec('PRAGMA journal_mode = WAL')
    if (readPragmaText(db, 'journal_mode') !== 'wal') {
      throw new DatabaseError('WAL journal mode could not be enabled')
    }
  }
}

export class StarkDatabase {
  private db: DatabaseSync | null = null
  private keyValueRepo: KeyValueRepository | null = null
  private workspaceRepo: WorkspaceRepository | null = null
  private changeTransactionRepo: ChangeTransactionRepository | null = null
  private changeSetRepo: ChangeSetRepository | null = null
  private orchestrationRepo: OrchestrationRepository | null = null
  private heartRepo: HeartRepository | null = null
  private looplinkRepo: LooplinkRepository | null = null
  private recoveryRepo: RecoveryRepository | null = null
  private capabilityRepo: CapabilityRepository | null = null
  private workerToolRepo: WorkerToolRepository | null = null
  private workerCommandRepo: WorkerCommandRepository | null = null
  private codingSessionRepo: CodingSessionRepository | null = null
  private aiProviderRepo: AiProviderRepository | null = null
  private schemaVersion = 0

  /**
   * Opens the database, applies pragmas, and runs pending migrations.
   * Accepts ':memory:' for isolated tests. Throws on any failure after
   * closing the partially initialized connection — callers must treat a
   * throw as "no usable database".
   */
  initialize(dbFilePath: string, migrationList: readonly Migration[] = migrations): void {
    if (this.db !== null) {
      throw new DatabaseError('database is already initialized')
    }
    if (dbFilePath !== ':memory:') {
      try {
        mkdirSync(dirname(dbFilePath), { recursive: true })
      } catch (error) {
        throw new DatabaseError('unable to create database directory', { cause: error })
      }
    }
    const db = new DatabaseSync(dbFilePath)
    try {
      applyPragmas(db, dbFilePath === ':memory:')
      const version = runMigrations(db, migrationList)
      this.db = db
      this.schemaVersion = version
      this.keyValueRepo = new KeyValueRepository(db)
      this.workspaceRepo = new WorkspaceRepository(db)
      this.changeTransactionRepo = new ChangeTransactionRepository(db)
      this.changeSetRepo = new ChangeSetRepository(db)
      this.orchestrationRepo = new OrchestrationRepository(db)
      this.heartRepo = new HeartRepository(db)
      this.looplinkRepo = new LooplinkRepository(db)
      this.recoveryRepo = new RecoveryRepository(db)
      this.capabilityRepo = new CapabilityRepository(db)
      this.workerToolRepo = new WorkerToolRepository(db)
      this.workerCommandRepo = new WorkerCommandRepository(db)
      this.codingSessionRepo = new CodingSessionRepository(db)
      this.aiProviderRepo = new AiProviderRepository(db)
    } catch (error) {
      try {
        db.close()
      } catch {
        // Best effort: the original initialization error below is what matters.
      }
      throw error
    }
  }

  /** Idempotent close. Safe to call when never initialized. */
  close(): void {
    if (this.db === null) {
      return
    }
    try {
      this.db.close()
    } finally {
      this.db = null
      this.keyValueRepo = null
      this.workspaceRepo = null
      this.changeTransactionRepo = null
      this.changeSetRepo = null
      this.orchestrationRepo = null
      this.heartRepo = null
      this.looplinkRepo = null
      this.recoveryRepo = null
      this.capabilityRepo = null
      this.workerToolRepo = null
      this.workerCommandRepo = null
      this.codingSessionRepo = null
      this.aiProviderRepo = null
      this.schemaVersion = 0
    }
  }

  /** True while a usable connection is held. */
  isOpen(): boolean {
    return this.db !== null
  }

  /** Current schema version, or 0 when closed. */
  getSchemaVersion(): number {
    return this.schemaVersion
  }

  /** Canonical user_version read straight from the database file. */
  readStoredSchemaVersion(): number {
    if (this.db === null) {
      throw new DatabaseError('database is not initialized')
    }
    return getUserVersion(this.db)
  }

  /** Repository access for main-process services. Throws when closed. */
  getKeyValue(): KeyValueRepository {
    if (this.keyValueRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.keyValueRepo
  }

  /** Workspace repository access for main-process services. Throws when closed. */
  getWorkspaces(): WorkspaceRepository {
    if (this.workspaceRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.workspaceRepo
  }

  /** Change-transaction repository access for main-process services. Throws when closed. */
  getChangeTransactions(): ChangeTransactionRepository {
    if (this.changeTransactionRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.changeTransactionRepo
  }

  /** Change-set repository access for main-process services. Throws when closed. */
  getChangeSets(): ChangeSetRepository {
    if (this.changeSetRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.changeSetRepo
  }

  /** Orchestration-run repository access for main-process services. Throws when closed. */
  getOrchestrationRuns(): OrchestrationRepository {
    if (this.orchestrationRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.orchestrationRepo
  }

  /** Heart repository access for main-process services. Throws when closed. */
  getHeart(): HeartRepository {
    if (this.heartRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.heartRepo
  }

  /** Looplink repository access for main-process services. Throws when closed. */
  getLooplink(): LooplinkRepository {
    if (this.looplinkRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.looplinkRepo
  }

  /** Recovery repository access for main-process services. Throws when closed. */
  getRecovery(): RecoveryRepository {
    if (this.recoveryRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.recoveryRepo
  }

  /** Capability repository access for main-process services. Throws when closed. */
  getCapabilities(): CapabilityRepository {
    if (this.capabilityRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.capabilityRepo
  }

  /** Worker-tool repository access for main-process services. Throws when closed. */
  getWorkerTools(): WorkerToolRepository {
    if (this.workerToolRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.workerToolRepo
  }

  /** Worker command-execution repository access for main-process services. Throws when closed. */
  getWorkerCommands(): WorkerCommandRepository {
    if (this.workerCommandRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.workerCommandRepo
  }

  /** Coding-session repository access for main-process services. Throws when closed. */
  getCodingSessions(): CodingSessionRepository {
    if (this.codingSessionRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.codingSessionRepo
  }

  /** AI provider repository access for main-process services. Throws when closed. */
  getAiProviders(): AiProviderRepository {
    if (this.aiProviderRepo === null) {
      throw new DatabaseError('database is not initialized')
    }
    return this.aiProviderRepo
  }
}
