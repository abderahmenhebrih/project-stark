import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { initialProviderPanelState } from '../../../sessions/provider-state'
import {
  FREE_CATALOG_COUNT,
  canEnterChain,
  deriveModelLibrary
} from './model-library'
import { MAX_CHAIN_MODELS, addToChain } from './model-chain'

/**
 * STARK Free catalog proof (product-locked): exactly the 15 Free
 * models in exact order, all origin built-in, automatically available
 * with zero provider setup, chain-ready for Brain and Heart at max 5,
 * never deletable, with no generic placeholders and no paid
 * (Magma/Frost/Void) cards before Billing.
 */

const LOCKED_DISPLAY_NAMES = [
  'Muse Spark 1.3',
  'GLM-5.3 Flash',
  'DeepSeek V4.1 Flash',
  'GPT 5.6 Luna',
  'Gemini 2.5 Flash',
  'Claude Haiku 5.5',
  'MiniMax M3',
  'Kimi K2.7 Code',
  'MiMo-V2.6-Pro',
  'MiMo-V2.6-Flash',
  'Nemotron 3.5 Lightning',
  'DeepSeek V4 Flash',
  'Muse Spark 1.2',
  'LongCat 2.0',
  'Mistral Large 4'
] as const

const LOCKED_STABLE_IDS = [
  'builtin:muse-spark-1.3',
  'builtin:glm-5.3-flash',
  'builtin:deepseek-v4.1-flash',
  'builtin:gpt-5.6-luna',
  'builtin:gemini-2.5-flash',
  'builtin:claude-haiku-5.5',
  'builtin:minimax-m3',
  'builtin:kimi-k2.7-code',
  'builtin:mimo-v2.6-pro',
  'builtin:mimo-v2.6-flash',
  'builtin:nemotron-3.5-lightning',
  'builtin:deepseek-v4-flash',
  'builtin:muse-spark-1.2',
  'builtin:longcat-2.0',
  'builtin:mistral-large-4'
] as const

const LOCKED_PROVIDER_LABELS = [
  'Meta',
  'Z.ai',
  'DeepSeek',
  'OpenAI',
  'Google',
  'Anthropic',
  'MiniMax',
  'Moonshot',
  'Xiaomi',
  'Xiaomi',
  'NVIDIA',
  'DeepSeek',
  'Meta',
  'LongCat',
  'Mistral AI'
] as const

function unconfiguredProvider() {
  return { ...initialProviderPanelState(), workspaceId: 3 }
}

function freeCatalog() {
  return deriveModelLibrary(unconfiguredProvider()).filter((entry) => entry.origin === 'built-in')
}

