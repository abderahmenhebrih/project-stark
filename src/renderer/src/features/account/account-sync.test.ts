import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  isCloudAccountStatus,
  type CloudAccountStatus
} from '../../../../shared/cloud-account/types'
import { accountPanelReducer, initialAccountPanelState, isAccountSignedIn } from './account-state'
import {
  initialProviderPanelState,
  providerPanelReducer,
  type ProviderPanelState
} from '../sessions/provider-state'

/**
 * Auth-state sync proof (P0): every renderer surface consumes ONE
 * canonical account truth — the main-owned CloudAccountService
 * sanitized status via a single shared hook — so a restored Google
 * session enables Free hosted models in SessionPanel immediately,
 * sign-in/out pushes land without remount, and the OpenAI disconnect
 * path cannot disturb account state. The execution gate stays
 * strictly signed_in; tokens never reach the renderer.
 */

function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

function signedIn(): CloudAccountStatus {
  return {
    state: 'signed_in',
    account: { provider: 'google', email: 'user@example.com', displayName: 'User', avatarUrl: null }
  }
}

describe('account sync: strict execution gate', () => {
  it('only signed_in counts as authenticated for hosted inference', () => {
    assert.equal(isAccountSignedIn(signedIn()), true)
    assert.equal(isAccountSignedIn({ state: 'signed_out' }), false)
    assert.equal(isAccountSignedIn({ state: 'unavailable' }), false)
    assert.equal(isAccountSignedIn({ state: 'signing_in', provider: 'google' }), false)
    assert.equal(
      isAccountSignedIn({
        state: 'session_attention',
        account: { provider: 'google', email: null, displayName: null, avatarUrl: null },
        reason: 'expired'
      }),
      false
    )
    assert.equal(isAccountSignedIn(null), false)
  })

  it('canonical status carries identity only — tokens are rejected', () => {
    assert.equal(isCloudAccountStatus(signedIn()), true)
    assert.deepEqual(Object.keys(signedIn()).sort(), ['account', 'state'])
    const accountKeys = Object.keys(
      (signedIn() as unknown as { account: Record<string, unknown> }).account
    ).sort()
    assert.deepEqual(accountKeys, ['avatarUrl', 'displayName', 'email', 'provider'])
    for (const poisoned of [
      { ...signedIn(), accessToken: 'x' },
      { ...signedIn(), token: 'x' },
      { ...signedIn(), session: {} },
      { ...signedIn(), code: 'x' }
    ]) {
      assert.equal(isCloudAccountStatus(poisoned), false, 'token-bearing payloads must be rejected')
    }
  })
})

describe('account sync: single canonical source', () => {
  it('SessionPanel consumes the shared hook with the strict gate', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(panel.includes('useAccountStatus()'), 'SessionPanel must read the canonical hook')
    assert.ok(panel.includes('isAccountSignedIn(accountStatus)'), 'SessionPanel must use the strict gate')
    assert.ok(panel.includes('accountSignedIn'), 'derived readiness input must remain')
    assert.ok(
      panel.includes("byokReadiness === 'ready' ? 'ready' : accountSignedIn ? 'free' : 'not-configured'"),
      'Free resolution must stay intact'
    )
    assert.ok(
      !panel.includes('const [accountSignedIn, setAccountSignedIn]'),
      'no private account boolean may compete with the canonical state'
    )
    assert.ok(!panel.includes('lib/account-api'), 'SessionPanel must not bypass the shared hook')
  })

  it('Ask sends the Brain LoopLink with the first model primary', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(
      panel.includes('generateAssistantResponseRaw({ workspaceId, sessionId, effort, model: composerModelStableId, brainModels:'),
      'Ask must carry the Brain chain snapshot'
    )
    assert.ok(panel.includes('const brainChainSnapshot = [...modelChains.brain]'), 'snapshot must follow UI order')
  })

  it('BillingSettings shares the hook instead of a private copy', () => {
    const page = codeOnly(readRenderer('features/settings/sections/BillingSettings.tsx'))
    assert.ok(page.includes('../../account/use-account-status'), 'Billing must use the canonical hook')
    assert.ok(!page.includes('function useAccountStatus'), 'no second account-state source may remain')
    assert.ok(!page.includes('lib/account-api'), 'Billing must not bypass the shared hook')
  })

  it('the hook fetches on mount and applies live pushes', () => {
    const hook = codeOnly(readRenderer('features/account/use-account-status.ts'))
    assert.ok(hook.includes('getAccountStatus()'), 'mount must capture the restored session')
    assert.ok(hook.includes('subscribeAccountUpdates'), 'restore broadcasts and sign-in/out pushes must apply live')
    assert.ok(hook.includes('setStatus(next)'), 'pushed statuses must reach state with no remount')
  })
})

describe('account sync: OpenAI disconnect isolation', () => {
  it('provider disconnect leaves the canonical account state intact', () => {
    let account = initialAccountPanelState()
    account = accountPanelReducer(account, { type: 'pushed', status: signedIn() })
    assert.equal(isAccountSignedIn(account.status), true)
    let provider: ProviderPanelState = {
      ...initialProviderPanelState(),
      workspaceId: 3,
      configured: true,
      selectedModel: 'gpt-4o',
      models: [{ id: 'gpt-4o' }]
    }
    provider = providerPanelReducer(provider, {
      type: 'disconnected',
      workspaceId: 3,
      requestId: 0,
      state: {
        providerId: 'openai',
        displayName: 'OpenAI',
        secureStorageAvailable: true,
        configured: false,
        selectedModel: null
      }
    })
    assert.equal(provider.configured, false)
    assert.equal(provider.selectedModel, null)
    // The account slice is a separate store: untouched by construction.
    assert.equal(isAccountSignedIn(account.status), true)
    assert.deepEqual(account.status, signedIn())
  })
})
