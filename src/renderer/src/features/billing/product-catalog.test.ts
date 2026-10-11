import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FREE_ATTACHMENT_QUOTA,
  FREE_CHAIN_MAX,
  FREE_IMAGE_QUOTA,
  FREE_MODEL_COUNT,
  FREE_PRICE_USD,
  FROST_BILLING_MODELS,
  FROST_CHAIN_MAX,
  FROST_MODEL_COUNT,
  FROST_PRICE_USD,
  FUNDED_VOID_CHAIN_MAX,
  MAGMA_BILLING_MODELS,
  MAGMA_CHAIN_MAX,
  MAGMA_MODEL_COUNT,
  MAGMA_PRICE_USD,
  FREE_BILLING_MODELS,
  VOID_MIN_RELOAD_USD,
  subscriptionModelCount
} from './product-catalog'

const LOCKED_FREE = [
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
]

const LOCKED_MAGMA = [
  'GLM-5.3',
  'Qwen3.8 Max',
  'Kimi K3',
  'Grok 4.7',
  'Claude Sonnet 5',
  'GPT-6 Luna',
  'Gemini 3.8 Flash',
  'Qwen3.8 Flash',
  'GLM-5.2',
  'GPT-5.6 Terra'
]

const LOCKED_FROST = [
  'GPT-6.1 Sol',
  'Claude Sonnet 5.5',
  'Claude Opus 5.5',
  'Gemini 3.1 Pro',
  'GPT-6 Sol',
  'Claude Opus 5',
  'GPT-6 Astra',
  'Step 5 Preview',
  'Nemotron 3 Ultra',
  'GPT-5.3 Codex'
]

describe('billing plan catalog (locked)', () => {
  it('prices are exact: Free $0, Magma $10/mo, Frost $14/mo, Void $5 min reload', () => {
    assert.equal(FREE_PRICE_USD, 0)
    assert.equal(MAGMA_PRICE_USD, 10)
    assert.equal(FROST_PRICE_USD, 14)
    assert.equal(VOID_MIN_RELOAD_USD, 5)
  })

  it('model counts: Free 15, Magma 25 cumulative, Frost 35 cumulative', () => {
    assert.equal(FREE_MODEL_COUNT, 15)
    assert.equal(MAGMA_MODEL_COUNT, 25)
    assert.equal(FROST_MODEL_COUNT, 35)
    assert.equal(subscriptionModelCount('free'), 15)
    assert.equal(subscriptionModelCount('magma'), 25)
    assert.equal(subscriptionModelCount('frost'), 35)
  })

  it('LoopLink caps: Free 5, Magma 10, Frost 15, funded Void 25', () => {
    assert.equal(FREE_CHAIN_MAX, 5)
    assert.equal(MAGMA_CHAIN_MAX, 10)
    assert.equal(FROST_CHAIN_MAX, 15)
    assert.equal(FUNDED_VOID_CHAIN_MAX, 25)
  })

  it('Free billing list matches the locked 15 in order', () => {
    assert.deepEqual([...FREE_BILLING_MODELS], LOCKED_FREE)
  })

  it('Magma billing list adds exactly models 16–25 in order', () => {
    assert.deepEqual([...MAGMA_BILLING_MODELS], LOCKED_MAGMA)
    assert.equal(FREE_BILLING_MODELS.length + MAGMA_BILLING_MODELS.length, 25)
  })

  it('Frost billing list adds exactly models 26–35 in order', () => {
    assert.deepEqual([...FROST_BILLING_MODELS], LOCKED_FROST)
    assert.equal(FREE_BILLING_MODELS.length + MAGMA_BILLING_MODELS.length + FROST_BILLING_MODELS.length, 35)
  })

  it('billing lists never overlap and never rename catalog entries', () => {
    const all = [...FREE_BILLING_MODELS, ...MAGMA_BILLING_MODELS, ...FROST_BILLING_MODELS]
    assert.equal(new Set(all).size, 35)
  })

  it('Free quotas display exactly (paid tiers use fair-use)', () => {
    assert.equal(FREE_ATTACHMENT_QUOTA, '5 attachments / 12 hours')
    assert.equal(FREE_IMAGE_QUOTA, '10 image generations / day')
  })
})
