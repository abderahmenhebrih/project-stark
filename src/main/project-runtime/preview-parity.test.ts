import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isAllowedLiveReviewUrl } from '../../renderer/src/features/live-review/live-review-url'
import { isAllowedPreviewNavigation, previewPartitionForRuntime } from './runtime-preview'

/**
 * Preview policy parity (Phase J): the human iframe reviewer and
 * the worker runtime window share loopback-only semantics with one
 * documented divergence.
 *
 * - Worker preview stays approved-origin bound: exactly
 *   `http://127.0.0.1:<approvedPort>` (same scheme/host/port).
 * - Human manual Load stays loopback-only
 *   (`localhost`/`127.0.0.1`/`::1`, http(s), port required, no
 *   credentials) for the user's own dev servers — an explicit user
 *   action on their own machine, never a managed-runtime bypass
 *   (Start still binds the detected script).
 * - Both reject remote origins, LAN IPs, `file:`, `javascript:`,
 *   `data:`, custom protocols, credentialed URLs, and portless URLs.
 * - Worker-allowed URLs are always human-allowed (subset property);
 *   the reverse is intentionally false (documented above).
 * - Preview partitions stay `persist:` per runtime id: dev apps may
 *   rely on storage across preview restarts, and isolation (never
 *   shared across runtimes, no bridge, sandboxed) is what carries
 *   the security boundary — not volatility. Changing this would
 *   break required app behavior, so it stays with this record.
 */
describe('preview policy parity', () => {
  it('worker-allowed navigations are a subset of human-allowed URLs', () => {
    for (const url of ['http://127.0.0.1:5173/', 'http://127.0.0.1:5173/app?x=1#y']) {
      assert.equal(isAllowedPreviewNavigation(url, 5173), true)
      assert.equal(isAllowedLiveReviewUrl(url), true)
    }
  })

  it('human loopback extras stay worker-rejected by design', () => {
    for (const url of ['https://127.0.0.1:5173/', 'http://localhost:5173/', 'http://[::1]:5173/']) {
      assert.equal(isAllowedLiveReviewUrl(url), true, `${url} is an explicit user loopback Load`)
      assert.equal(isAllowedPreviewNavigation(url, 5173), false, `${url} never escapes the approved worker origin`)
    }
  })

  it('both reject non-loopback and dangerous schemes', () => {
    for (const url of [
      'http://example.com/',
      'https://example.com/',
      'http://192.168.1.10:5173/',
      'http://10.0.0.5:5173/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'stark://preview',
      'http://user:pass@127.0.0.1:5173/',
      'http://127.0.0.1/'
    ]) {
      assert.equal(isAllowedLiveReviewUrl(url), false, `human must reject ${url}`)
      assert.equal(isAllowedPreviewNavigation(url, 5173), false, `worker must reject ${url}`)
    }
  })

  it('worker rejects cross-port and cross-host loopback lookalikes', () => {
    assert.equal(isAllowedPreviewNavigation('http://127.0.0.1:5174/', 5173), false)
    assert.equal(isAllowedPreviewNavigation('http://localhost:5173/', 5173), false)
    assert.equal(isAllowedPreviewNavigation('https://127.0.0.1:5173/', 5173), false)
  })

  it('preview partitions isolate per runtime without sharing', () => {
    const first = previewPartitionForRuntime(42)
    const second = previewPartitionForRuntime(43)
    assert.ok(first.startsWith('persist:stark-runtime-preview-42'))
    assert.notEqual(first, second)
  })
})
