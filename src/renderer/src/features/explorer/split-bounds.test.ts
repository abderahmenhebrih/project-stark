import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clampSplitPct, SPLIT_SECONDARY_MIN_PX, SPLIT_SESSION_MIN_PX } from './split-bounds'

describe('split-pane bounds', () => {
  it('passes continuous values through with no preset snapping', () => {
    assert.equal(clampSplitPct(45, 1200), 45)
    assert.equal(clampSplitPct(47.35, 1200), 47.35)
    assert.equal(clampSplitPct(52.7, 1600), 52.7)
  })

  it('enforces the Session minimum width', () => {
    // 1200px row: usable width is 1186px, so 320px is ~26.98%.
    const clamped = clampSplitPct(5, 1200)
    const sessionPx = (clamped / 100) * (1200 - 14)
    assert.ok(sessionPx >= SPLIT_SESSION_MIN_PX - 1, `session must keep ${SPLIT_SESSION_MIN_PX}px, got ${sessionPx}px`)
    assert.ok(clamped > 5, 'out-of-range drags must clamp, not stick')
  })

  it('enforces the secondary editor minimum width', () => {
    const clamped = clampSplitPct(99, 1200)
    const secondaryPx = ((100 - clamped) / 100) * (1200 - 14)
    assert.ok(secondaryPx >= SPLIT_SECONDARY_MIN_PX - 1, `secondary must keep ${SPLIT_SECONDARY_MIN_PX}px`)
    assert.ok(clamped < 99, 'out-of-range drags must clamp, not stick')
  })

  it('adapts bounds to the measured width instead of fixed presets', () => {
    const narrow = clampSplitPct(10, 1100)
    const wide = clampSplitPct(10, 2000)
    assert.ok(narrow > wide, 'tighter rows must clamp harder')
  })

  it('falls back safely on degenerate measurements', () => {
    assert.equal(clampSplitPct(50, 0), 45)
    assert.equal(clampSplitPct(50, -100), 45)
    assert.equal(clampSplitPct(Number.NaN, 1200), 45)
    assert.equal(clampSplitPct(Number.POSITIVE_INFINITY, 1200), 45)
  })
})
