import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  defaultProductState,
  deriveAccountEntitlements,
  devFixtureProductState,
  productionEntitlements,
  resolveProductStateForAccount,
  toSponsorEntitlement,
  type AccountProductState
} from './entitlements'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

describe('central entitlements', () => {
  it('production is Free with an empty never-activated Void wallet', () => {
    const product = defaultProductState()
    assert.equal(product.basePlan, 'free')
    assert.equal(product.voidWallet.activatedEver, false)
    assert.equal(product.voidWallet.balanceMicros, 0)
    const entitlements = productionEntitlements()
    assert.equal(entitlements.basePlan, 'free')
    assert.equal(entitlements.includedModelCount, 15)
    assert.equal(entitlements.maxBrainModels, 5)
    assert.equal(entitlements.maxHeartModels, 5)
    assert.equal(entitlements.sponsoredWorkingEligible, true)
    assert.equal(entitlements.adFree, false)
    assert.equal(entitlements.pluginsEnabled, false)
    assert.deepEqual(entitlements.attachmentPolicy, { kind: 'limited', label: '5 attachments / 12 hours' })
    assert.deepEqual(entitlements.imageGenerationPolicy, { kind: 'limited', label: '10 image generations / day' })
    assert.deepEqual([...entitlements.unlockedStyles], ['free'])
  })

  it('signing in never implies a paid plan (auth/billing separation)', () => {
    for (const status of [null, { state: 'signed_out' }, { state: 'signed_in', account: null }] as const) {
      const product = resolveProductStateForAccount(status as never)
      assert.equal(product.basePlan, 'free')
    }
  })

  it('Magma derives 25 models, caps 10, plugins, ad-free, free+magma styles', () => {
    const entitlements = deriveAccountEntitlements(devFixtureProductState('magma'))
    assert.equal(entitlements.includedModelCount, 25)
    assert.equal(entitlements.maxBrainModels, 10)
    assert.equal(entitlements.maxHeartModels, 10)
    assert.equal(entitlements.adFree, true)
    assert.equal(entitlements.sponsoredWorkingEligible, false)
    assert.equal(entitlements.pluginsEnabled, true)
    assert.equal(entitlements.attachmentPolicy.kind, 'unlimited')
    assert.equal(entitlements.imageGenerationPolicy.kind, 'unlimited')
    assert.deepEqual([...entitlements.unlockedStyles], ['free', 'magma'])
  })

  it('Frost derives 35 models, caps 15, free+magma+frost styles', () => {
    const entitlements = deriveAccountEntitlements(devFixtureProductState('frost'))
    assert.equal(entitlements.includedModelCount, 35)
    assert.equal(entitlements.maxBrainModels, 15)
    assert.equal(entitlements.maxHeartModels, 15)
    assert.equal(entitlements.adFree, true)
    assert.deepEqual([...entitlements.unlockedStyles], ['free', 'magma', 'frost'])
  })

  it('Void is not a base plan', () => {
    const product: AccountProductState = devFixtureProductState('void-funded')
    assert.equal(product.basePlan, 'free')
    assert.equal(product.voidWallet.balanceMicros > 0, true)
  })

  it('funded Void activates full functional benefits with cap 25', () => {
    const entitlements = deriveAccountEntitlements(devFixtureProductState('void-funded'))
    assert.equal(entitlements.voidFunded, true)
    assert.equal(entitlements.maxBrainModels, 25)
    assert.equal(entitlements.maxHeartModels, 25)
    assert.equal(entitlements.adFree, true)
    assert.equal(entitlements.pluginsEnabled, true)
    assert.deepEqual([...entitlements.unlockedStyles], ['free', 'magma', 'frost', 'void'])
  })

  it('Void at zero balance falls back to base-plan benefits', () => {
    const entitlements = deriveAccountEntitlements({
      basePlan: 'free',
      voidWallet: { activatedEver: false, balanceMicros: 0 }
    })
    assert.equal(entitlements.voidFunded, false)
    assert.equal(entitlements.maxBrainModels, 5)
    assert.equal(entitlements.adFree, false)
    assert.equal(entitlements.sponsoredWorkingEligible, true)
    assert.equal(entitlements.pluginsEnabled, false)
  })

  it('activatedEver keeps all styles unlocked even at zero balance', () => {
    const entitlements = deriveAccountEntitlements(devFixtureProductState('void-activated-empty'))
    assert.equal(entitlements.voidFunded, false)
    assert.deepEqual([...entitlements.unlockedStyles], ['free', 'magma', 'frost', 'void'])
    // ...while functional benefits fall back to the base plan.
    assert.equal(entitlements.maxBrainModels, 5)
    assert.equal(entitlements.adFree, false)
  })

  it('funded Void never lowers a paid base plan (Frost + funding keeps 25)', () => {
    const entitlements = deriveAccountEntitlements({
      basePlan: 'frost',
      voidWallet: { activatedEver: true, balanceMicros: 1000000 }
    })
    assert.equal(entitlements.maxBrainModels, 25)
    assert.equal(entitlements.adFree, true)
  })
})

