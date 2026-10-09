import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MAX_DIAGNOSTIC_LOG_BYTES } from './diagnostic-limits'
import { DiagnosticLogger, resolveLogFilePath } from './diagnostic-logger'
import { isRedactedForLog, redactForLog } from './diagnostic-redaction'

describe('diagnostic redaction', () => {
  it('redacts keys, bearer material, tokens, codes, and verifiers', () => {
    const redacted = redactForLog(
      'call failed sk-SECRETKEY12345678 Bearer TOKEN123456 code=ABC123 refresh_token=xyz verifier=abc'
    )
    assert.ok(!redacted.includes('SECRETKEY'))
    assert.ok(!redacted.includes('TOKEN123456'))
    assert.ok(!redacted.includes('ABC123'))
    assert.ok(redacted.includes('[redacted]'))
    assert.equal(isRedactedForLog(redacted), true)
    assert.equal(isRedactedForLog('provider timeout after 15000ms'), true)
  })

  it('leaves safe operational copy intact', () => {
    assert.equal(redactForLog('provider timeout after 15000ms'), 'provider timeout after 15000ms')
  })
})

describe('bounded diagnostic logger', () => {
  it('declares the 2 MiB per-file bound', () => {
    assert.equal(MAX_DIAGNOSTIC_LOG_BYTES, 2 * 1024 * 1024)
  })

  it('bounds memory, message length, and derivation metadata', () => {
    const logger = new DiagnosticLogger({ maxMemoryRecords: 3, now: () => 1000 })
    for (let index = 0; index < 5; index += 1) {
      logger.log({
        severity: 'info',
        subsystem: 'startup',
        category: 'probe',
        operation: 'tick',
        durationMs: index,
        message: `event ${String(index)} sk-SECRETKEY12345678`
      })
    }
    const recent = logger.listRecent()
    assert.equal(recent.length, 3)
    assert.ok(!JSON.stringify(recent).includes('SECRETKEY'))
    assert.equal(recent[0].timestamp, 1000)
  })

  it('rotates current/previous at the byte bound with no unlimited growth', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-diag-test-'))
    try {
      const file = join(dir, 'stark-diagnostics.log')
      const logger = new DiagnosticLogger({ logFilePath: file, maxBytes: 200, now: () => 7 })
      for (let index = 0; index < 30; index += 1) {
        logger.log({
          severity: 'info',
          subsystem: 'packaging',
          category: 'smoke',
          operation: 'write',
          message: `diagnostic line number ${String(index)} padding padding padding`
        })
      }
      const content = readFileSync(file, 'utf8')
      assert.ok(content.length < 30 * 120)
      assert.ok(!content.includes('SECRETKEY'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves the log file inside the given logs directory', () => {
    assert.equal(resolveLogFilePath('/tmp/logs'), join('/tmp/logs', 'stark-diagnostics.log'))
  })
})
