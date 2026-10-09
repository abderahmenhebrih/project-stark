import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { gitStatusLetter } from './git-state'

/**
 * STAGE 31 FIX 07 — Git source-control visual polish.
 *
 * Static presentation guarantees (CSS/markup structure) plus pure unit
 * coverage for the compact status-letter helper. Behavior and Stage 12
 * read-only security are unchanged: no mutations, no network, no
 * polling, manual refresh only.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('git polish status letters', () => {
  it('maps staged index codes to compact indicators', () => {
    assert.deepEqual(
      gitStatusLetter({ conflicted: false, untracked: false, indexStatus: 'M', worktreeStatus: ' ', side: 'staged' }),
      { letter: 'M', tone: 'modified' }
    )
    assert.deepEqual(
      gitStatusLetter({ conflicted: false, untracked: false, indexStatus: 'A', worktreeStatus: ' ', side: 'staged' }),
      { letter: 'A', tone: 'added' }
    )
    assert.deepEqual(
      gitStatusLetter({ conflicted: false, untracked: false, indexStatus: 'D', worktreeStatus: ' ', side: 'staged' }),
      { letter: 'D', tone: 'deleted' }
    )
  })

  it('maps working-tree codes and untracked/conflict states', () => {
    assert.deepEqual(
      gitStatusLetter({ conflicted: false, untracked: false, indexStatus: ' ', worktreeStatus: 'M', side: 'working' }),
      { letter: 'M', tone: 'modified' }
    )
    assert.deepEqual(
      gitStatusLetter({ conflicted: false, untracked: true, indexStatus: '?', worktreeStatus: '?', side: 'working' }),
      { letter: '?', tone: 'untracked' }
    )
    assert.deepEqual(
      gitStatusLetter({ conflicted: true, untracked: false, indexStatus: 'U', worktreeStatus: 'U', side: 'working' }),
      { letter: '!', tone: 'conflict' }
    )
  })
})

describe('git polish presentation', () => {
  it('header is compact with icon-only refresh and no fetch wording', () => {
    const panel = readRenderer('features/git/GitPanel.tsx')
    assert.ok(panel.includes('git-panel__refresh'), 'refresh must be a compact icon control')
    assert.ok(panel.includes('aria-label="Refresh Git status"'), 'refresh must carry its tooltip label')
    assert.ok(panel.includes('name="refresh"'), 'refresh must use the local SVG icon set')
    assert.ok(!panel.includes('>Refresh<'), 'oversized text Refresh button must be gone')
    assert.ok(!panel.includes('fetch(') && !panel.includes('pull') && !panel.includes('push'), 'no network operations may appear')
    const css = readRenderer('features/git/git.css')
    const title = css.match(/\.git-panel__title\s*\{[^}]*\}/)
    assert.ok(title !== null && title[0].includes('font-size: 13px'), 'heading must be 13–14px UI sans')
  })

  it('branch and upstream read with hierarchy on local refs only', () => {
    const panel = readRenderer('features/git/GitPanel.tsx')
    assert.ok(panel.includes('git-panel__branch-name'), 'branch name must sit on its own icon line')
    assert.ok(panel.includes('git-panel__meta'), 'upstream metadata must sit beneath in muted text')
    assert.ok(panel.includes('Local branch · no upstream'), 'missing upstream must read quiet and local')
    assert.ok(panel.includes('local refs only') || panel.includes('Local refs only'), 'local-only wording must survive')
  })

  it('changes group by parser semantics with counts', () => {
    const panel = readRenderer('features/git/GitPanel.tsx')
    for (const group of ['Staged', 'Modified', 'Untracked']) {
      assert.ok(panel.includes(`>${group}<`), `${group} section must exist`)
    }
    assert.ok(panel.includes('git-panel__group-count'), 'section counts must render inline')
    assert.ok(panel.includes('entry.staged') && panel.includes('entry.unstaged') && panel.includes('entry.untracked'), 'groups must derive from parser flags only')
  })

  it('file rows use icons plus compact status marks, never pills or magenta', () => {
    const panel = readRenderer('features/git/GitPanel.tsx')
    assert.ok(panel.includes('FILE_ICON_URLS[getFileIconKind'), 'rows must reuse the local file-icon mapping')
    assert.ok(panel.includes('git-panel__status-mark'), 'compact status indicator must replace pills')
    assert.ok(!panel.includes('git-panel__badge'), 'large repeated pills must be gone')
    assert.ok(!panel.includes('Working M'), 'diagnostic Working M pills must be gone')
    const css = readRenderer('features/git/git.css')
    assert.ok(!css.includes('.git-panel__badge'), 'dead pill CSS must be removed')
    assert.ok(!css.includes('--stark-magenta'), 'magenta must not enter the Git surface')
    const row = css.match(/\.git-panel__row\s*\{[^}]*\}/)
    assert.ok(row !== null && row[0].includes('min-height: 30px'), 'rows must be 30–32px tall')
  })

  it('read-only wiring is preserved with no mutation actions', () => {
    const panel = readRenderer('features/git/GitPanel.tsx')
    assert.ok(panel.includes("onSelectDiff(entry.relativePath, 'staged')"), 'staged rows must open staged diffs')
    assert.ok(panel.includes("onSelectDiff(entry.relativePath, 'unstaged')"), 'working rows must open unstaged diffs')
    assert.ok(panel.includes('onOpenFile(entry.relativePath)'), 'untracked rows must open files')
    for (const forbidden of ['stage(', 'unstage(', 'commit(', 'checkout(', 'onPush', 'onPull', 'onFetch', 'reset(', 'discard(']) {
      assert.ok(!panel.includes(forbidden), `no mutation action may appear (${forbidden})`)
    }
    assert.ok(!panel.includes('setInterval') && !panel.includes('setTimeout'), 'manual refresh only — no timers')
  })

  it('clean and unavailable states stay calm with existing wording', () => {
    const panel = readRenderer('features/git/GitPanel.tsx')
    assert.ok(panel.includes('Working tree clean'), 'clean state must stay calm')
    assert.ok(panel.includes('Git is not available on this system.'), 'unavailable wording must be preserved')
    assert.ok(panel.includes('No Git repository detected.'), 'not-repository wording must be preserved')
  })
})
