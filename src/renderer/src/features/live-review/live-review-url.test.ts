import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isAllowedLiveReviewUrl, liveReviewUrlError, normalizeLiveReviewInput } from './live-review-url'

describe('live review localhost policy: allow', () => {
  it('allows loopback http(s) URLs with explicit ports', () => {
    for (const url of [
      'http://localhost:3000',
      'https://localhost:3000/app',
      'http://localhost:5173/?q=1#hash',
      'http://127.0.0.1:8080',
      'https://127.0.0.1:8443/path',
      'http://[::1]:3000',
      'https://[::1]:8443/x'
    ]) {
      assert.ok(isAllowedLiveReviewUrl(url), `${url} must be allowed`)
    }
  })

  it('normalizes schemeless localhost input to http', () => {
    assert.equal(normalizeLiveReviewInput('localhost:3000'), 'http://localhost:3000')
    assert.ok(isAllowedLiveReviewUrl(normalizeLiveReviewInput('localhost:3000')))
    assert.equal(normalizeLiveReviewInput('  http://localhost:3000  '), 'http://localhost:3000')
  })
})

describe('live review localhost policy: reject', () => {
  it('rejects remote domains and LAN IPs (no SSRF surface)', () => {
    for (const url of [
      'http://example.com:3000',
      'https://myapp.local:3000',
      'http://192.168.1.10:3000',
      'http://10.0.0.5:3000',
      'http://172.16.0.2:3000',
      'http://0.0.0.0:3000',
      'http://localhost.evil.com:3000'
    ]) {
      assert.ok(!isAllowedLiveReviewUrl(url), `${url} must be rejected`)
    }
  })

  it('rejects non-http schemes and missing ports', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'blob:http://localhost:3000/x',
      'ftp://localhost:21/x',
      'custom://localhost:3000',
      'http://localhost',
      'http://localhost:/x',
      '',
      '   ',
      'not a url'
    ]) {
      assert.ok(!isAllowedLiveReviewUrl(url), `${JSON.stringify(url)} must be rejected`)
    }
  })

  it('rejects out-of-range ports', () => {
    assert.ok(!isAllowedLiveReviewUrl('http://localhost:0'))
    assert.ok(!isAllowedLiveReviewUrl('http://localhost:99999'))
  })

  it('explains rejections with concise copy (no stack traces)', () => {
    assert.ok(liveReviewUrlError('').includes('localhost'))
    assert.ok(liveReviewUrlError('file:///x').includes('http'))
    assert.ok(liveReviewUrlError('http://example.com:3000').includes('localhost'))
  })
})
