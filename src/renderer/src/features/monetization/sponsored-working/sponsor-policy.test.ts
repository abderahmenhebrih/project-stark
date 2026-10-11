import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { entitlementForPlan, isSponsorEligibleForEntitlement, resolveMonetizationEntitlement } from './sponsor-policy'
import { DevFixtureSponsorProvider, NullSponsorProvider, buildSponsorContext } from './sponsor-provider'

describe('sponsor policy (Free vs paid)', () => {
  it('Free can show sponsor (eligible, not ad-free)', () => {
    const entitlement = entitlementForPlan('free')
    assert.equal(entitlement.sponsoredWorkingEligible, true)
    assert.equal(entitlement.adFree, false)
    assert.equal(isSponsorEligibleForEntitlement(entitlement), true)
  })

  it('Magma cannot (ad-free)', () => {
    const entitlement = entitlementForPlan('magma')
    assert.equal(entitlement.adFree, true)
    assert.equal(isSponsorEligibleForEntitlement(entitlement), false)
  })

  it('Frost cannot (ad-free)', () => {
    const entitlement = entitlementForPlan('frost')
    assert.equal(entitlement.adFree, true)
    assert.equal(isSponsorEligibleForEntitlement(entitlement), false)
  })

  it('funded Void cannot (ad-free)', () => {
    for (const plan of ['void', 'void-funded']) {
      const entitlement = entitlementForPlan(plan)
      assert.equal(entitlement.adFree, true, `${plan} must be ad-free`)
      assert.equal(isSponsorEligibleForEntitlement(entitlement), false)
    }
  })

  it('adFree always overrides eligibility (inconsistent input)', () => {
    assert.equal(
      isSponsorEligibleForEntitlement({ sponsoredWorkingEligible: true, adFree: true }),
      false
    )
  })

  it('no sponsor with null creative (production null provider)', () => {
    const provider = new NullSponsorProvider()
    assert.equal(provider.getCreative(buildSponsorContext()), null)
  })

  it('dev fixture is only via explicit injection (never production default)', () => {
    const dev = new DevFixtureSponsorProvider()
    const creative = dev.getCreative(buildSponsorContext())
    assert.ok(creative !== null)
    assert.equal(creative?.sponsorName, 'ExampleCloud')
    // Production path stays null.
    assert.equal(new NullSponsorProvider().getCreative(buildSponsorContext()), null)
  })

  it('defaults to Free when no billing source exists', () => {
    const entitlement = resolveMonetizationEntitlement()
    assert.equal(entitlement.sponsoredWorkingEligible, true)
    assert.equal(entitlement.adFree, false)
  })

  it('unknown plans fall back to Free semantics (never accidental ad-free)', () => {
    const entitlement = entitlementForPlan('something-new')
    assert.equal(entitlement.adFree, false)
    assert.equal(entitlement.sponsoredWorkingEligible, true)
  })
})
