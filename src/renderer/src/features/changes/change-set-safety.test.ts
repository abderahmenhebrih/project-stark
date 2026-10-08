import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Change Set content-safety: global/file summaries remain inert text
 * and proposed code reaches only the existing Monaco DiffEditor. The
 * grouped review offers per-file Review buttons and deliberately no
 * Accept All batch control.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('change set content safety', () => {
  it('renders set summaries as React text with no HTML sinks', () => {
    for (const relative of [
      'features/changes/ChangeSetPanel.tsx',
      'features/changes/ChangeSetReview.tsx',
      'features/changes/change-set-state.ts',
      'lib/change-set-error.ts'
    ]) {
      const source = readRenderer(relative)
      for (const forbidden of ['innerHTML', 'dangerouslySetInnerHTML', '__html', 'markdown']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })

  it('set review reuses TransactionReview and never renders code itself', () => {
    const review = readRenderer('features/changes/ChangeSetReview.tsx')
    assert.ok(!review.includes('<pre'), 'set review must not render code blocks itself')
    assert.ok(!review.includes('DiffEditor'), 'set review must not embed its own diff viewer')
    assert.ok(review.includes('Review'), 'each file must offer per-file Review')
  })

  it('helpers never touch the DOM or Node APIs', () => {
    for (const relative of ['features/changes/change-set-state.ts', 'lib/change-set-error.ts', 'lib/change-sets-api.ts']) {
      const source = readRenderer(relative)
      for (const forbidden of ['document.', 'window.', 'innerHTML', 'dangerouslySetInnerHTML', 'node:']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })
})
