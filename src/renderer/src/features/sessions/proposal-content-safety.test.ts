import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Proposal content-safety: the model summary and proposed source stay
 * inert text. The summary renders as React text only; the source is
 * displayed only through the existing Stage 9 TransactionReview +
 * Monaco DiffEditor. No HTML sinks, no new diff viewer.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('proposal content safety', () => {
  it('renders proposal summaries as React text with no HTML sinks', () => {
    for (const relative of ['features/sessions/SessionPanel.tsx', 'lib/proposal-error.ts', 'features/sessions/proposal-state.ts']) {
      const source = readRenderer(relative)
      for (const forbidden of ['innerHTML', 'dangerouslySetInnerHTML', '__html', 'markdown']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })

  it('proposal source flows only through the existing review + DiffEditor', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    // The panel never renders proposed source itself: it shows a card
    // with path + summary and hands the transaction id to Explorer.
    assert.ok(panel.includes('Review change'), 'proposal card must offer Review change')
    assert.ok(!panel.includes('DiffEditor'), 'panel must not embed its own diff viewer')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('TransactionReview'), 'review still uses the existing TransactionReview')
  })

  it('proposal helpers never touch the DOM or Node APIs', () => {
    for (const relative of ['features/sessions/proposal-state.ts', 'lib/proposal-error.ts']) {
      const source = readRenderer(relative)
      for (const forbidden of ['document.', 'window.', 'innerHTML', 'dangerouslySetInnerHTML', 'node:']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })

  it('no automatic proposal or retry timers exist', () => {
    for (const relative of ['features/sessions/SessionPanel.tsx', 'features/sessions/proposal-state.ts']) {
      const source = readRenderer(relative)
      for (const forbidden of ['setInterval', 'setTimeout', 'autoRetry', 'retryLoop', 'pollTimers']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })
})
