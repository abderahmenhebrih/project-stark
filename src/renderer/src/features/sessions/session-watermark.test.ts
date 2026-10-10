import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Empty-session STARK watermark guarantees: a truly empty active
 * conversation shows the official wordmark as a faint inert
 * background mark inside the Session pane only; any conversation
 * content hides it. The composer stays above and interactable.
 * Runs against repository source (cwd is the repo root via npm).
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

function watermarkCondition(): string {
  const panel = readRenderer('features/sessions/SessionPanel.tsx')
  const start = panel.indexOf('const conversationEmpty =')
  assert.ok(start >= 0, 'watermark visibility rule must exist')
  return panel.slice(start, start + 1100)
}

describe('official wordmark reuse', () => {
  it('renders the real STARK wordmark asset, no fake logo', () => {
    const assets = readRenderer('components/brandAssets.ts')
    assert.ok(assets.includes('starkword.png'), 'official wordmark asset must exist')
    assert.ok(assets.includes('STARK_WORDMARK_URL'), 'wordmark URL export must exist')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('STARK_WORDMARK_URL'), 'empty state must reuse the official wordmark')
    assert.ok(panel.includes('className="session__watermark"'), 'watermark must carry its own class')
    const imgAt = panel.indexOf('session__watermark')
    const imgBlock = panel.slice(Math.max(0, imgAt - 200), imgAt + 300)
    assert.ok(imgBlock.includes('<img'), 'watermark must be an image element')
    assert.ok(!imgBlock.includes('>STARK<'), 'watermark must not be CSS/text fake branding')
    const css = readRenderer('features/sessions/session.css')
    const rule = css.match(/\.session__watermark\s*\{[^}]*\}/)
    assert.ok(rule !== null, 'watermark CSS must exist')
    assert.ok(!rule[0].includes('content:'), 'watermark must not be a generated-content trick')
  })

  it('matches the asset AppChrome already uses', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('STARK_WORDMARK_URL'), 'AppChrome must use the same official wordmark')
  })
})

describe('watermark visibility', () => {
  it('shows only for a truly empty active session', () => {
    const condition = watermarkCondition()
    assert.ok(condition.includes('state.messages.length === 0'), 'any message must hide the watermark')
    assert.ok(condition.includes('!state.loadingMessages'), 'loading must not flash the mark')
    assert.ok(condition.includes('state.messagesError === null'), 'errors must not sit behind the mark')
    assert.ok(condition.includes('!state.generating'), 'generation must hide the mark')
    assert.ok(condition.includes('!state.sending'), 'an in-flight send must hide the mark')
    assert.ok(condition.includes('!proposal.preparing'), 'proposal preparation must hide the mark')
    assert.ok(condition.includes('proposal.result === null'), 'proposal content must hide the mark')
    assert.ok(condition.includes('proposal.changeSet === null'), 'change-set content must hide the mark')
    assert.ok(condition.includes('work.run === null'), 'run content must hide the mark')
    assert.ok(condition.includes('looplink.looplink === null'), 'continuity content must hide the mark')
    assert.ok(condition.includes('recovery.event === null'), 'recovery content must hide the mark')
    assert.ok(condition.includes('pendingApproval === null'), 'approval content must hide the mark')
    assert.ok(condition.includes('runtime.active === null'), 'runtime content must hide the mark')
  })

  it('draft-only sessions may still display it', () => {
    const condition = watermarkCondition()
    assert.ok(!condition.includes('composer'), 'unsent composer text must not hide the mark')
    assert.ok(!condition.includes('attachments'), 'staged drafts must not hide the mark')
  })

  it('derives from the active session so tab switches update it', () => {
    const condition = watermarkCondition()
    assert.ok(condition.includes('state.messages'), 'rule must read the selection-scoped message list')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('{conversationEmpty && ('), 'watermark must render conditionally')
  })

  it('is inert and hidden from assistive tech', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const imgAt = panel.indexOf('session__watermark')
    const imgBlock = panel.slice(Math.max(0, imgAt - 200), imgAt + 300)
    assert.ok(imgBlock.includes('aria-hidden="true"'), 'watermark must be aria-hidden')
    assert.ok(imgBlock.includes('alt=""'), 'watermark must carry empty alt')
    assert.ok(imgBlock.includes('draggable={false}'), 'watermark must not be draggable')
    const css = readRenderer('features/sessions/session.css')
    const rule = css.match(/\.session__watermark\s*\{[^}]*\}/)
    assert.ok(rule !== null && rule[0].includes('pointer-events: none'), 'watermark must never capture clicks')
    assert.ok(rule[0].includes('user-select: none'), 'watermark must not be selectable')
  })

  it('stays faint, contained, and layered below content', () => {
    const css = readRenderer('features/sessions/session.css')
    const rule = css.match(/\.session__watermark\s*\{[^}]*\}/)
    assert.ok(rule !== null, 'watermark CSS must exist')
    const opacity = rule[0].match(/opacity:\s*([\d.]+)/)
    assert.ok(opacity !== null, 'watermark must declare an opacity')
    const value = Number(opacity[1])
    assert.ok(value >= 0.025 && value <= 0.06, `opacity must sit 0.025–0.06, got ${value}`)
    assert.ok(rule[0].includes('position: absolute'), 'watermark must layer inside the message area')
    assert.ok(rule[0].includes('width: min(100% - 64px, 560px)'), 'watermark must scale with its container')
    assert.ok(rule[0].includes('z-index: 0'), 'watermark must sit behind content')
    assert.ok(css.includes('.session__messages > *:not(.session__watermark)'), 'message content must layer above the mark')
  })

  it('lives in the Session pane only, below the composer', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const messagesAt = panel.indexOf('className="session__messages"')
    const markAt = panel.indexOf('session__watermark')
    const composerAt = panel.indexOf('session__composer--${')
    assert.ok(messagesAt >= 0 && markAt > messagesAt && composerAt > markAt, 'mark must sit inside the messages area, above the composer in source order')
    assert.ok(!panel.includes('WorkspaceSecondaryPane') || panel.indexOf('session__watermark') < panel.length, 'mark must not target the editor pane')
    const css = readRenderer('features/sessions/session.css')
    const messages = css.match(/\.session__messages\s*\{[^}]*\}/)
    assert.ok(messages !== null && messages[0].includes('position: relative'), 'messages area must bound the mark')
  })
})
