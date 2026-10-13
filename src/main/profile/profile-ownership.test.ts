import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Display-name ownership contract (dual identity, documented):
 *
 * - LocalProfile.displayName is the STARK personalization nickname
 *   ("STARK calls you …"). It is set ONLY through the local profile
 *   surface, validated main-side, and never synchronized anywhere.
 * - SafeCloudAccount.displayName is the OAuth provider identity
 *   ("Signed in with Google/GitHub"). It is read-only provider
 *   metadata, never written from the nickname.
 *
 * Sign-in never adopts the cloud name as the nickname; renaming
 * never pushes to the cloud identity. Changing that product rule
 * requires an explicit user decision — this suite locks the current
 * no-sync behavior against accidental coupling.
 */
function readSource(relative: string): string {
  const file = join(process.cwd(), 'src', ...relative.split('/'))
  return readFileSync(file, 'utf8')
}

describe('display-name ownership contract', () => {
  it('local profile copy presents the nickname as STARK personalization only', () => {
    const profile = readSource('renderer/src/features/profile/ProfileSection.tsx')
    assert.ok(profile.includes('STARK calls you'), 'greeting copy must stay personalization')
    assert.ok(profile.includes('NOT cloud profile'), 'must disclaim cloud editing')
    assert.ok(profile.includes('never synchronized'), 'must disclaim sync')
  })

  it('account copy presents the cloud name as provider identity only', () => {
    const account = readSource('renderer/src/features/account/AccountSection.tsx')
    assert.ok(account.includes('Signed in with'), 'cloud name must read as provider identity')
    assert.ok(!account.includes('STARK calls you'), 'account must not present the nickname')
  })

  it('greeting reads the local nickname, never the cloud identity', () => {
    const home = readSource('renderer/src/pages/HomePage.tsx')
    assert.ok(home.includes('profile?.displayName') || home.includes('profile.displayName'), 'greeting must read the local profile')
    const accountState = readSource('renderer/src/features/account/account-state.ts')
    assert.ok(!accountState.includes('setDisplayName'), 'account state must never write the nickname')
  })

  it('main keeps the two identity stores uncoupled', () => {
    const profileService = readSource('main/profile/profile-service.ts')
    assert.ok(!profileService.includes('cloud-account'), 'local profile must not import the cloud account')
    assert.ok(!profileService.includes('supabase'), 'local profile must not touch Supabase')
    const cloudService = readSource('main/cloud-account/cloud-account-service.ts')
    assert.ok(!cloudService.includes('stark.profile'), 'cloud account must not write the local profile key')
    assert.ok(!cloudService.includes('setDisplayName'), 'cloud account must not rename the nickname')
  })
})