describe('central sponsor mapping', () => {
  it('Free is sponsor-eligible', () => {
    assert.deepEqual(toSponsorEntitlement(productionEntitlements()), {
      sponsoredWorkingEligible: true,
      adFree: false
    })
  })

  it('Magma and Frost are ad-free', () => {
    for (const kind of ['magma', 'frost'] as const) {
      assert.deepEqual(toSponsorEntitlement(deriveAccountEntitlements(devFixtureProductState(kind))), {
        sponsoredWorkingEligible: false,
        adFree: true
      })
    }
  })

  it('Free + funded Void is ad-free', () => {
    assert.deepEqual(toSponsorEntitlement(deriveAccountEntitlements(devFixtureProductState('void-funded'))), {
      sponsoredWorkingEligible: false,
      adFree: true
    })
  })

  it('Free + zero Void returns the sponsored Free rule', () => {
    assert.deepEqual(
      toSponsorEntitlement(deriveAccountEntitlements(devFixtureProductState('void-activated-empty'))),
      { sponsoredWorkingEligible: true, adFree: false }
    )
  })

  it('Frost + zero Void is STILL ad-free (base plan wins)', () => {
    const entitlements = deriveAccountEntitlements({
      basePlan: 'frost',
      voidWallet: { activatedEver: true, balanceMicros: 0 }
    })
    assert.deepEqual(toSponsorEntitlement(entitlements), { sponsoredWorkingEligible: false, adFree: true })
  })
})

describe('entitlement architecture (no scattered plan checks)', () => {
  it('feature code consumes derived entitlements, not plan literals', () => {
    for (const file of [
      'features/sessions/SessionPanel.tsx',
      'features/settings/sections/ModelsSettings.tsx',
      'features/settings/sections/models/ModelChain.tsx',
      'features/plugins/PluginsPanel.tsx',
      'features/monetization/sponsored-working/SponsoredWorkingSlot.tsx'
    ]) {
      const source = codeOnly(readRenderer(file))
      assert.ok(!source.includes('basePlan'), `${file} must not read basePlan directly`)
      for (const comparison of ["=== 'magma'", '=== "magma"', "=== 'frost'", '=== "frost"']) {
        assert.ok(!source.includes(comparison), `${file} must not compare plan literals`)
      }
    }
  })

  it('dev fixtures stay out of production UI', () => {
    for (const file of [
      'features/settings/sections/BillingSettings.tsx',
      'features/settings/sections/StylesSettings.tsx',
      'features/plugins/PluginsPanel.tsx',
      'features/sessions/SessionPanel.tsx'
    ]) {
      const source = codeOnly(readRenderer(file))
      assert.ok(!source.includes('devFixtureProductState'), `${file} must not wire dev fixtures`)
      assert.ok(!source.includes('Become Frost'), `${file} must offer no plan spoofing`)
    }
  })
})
