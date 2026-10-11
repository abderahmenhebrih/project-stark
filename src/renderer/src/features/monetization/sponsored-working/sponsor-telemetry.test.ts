import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buildSponsorTelemetryEvent,
  InMemorySponsorTelemetrySink,
  NoopSponsorTelemetrySink
} from './sponsor-telemetry'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

describe('sponsor telemetry interface', () => {
  it('records the narrow event lifecycle with safe metadata only', () => {
    const sink = new InMemorySponsorTelemetrySink()
    const base = { runId: 'run-7-2-3', creativeId: 'dev-examplecloud-1', at: 1000, viewableDurationMs: 0 }
    sink.record(buildSponsorTelemetryEvent('sponsor_requested', base, false))
    sink.record(buildSponsorTelemetryEvent('sponsor_rendered', base, false))
    sink.record(
      buildSponsorTelemetryEvent('sponsor_viewable', { ...base, viewableDurationMs: 1200 }, true)
    )
    sink.record(
      buildSponsorTelemetryEvent('sponsor_hidden', { ...base, viewableDurationMs: 1800 }, true)
    )
    assert.deepEqual(sink.names(), [
      'sponsor_requested',
      'sponsor_rendered',
      'sponsor_viewable',
      'sponsor_hidden'
    ])
    for (const event of sink.list()) {
      assert.deepEqual(Object.keys(event).sort(), [
        'at',
        'creativeId',
        'name',
        'placement',
        'runId',
        'viewable',
        'viewableDurationMs'
      ])
      assert.equal(event.placement, 'ai-working')
    }
    const viewable = sink.list()[2]
    assert.equal(viewable?.viewable, true)
    assert.equal(viewable?.viewableDurationMs, 1200)
  })

  it('tracks viewable duration separately from impression counting', () => {
    const sink = new InMemorySponsorTelemetrySink()
    sink.record(
      buildSponsorTelemetryEvent(
        'sponsor_viewable',
        { runId: 'run-1', creativeId: 'c', at: 0, viewableDurationMs: 5400 },
        true
      )
    )
    // One event, long duration: duration never mints extra impressions.
    assert.equal(sink.list().length, 1)
    assert.equal(sink.list()[0]?.viewableDurationMs, 5400)
  })

  it('noop sink drops events (production default: no upload)', () => {
    const sink = new NoopSponsorTelemetrySink()
    sink.record(
      buildSponsorTelemetryEvent(
        'sponsor_rendered',
        { runId: 'r', creativeId: null, at: 0, viewableDurationMs: 0 },
        false
      )
    )
  })

  it('in-memory sink is bounded (no leaks)', () => {
    const sink = new InMemorySponsorTelemetrySink(4)
    for (let index = 0; index < 10; index += 1) {
      sink.record(
        buildSponsorTelemetryEvent(
          'sponsor_rendered',
          { runId: `run-${String(index)}`, creativeId: null, at: index, viewableDurationMs: 0 },
          false
        )
      )
    }
    assert.equal(sink.list().length, 4)
  })

  it('no remote telemetry upload exists in this pass', () => {
    for (const file of ['sponsor-telemetry.ts', 'SponsoredWorkingSlot.tsx']) {
      const source = readRenderer(`features/monetization/sponsored-working/${file}`)
      for (const forbidden of ['fetch(', 'XMLHttpRequest', 'navigator.sendBeacon', 'WebSocket']) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
  })
})
