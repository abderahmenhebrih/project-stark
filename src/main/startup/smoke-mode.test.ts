import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MAX_PACKAGED_SMOKE_MS } from './startup-limits'
import {
  parseSmokeConfig,
  smokeDatabaseFile,
  smokeMarkerExists,
  writeSmokeMarker
} from './smoke-mode'

describe('release smoke mode', () => {
  it('declares the 20s packaged-smoke hard timeout', () => {
    assert.equal(MAX_PACKAGED_SMOKE_MS, 20_000)
  })

  it('stays off unless the exact test-packaging flag triple is set', () => {
    assert.equal(parseSmokeConfig({}), null)
    assert.equal(parseSmokeConfig({ STARK_RELEASE_SMOKE: '1' }), null)
    assert.equal(
      parseSmokeConfig({ STARK_RELEASE_SMOKE: '1', STARK_SMOKE_MARKER: '/tmp/m.json' }),
      null
    )
    const config = parseSmokeConfig({
      STARK_RELEASE_SMOKE: '1',
      STARK_SMOKE_MARKER: '/tmp/m.json',
      STARK_SMOKE_USERDATA: '/tmp/ud'
    })
    assert.deepEqual(config, { markerPath: '/tmp/m.json', userDataDir: '/tmp/ud' })
  })

  it('writes one bounded secret-free ready marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-smoke-test-'))
    try {
      const markerPath = join(dir, 'marker.json')
      assert.equal(smokeMarkerExists(markerPath), false)
      writeSmokeMarker(markerPath, { ok: true, schemaVersion: 18, appVersion: '0.1.0' })
      assert.equal(smokeMarkerExists(markerPath), true)
      const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>
      assert.deepEqual(Object.keys(parsed).sort(), ['appVersion', 'ok', 'schemaVersion'])
      assert.equal(parsed['ok'], true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('isolates the smoke database inside the smoke userdata dir', () => {
    assert.equal(smokeDatabaseFile('/tmp/ud'), join('/tmp/ud', 'smoke.db'))
  })
})
