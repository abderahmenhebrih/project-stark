import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeCoverageRatio, inferenceCostMicros, sponsorRevenueMicros } from './sponsor-economics'

describe('sponsor economics / coverage seam', () => {
  it('revenue 150 / cost 100 → coverage 1.5 (synthetic fixture)', () => {
    assert.equal(computeCoverageRatio(sponsorRevenueMicros(150), inferenceCostMicros(100)), 1.5)
  })

  it('zero cost is handled safely without divide-by-zero', () => {
    assert.equal(computeCoverageRatio(sponsorRevenueMicros(150), inferenceCostMicros(0)), null)
  })

  it('unknown values yield unknown coverage (null, no fake dollars)', () => {
    assert.equal(computeCoverageRatio({}, {}), null)
    assert.equal(computeCoverageRatio(sponsorRevenueMicros(150), {}), null)
    assert.equal(computeCoverageRatio({}, inferenceCostMicros(100)), null)
  })

  it('invalid inputs yield null (negative, non-finite)', () => {
    assert.equal(computeCoverageRatio(sponsorRevenueMicros(-1), inferenceCostMicros(100)), null)
    assert.equal(computeCoverageRatio(sponsorRevenueMicros(150), inferenceCostMicros(-4)), null)
    assert.equal(
      computeCoverageRatio(sponsorRevenueMicros(Number.NaN), inferenceCostMicros(100)),
      null
    )
    assert.equal(
      computeCoverageRatio(sponsorRevenueMicros(150), inferenceCostMicros(Number.POSITIVE_INFINITY)),
      null
    )
  })
})
