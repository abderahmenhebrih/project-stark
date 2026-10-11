import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FREE_BILLING_MODELS, FROST_BILLING_MODELS, MAGMA_BILLING_MODELS } from './product-catalog'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

describe('billing surface', () => {
  it('renders all four product cards with exact prices', () => {
    const page = codeOnly(readRenderer('features/settings/sections/BillingSettings.tsx'))
    for (const card of ['STARK Free', 'STARK Magma', 'STARK Frost', 'STARK Void']) {
      assert.ok(page.includes(card), `billing must render ${card}`)
    }
    assert.ok(page.includes('$0'), 'Free must show $0')
    assert.ok(page.includes('MAGMA_PRICE_LABEL'), 'Magma must use the locked $10/month label')
    assert.ok(page.includes('FROST_PRICE_LABEL'), 'Frost must use the locked $14/month label')
    assert.ok(page.includes('VOID_MIN_RELOAD_LABEL'), 'Void must use the locked $5 reload label')
  })

  it('positions Frost as best value and Void as pay as you go', () => {
    const page = codeOnly(readRenderer('features/settings/sections/BillingSettings.tsx'))
    assert.ok(page.includes('BEST VALUE'), 'Frost must be flagged best value')
    assert.ok(page.includes('PAY AS YOU GO'), 'Void must be flagged pay as you go')
  })

  it('states loop limits, quotas, plugins, ads, and styles per card', () => {
    const page = codeOnly(readRenderer('features/settings/sections/BillingSettings.tsx'))
    for (const fact of [
      'Brain max 5',
      'Brain max 10',
      'Brain max 15',
      'Brain max 25',
      'Unlimited attachments',
      'Ad-free',
      'Sponsored while STARK works',
      'CURRENT'
    ]) {
      assert.ok(page.includes(fact), `billing must state ${fact}`)
    }
    // Free quotas render through the locked catalog constants (exact copy).
    assert.ok(page.includes('FREE_ATTACHMENT_QUOTA'), 'Free attachments must use the locked quota')
    assert.ok(page.includes('FREE_IMAGE_QUOTA'), 'Free images must use the locked quota')
    assert.ok(page.includes('FAIR_USE_FOOTNOTE'), 'unlimited claims need the fair-use footnote')
    assert.ok(page.includes('HOSTED_USAGE_LIMITS_NOTE'), 'cards need the hosted usage-limits note')
  })

  it('previews paid model lists as expandable product information', () => {
    const page = codeOnly(readRenderer('features/settings/sections/BillingSettings.tsx'))
    assert.ok(page.includes('MAGMA_BILLING_MODELS'), 'Magma list must come from the locked catalog')
    assert.ok(page.includes('FROST_BILLING_MODELS'), 'Frost list must come from the locked catalog')
    assert.ok(page.includes('<details'), 'model lists must be expandable')
    assert.ok(page.includes('Major pay-as-you-go models'), 'Void must not invent a model list')
  })

  it('keeps paid actions honest with no payment provider', () => {
    const page = codeOnly(readRenderer('features/settings/sections/BillingSettings.tsx'))
    assert.ok(page.includes('Sign in to upgrade'), 'signed-out visitors route to Account')
    assert.ok(page.includes('onNavigateAccount'), 'upgrade must navigate to Account, not checkout')
    assert.ok(page.includes('Checkout coming next'), 'signed-in accounts see the honest boundary')
    assert.ok(page.includes('Reloads coming next'), 'Void reloads stay honest')
    for (const backend of ['Stripe', 'stripe', 'PayPal', 'paypal', 'checkout(', 'invoice', 'subscriptionId']) {
      assert.ok(!page.includes(backend), `billing must not contain ${backend}`)
    }
    assert.ok(!page.includes('fetch('), 'billing must make no network requests')
    assert.ok(!page.includes('.invoke('), 'billing must add no IPC invokes')
    const catalog = codeOnly(readRenderer('features/billing/product-catalog.ts'))
    assert.ok(catalog.includes('UnavailableBillingService'), 'the unavailable service must exist')
  })

  it('paid billing models are NOT inserted into the Model Library', () => {
    const library = codeOnly(readRenderer('features/settings/sections/models/model-library.ts'))
    // Compare whole displayName values: paid names can prefix-match Free
    // names (GLM-5.3 vs GLM-5.3 Flash), so substring checks would lie.
    const displayNames = new Set(
      [...library.matchAll(/displayName: '([^']+)'/g)].map((match) => match[1])
    )
    for (const name of [...MAGMA_BILLING_MODELS, ...FROST_BILLING_MODELS]) {
      assert.ok(!displayNames.has(name), `model library must not contain paid model ${name}`)
    }
    for (const free of FREE_BILLING_MODELS) {
      assert.ok(displayNames.has(free), `model library must keep Free model ${free}`)
    }
  })
})
