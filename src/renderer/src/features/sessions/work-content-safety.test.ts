import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Work content-safety: plan summaries, worker results, and errors
 * render as inert text. No HTML sinks, no fake progress percentages,
 * no chain-of-thought labels, no tool/action controls.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('work content safety', () => {
  it('renders work state as React text with no HTML sinks', () => {
    for (const relative of [
      'features/sessions/SessionPanel.tsx',
      'features/sessions/work-state.ts',
      'lib/brain-error.ts'
    ]) {
      const source = readRenderer(relative)
      for (const forbidden of ['innerHTML', 'dangerouslySetInnerHTML', '__html']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })

  it('shows no fake progress percentages or timers', () => {
    for (const relative of ['features/sessions/SessionPanel.tsx', 'features/sessions/work-state.ts']) {
      const source = readRenderer(relative)
      assert.ok(!source.includes('setInterval'), `${relative} must not poll`)
      assert.ok(!/%\s*(complete|done|progress)/i.test(source), `${relative} must not fake percentages`)
    }
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('Brain is working…'), 'flight shows one honest preparing state')
  })

  it('never labels artifacts as chain-of-thought and offers no tool controls', () => {
    for (const relative of ['features/sessions/SessionPanel.tsx', 'features/sessions/work-state.ts']) {
      const source = readRenderer(relative)
      for (const forbidden of ['chain-of-thought', 'chainOfThought', 'reasoning trace', 'reasoningTrace']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    for (const forbidden of ['runTool', 'executeCommand', 'claimTools']) {
      assert.ok(!panel.includes(forbidden), `SessionPanel must not contain ${forbidden}`)
    }
  })

  it('work helpers never touch the DOM or Node APIs', () => {
    for (const relative of ['features/sessions/work-state.ts', 'lib/brain-error.ts']) {
      const source = readRenderer(relative)
      for (const forbidden of ['document.', 'window.', 'innerHTML', 'dangerouslySetInnerHTML', 'node:']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })
})
