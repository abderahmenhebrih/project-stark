import type { Migration } from '../types'

/**
 * Migration 20 — LoopLink execution audit on step-model rows.
 *
 * Adds five nullable columns to `orchestration_step_models` so every
 * provider-backed run step can record HOW its model was chosen, not
 * just WHO won: attempt count, human-safe failover note, attempted
 * model ids (JSON array, attempt order), eligible requested chain
 * (JSON array, UI priority order), and the requested STARK effort.
 * All columns are NULL for pre-020 rows — historical audits keep
 * loading with `modelAudit` winner fields intact and new fields
 * null/unknown. Existing tables and rows are otherwise untouched.
 */
export const migration020LooplinkAudit: Migration = {
  version: 20,
  name: 'looplink-audit',
  up(db): void {
    db.exec('ALTER TABLE orchestration_step_models ADD COLUMN attempts INTEGER NULL')
    db.exec('ALTER TABLE orchestration_step_models ADD COLUMN failover_note TEXT NULL')
    db.exec('ALTER TABLE orchestration_step_models ADD COLUMN attempted_models TEXT NULL')
    db.exec('ALTER TABLE orchestration_step_models ADD COLUMN requested_chain TEXT NULL')
    db.exec('ALTER TABLE orchestration_step_models ADD COLUMN requested_effort TEXT NULL')
  }
}
