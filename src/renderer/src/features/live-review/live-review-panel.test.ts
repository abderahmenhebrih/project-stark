import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Live Review guarantees: a real integrated localhost reviewer in
 * the secondary workspace pane — sandboxed iframe (never webview),
 * loopback-only URLs, explicit pane ownership, bounded failures,
 * and no AI capability auto-grant.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

/** Source with line/block comments removed, so assertions test code — not prose. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

describe('live review embedding', () => {
  it('embeds via a sandboxed iframe, never webview', () => {
    const panel = readRenderer('features/live-review/LiveReviewPanel.tsx')
    const code = codeOnly(panel)
    assert.ok(code.includes('<iframe'), 'preview must use a renderer-native iframe')
    assert.ok(code.includes('sandbox='), 'iframe must be sandboxed')
    assert.ok(code.includes('allow-scripts'), 'sandbox must allow dev-server scripts (HMR)')
    assert.ok(!code.includes('<webview'), 'Electron webview is forbidden')
    assert.ok(!code.includes('preload'), 'preview must never gain preload bridge access')
  })

  it('adds no generic URL IPC and no external-open bypass', () => {
    const code = codeOnly(readRenderer('features/live-review/LiveReviewPanel.tsx'))
    for (const forbidden of ['ipcRenderer', '.invoke(', 'shell.openExternal', 'window.open']) {
      assert.ok(!code.includes(forbidden), `panel must not contain ${forbidden}`)
    }
    for (const secret of ['apiKey', 'Authorization', 'stark-session', 'getStarkApi']) {
      assert.ok(!code.includes(secret), `preview content must never reach ${secret}`)
    }
  })

  it('validates loopback URLs and fails boundedly with concise copy', () => {
    const panel = readRenderer('features/live-review/LiveReviewPanel.tsx')
    assert.ok(panel.includes('isAllowedLiveReviewUrl'), 'URL entry must pass the loopback policy')
    assert.ok(panel.includes('liveReviewUrlError'), 'rejections must use concise copy')
    assert.ok(panel.includes('Nothing is running at'), 'connection failure must read as a calm notice')
    assert.ok(!panel.includes('setInterval') && !panel.includes('setTimeout'), 'no polling or retry timers')
    assert.ok(panel.includes('aria-label="Localhost URL"'), 'URL input must be labelled')
    assert.ok(panel.includes('aria-label="Refresh preview"'), 'refresh must be labelled')
    assert.ok(panel.includes('aria-label="Close Live Review"'), 'close must be labelled')
  })

  it('grants no AI inspection permission when opened', () => {
    const code = codeOnly(readRenderer('features/live-review/LiveReviewPanel.tsx'))
    for (const capability of ['preview_inspect', 'previewInspect', 'capabilit', 'approveWorkerApproval']) {
      assert.ok(!code.includes(capability), `human preview must not touch ${capability}`)
    }
  })
})

describe('live review pane ownership', () => {
  it('joins the secondary pane as an explicit Live tab', () => {
    const pane = readRenderer('features/workspace/WorkspaceSecondaryPane.tsx')
    assert.ok(pane.includes("'live'"), 'secondary pane must know the live tab kind')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes("type: 'open-live'"), 'explicit open-live action must exist')
    assert.ok(explorer.includes("type: 'close-live'"), 'close-live action must exist')
    assert.ok(explorer.includes("label: 'Live Review'"), 'Live Review tab must be labelled')
  })

  it('explicit Live Review click wins; background updates never steal it', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    const openEffect = explorer.slice(explorer.indexOf('externalLiveReviewRequest === consumedLiveReviewRequestRef.current'))
    assert.ok(openEffect.includes("secondaryUiDispatch({ type: 'open-live' })"), 'explicit request must open the Live tab')
    const dispatches = explorer.match(/secondaryUiDispatch\(\{ type: 'open-live' \}\)/g) ?? []
    assert.equal(dispatches.length, 1, 'exactly one explicit path opens Live Review (no background steal)')
    assert.ok(explorer.includes('key={externalLiveReviewRequest}'), 'each request must remount with its captured URL')
  })

  it('close works and restores the previous sensible surface', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes("secondaryUiDispatch({ type: 'close-live' })"), 'close-live must exist')
    assert.ok(explorer.includes("tab: state.tab === 'live' ? 'context' : state.tab"), 'closing Live Review must fall back to Context')
  })

  it('session stays visible beside the preview on desktop', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('{sessionNode}'), 'session pane must stay mounted with the secondary pane open')
  })
})
