import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

const MONETIZATION_ROOT = 'features/monetization/sponsored-working'
const MONETIZATION_FILES = [
  'sponsor-types.ts',
  'sponsor-policy.ts',
  'sponsor-lifecycle.ts',
  'sponsor-provider.ts',
  'sponsor-viewability.ts',
  'sponsor-telemetry.ts',
  'sponsor-economics.ts',
  'SponsoredWorkingSlot.tsx'
] as const

describe('sponsor has no AI influence (observational only)', () => {
  it('monetization never imports provider/brain/heart/session request code', () => {
    for (const file of MONETIZATION_FILES) {
      const source = readRenderer(`${MONETIZATION_ROOT}/${file}`)
      for (const forbidden of [
        'providers-api',
        'generateAssistantResponseRaw',
        'runBrainWorkRaw',
        'proposeAiFileChange',
        'setProviderModel',
        'heart-api',
        'brain-error',
        'sessions-api',
        'sendSessionUserMessage'
      ]) {
        assert.ok(!source.includes(forbidden), `${file} must not import ${forbidden}`)
      }
    }
  })

  it('monetization cannot delay, block, or extend AI work', () => {
    for (const file of MONETIZATION_FILES) {
      const source = readRenderer(`${MONETIZATION_ROOT}/${file}`)
      for (const forbidden of [
        'setInterval',
        'artificialDelay',
        'delayCompletion',
        'delayStreaming',
        'holdResults',
        'extendBrain',
        'extendHeart'
      ]) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
    // The single permitted timer is the bounded 1000ms viewability shot.
    const viewability = readRenderer(`${MONETIZATION_ROOT}/sponsor-viewability.ts`)
    assert.ok(viewability.includes('SPONSOR_VIEWABLE_MIN_MS'))
  })

  it('monetization never writes assistant output or model selection', () => {
    for (const file of MONETIZATION_FILES) {
      const source = readRenderer(`${MONETIZATION_ROOT}/${file}`)
      for (const forbidden of [
        'dangerouslySetInnerHTML',
        'innerHTML',
        '__html',
        'selectedModel',
        'requestedProfile',
        'routeKey'
      ]) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
  })

  it('SessionPanel sponsor binding is observational (no send-path changes)', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('SponsoredWorkingSlot'), 'panel must mount the narrow slot')
    assert.ok(panel.includes('deriveAiRunState'), 'panel must derive observable run state')
    assert.ok(panel.includes('NullSponsorProvider'), 'production must use the null provider')
    // The binding sits next to the working status, never inside send/generate handlers.
    const slotIndex = panel.indexOf('<SponsoredWorkingSlot')
    assert.ok(slotIndex >= 0)
    const thinkingIndex = panel.indexOf('STARK is thinking')
    assert.ok(thinkingIndex >= 0 && slotIndex > thinkingIndex, 'slot must sit in the working surface')
    // No sponsor influence inside the send/completion dispatch paths.
    for (const handler of ['handleAskSend', 'handleProposeSend', 'handleWorkSend', 'handleRetry']) {
      const at = panel.indexOf(handler)
      if (at >= 0) {
        const slice = panel.slice(at, at + 4000)
        assert.ok(!slice.includes('SponsoredWorkingSlot'), `${handler} must not touch sponsorship`)
        assert.ok(!slice.includes('sponsorAiState'), `${handler} must not touch sponsor state`)
      }
    }
  })

  it('slot cannot block navigation, Settings, or terminal input', () => {
    const slot = readRenderer(`${MONETIZATION_ROOT}/SponsoredWorkingSlot.tsx`)
    // Code-level sinks only: doc comments legitimately name the surfaces
    // the slot must leave alone (Settings, terminal input).
    for (const forbidden of [
      'useNavigate',
      'navigate(',
      'terminal-api',
      'TerminalPanel',
      'settingsOpen',
      'preventDefault',
      'stopPropagation',
      'window.stark'
    ]) {
      assert.ok(!slot.includes(forbidden), `slot must not contain ${forbidden}`)
    }
    // Completion always wins: terminal states return null immediately.
    assert.ok(slot.includes('isTerminalRunState') || slot.includes('isGenuinelyWorking'))
  })
})