function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readModels(relative: string): string {
  return readSource('src', 'renderer', 'src', 'features', 'settings', 'sections', ...relative.split('/'))
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

describe('STARK Free catalog (locked)', () => {
  it('contains exactly 15 built-in Free models', () => {
    assert.equal(FREE_CATALOG_COUNT, 15)
    const builtIn = freeCatalog()
    assert.equal(builtIn.length, 15)
    const whole = deriveModelLibrary(unconfiguredProvider())
    assert.equal(whole.length, 15)
  })

  it('matches the exact locked list in exact product order', () => {
    assert.deepEqual(
      freeCatalog().map((entry) => entry.displayName),
      [...LOCKED_DISPLAY_NAMES]
    )
  })

  it('uses deterministic unique builtin stable ids', () => {
    const ids = freeCatalog().map((entry) => entry.stableId)
    assert.deepEqual(ids, [...LOCKED_STABLE_IDS])
    assert.equal(new Set(ids).size, 15)
    for (const id of ids) {
      assert.ok(id.startsWith('builtin:'), `${id} must live under the builtin namespace`)
    }
  })

  it('carries the correct provider family labels', () => {
    assert.deepEqual(
      freeCatalog().map((entry) => entry.providerLabel),
      [...LOCKED_PROVIDER_LABELS]
    )
  })

  it('marks every entry built-in, remote, available, unlocked, FREE', () => {
    for (const entry of freeCatalog()) {
      assert.equal(entry.origin, 'built-in')
      assert.equal(entry.sourceType, 'remote')
      assert.equal(entry.available, true)
      assert.equal(entry.locked, false)
      assert.equal(entry.badge, 'FREE')
      assert.equal(entry.planRequirement, null)
    }
  })

  it('contains no credential material', () => {
    for (const entry of freeCatalog()) {
      for (const key of Object.keys(entry)) {
        for (const forbidden of ['apiKey', 'secret', 'password', 'credential', 'token']) {
          assert.ok(!key.toLowerCase().includes(forbidden), `catalog entry must not carry ${forbidden}`)
        }
      }
      const serialized = JSON.stringify(entry)
      assert.ok(!serialized.includes('sk-'), 'catalog entry must not carry key material')
    }
  })

  it('every Free model may enter Brain and Heart chains at max 5', () => {
    const builtIn = freeCatalog()
    for (const entry of builtIn) {
      assert.equal(canEnterChain(entry), true, `${entry.displayName} must be chain-ready`)
    }
    assert.equal(MAX_CHAIN_MODELS, 5)
    let brain: readonly string[] = []
    for (const entry of builtIn.slice(0, 5)) {
      const outcome = addToChain(brain, entry.stableId)
      assert.equal(outcome.applied, true)
      brain = outcome.chain
    }
    assert.equal(brain.length, 5)
    const sixth = addToChain(brain, builtIn[5]?.stableId ?? '')
    assert.equal(sixth.applied, false)
    assert.equal(sixth.reason, 'chain-full')
    let heart: readonly string[] = []
    for (const entry of builtIn.slice(10, 15)) {
      const outcome = addToChain(heart, entry.stableId)
      assert.equal(outcome.applied, true)
      heart = outcome.chain
    }
    assert.equal(heart.length, 5)
    assert.equal(addToChain(heart, builtIn[0]?.stableId ?? '').applied, false)
  })

  it('rejects same-chain duplicates but allows cross-chain sharing', () => {
    const first = freeCatalog()[0]?.stableId ?? ''
    const brain = addToChain([], first).chain
    assert.equal(addToChain(brain, first).reason, 'duplicate-in-chain')
    // Brain and Heart lists are independent: the same model may serve both.
    const heart = addToChain([], first).chain
    assert.deepEqual(heart, [first])
  })

  it('built-ins offer no library deletion path', () => {
    for (const file of ['models/model-library.ts', 'models/ModelCard.tsx']) {
      const source = codeOnly(readModels(file))
      assert.ok(!source.includes('Remove Model'), `${file} must offer no remove action`)
      assert.ok(!source.includes('deleteModel'), `${file} must offer no deletion path`)
      assert.ok(!source.includes('removeModel'), `${file} must offer no removal path`)
    }
  })

  it('group heading reflects STARK Free with exactly 15 built-in cards', () => {
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.includes('STARK Free'), 'top group must name STARK Free')
  })

  it('renders no generic placeholders and no paid cards', () => {
    for (const file of ['ModelsSettings.tsx', 'models/model-library.ts', 'models/ModelCard.tsx']) {
      const source = codeOnly(readModels(file))
      for (const placeholder of ['STARK Built-in', 'STARK Pro']) {
        assert.ok(!source.includes(placeholder), `${file} must not render ${placeholder}`)
      }
      for (const paid of ['Magma', 'Frost', 'Void']) {
        assert.ok(!source.includes(paid), `${file} must not render ${paid} cards before Billing`)
      }
    }
    const names = freeCatalog().map((entry) => entry.displayName)
    assert.ok(!names.includes('STARK Built-in'))
    assert.ok(!names.includes('STARK Pro'))
  })

  it('keeps Add model last, Connected providers working, and Billing reachable', () => {
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.includes('<AddModelCard'), 'Add model card must remain')
    assert.ok(page.indexOf('<AddModelCard') > page.lastIndexOf('<ModelCard'), 'Add model must follow all groups')
    assert.ok(page.includes('Connected providers'), 'optional BYOK group must stay separate')
    assert.ok(page.includes('onUpgrade={props.onNavigateBilling}'), 'locked upgrade route must remain')
    assert.ok(page.includes('<BrainChain'), 'Brain Chain must remain')
    assert.ok(page.includes('<HeartChain'), 'Heart Chain must remain')
    const flow = codeOnly(readModels('models/AddModelFlow.tsx'))
    assert.ok(flow.includes('Upgrade your plan'), 'Add flow must keep the upgrade option')
    assert.ok(flow.includes('View billing'), 'upgrade must still route to Billing')
  })
})
