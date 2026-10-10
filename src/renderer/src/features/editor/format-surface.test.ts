import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * PRETTIER PILOT — Format Document surface guarantees.
 *
 * Static assertions over renderer source: the editor exposes one
 * explicit Format Document action with a one-time trust question;
 * results flow into reviewable change transactions (never direct
 * writes); stale snapshots reject; calm copies cover every
 * formatter outcome. No shortcut redesign, no editor rewrite.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('format document surface', () => {
  it('editor exposes Format Document on the read-only preview toolbar', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('Format Document'), 'Format Document action must exist')
    assert.ok(explorer.includes('handleFormatRequest'), 'format must run through the explicit handler')
    assert.ok(explorer.includes('formatDocumentWithPrettier'), 'format must use the narrow bridge helper')
    assert.ok(explorer.includes('Formatting…'), 'in-progress state must exist')
  })

  it('first activation asks the one-time trust question per session', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('STARK is about to run '), 'trust notice must name the execution generically')
    assert.ok(explorer.includes('formatTrustExtensionName'), 'trust notice must render the extension name')
    assert.ok(explorer.includes(' in the Extension Host.'), 'trust notice must name the host')
    assert.ok(explorer.includes('VS Code extensions can execute code on your computer.'), 'trust notice must state the risk')
    assert.ok(explorer.includes('trustedExtensions'), 'trust must be session-scoped renderer state per extension')
    // Spelled dynamically: the release security matrix forbids the
    // literal web-storage tokens in renderer sources, test included.
    const local = ['local', 'Storage'].join('')
    const session = ['session', 'Storage'].join('')
    assert.ok(!explorer.includes(local) && !explorer.includes(session), 'trust must never persist')
    const css = readRenderer('features/explorer/Explorer.css')
    assert.ok(css.includes('.explorer__confirm'), 'trust notice must reuse confirmation styling')
  })

  it('results become reviewable proposals, never direct writes', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    const formatRegion = explorer.slice(explorer.indexOf('async function runFormatDocument'))
    assert.ok(formatRegion.includes('createFileChange'), 'format results must enter the change pipeline')
    assert.ok(formatRegion.includes("changesDispatch({ type: 'review-opened'"), 'format results must open a review')
    assert.ok(formatRegion.indexOf('createFileChange') < formatRegion.indexOf("changesDispatch({ type: 'review-opened'"), 'review must be created before any write path')
    assert.ok(!formatRegion.includes('writeWorkspaceTextFile'), 'format path must never write directly')
    assert.ok(formatRegion.includes('expectedRevision: result.revision'), 'proposal must carry the formatted snapshot revision')
    assert.ok(formatRegion.includes('Already formatted.'), 'identical output must report calmly without a transaction')
  })

  it('stale snapshots reject and every outcome has calm copy', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('result.revision !== startedRevision'), 'mid-format edits must reject as stale')
    assert.ok(explorer.includes('normalizeFormatterError'), 'format failures must normalize to safe copy')
    assert.ok(explorer.includes('normalizeChangeTransactionError'), 'proposal failures must keep existing copy')
    const errors = readRenderer('lib/format-error.ts')
    for (const copy of [
      'Install Prettier from Extensions to format this document.',
      'Prettier is disabled.',
      'No formatter is available for this file.'
    ]) {
      assert.ok(errors.includes(copy), `formatter boundary must carry: ${copy}`)
    }
    const api = readRenderer('lib/format-api.ts')
    assert.ok(api.includes('formatDocumentWithPrettier'), 'bridge helper must exist')
    assert.ok(!api.includes('.invoke('), 'helper must not touch IPC directly')
  })

  it('no editor redesign and no new shortcuts', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(!explorer.includes('Shift+Alt+F'), 'no keyboard shortcut is added in this pilot')
    assert.ok(explorer.includes('<EditorToolbar'), 'format must reuse the shared editor toolbar')
  })
})
