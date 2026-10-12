import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Live Review lifecycle guarantees: the Lovable-style working preview
 * workflow — detect, Start, Running with HMR, Refresh, Restart, Stop —
 * over the exact STARK-owned process, with loopback-only embedding
 * and honest states. Session stays mounted beside the preview.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('live review lifecycle', () => {
  it('drives start/stop/refresh/restart/close through owned-process bridges', () => {
    const panel = readRenderer('features/live-review/LiveReviewPanel.tsx')
    for (const label of ['aria-label="Start preview"', 'aria-label="Stop preview"', 'aria-label="Refresh preview"', 'aria-label="Restart preview"', 'aria-label="Close Live Review"']) {
      assert.ok(panel.includes(label), `panel must offer ${label}`)
    }
    assert.ok(panel.includes('startHumanPreview'), 'start must use the human preview bridge')
    assert.ok(panel.includes('stopHumanPreview'), 'stop must use the human preview bridge')
    assert.ok(panel.includes('restartHumanPreview'), 'restart must use the human preview bridge')
    assert.ok(!panel.includes('openRuntimePreview'), 'in-window preview must not open side windows')
  })

  it('renders honest lifecycle states with script and URL context', () => {
    const panel = readRenderer('features/live-review/LiveReviewPanel.tsx')
    for (const copy of ['Starting preview…', 'Preview process is running, but STARK could not detect its URL.', 'Running', 'Preview failed', 'Preview stopped', 'External local server', 'Idle']) {
      assert.ok(panel.includes(copy), `panel must render state ${copy}`)
    }
    assert.ok(panel.includes('No runnable preview script was found'), 'scriptless projects must read honestly')
    assert.ok(panel.includes('no-package-json'), 'missing manifests must read honestly')
  })

  it('refreshes without restarting and restarts through the owned runtime', () => {
    const panel = readRenderer('features/live-review/LiveReviewPanel.tsx')
    assert.ok(panel.includes('keeps the server running'), 'refresh copy must promise no restart')
    assert.ok(panel.includes('setFrameKey((key) => key + 1)'), 'refresh must reload the frame only')
    assert.ok(panel.includes('restarts the owned server'), 'restart copy must name the owned server')
  })

  it('never kills servers STARK does not own', () => {
    const panel = readRenderer('features/live-review/LiveReviewPanel.tsx')
    assert.ok(panel.includes('STARK did not start it and will not stop it'), 'external servers must read as untouchable')
    // Stop/restart controls exist only for the owned human preview.
    assert.ok(panel.includes('if (!humanOwned)'), 'stop/restart must guard on ownership')
  })

  it('bounds runtime logs in an expandable section', () => {
    const panel = readRenderer('features/live-review/LiveReviewPanel.tsx')
    assert.ok(panel.includes('Runtime logs'), 'expandable logs section must exist')
    assert.ok(panel.includes('.slice(-4000)'), 'rendered logs must stay bounded')
    assert.ok(panel.includes('older output truncated'), 'truncation must be disclosed')
  })

  it('keeps the HMR-compatible loopback embed contract', () => {
    const panel = readRenderer('features/live-review/LiveReviewPanel.tsx')
    assert.ok(panel.includes('allow-scripts allow-same-origin'), 'dev-server HMR needs scripts + same-origin')
    assert.ok(!panel.includes('<webview'), 'Electron webview stays forbidden')
    assert.ok(panel.includes('subscribeHumanPreviewUpdates'), 'updates must stream from main (no polling)')
    assert.ok(!panel.includes('setInterval'), 'no polling may exist')
  })

  it('accepts manual loopback URLs and rejects the rest', () => {
    const panel = readRenderer('features/live-review/LiveReviewPanel.tsx')
    assert.ok(panel.includes('loadManualUrl'), 'manual entry path must exist')
    assert.ok(panel.includes('isAllowedLiveReviewUrl'), 'manual URLs must pass the loopback policy')
    assert.ok(panel.includes('liveReviewUrlError'), 'rejections must use concise copy')
  })

  it('reuses an already-running runtime instead of spawning again', () => {
    const panel = readRenderer('features/live-review/LiveReviewPanel.tsx')
    assert.ok(panel.includes('getHumanPreview'), 'mount must adopt a running preview')
    assert.ok(panel.includes('initialUrl'), 'a known managed-runtime URL must be usable')
    assert.ok(panel.includes('Running (managed runtime)'), 'adopted runtimes must read honestly')
  })
})
