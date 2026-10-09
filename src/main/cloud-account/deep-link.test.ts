import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractDeepLinkFromArgv, parseAuthCallbackUrl } from './deep-link'

describe('auth deep-link callback security', () => {
  it('accepts the exact stark://auth/callback with a code', () => {
    const parsed = parseAuthCallbackUrl('stark://auth/callback?code=CODE_SECRET_789')
    assert.equal(parsed.code, 'CODE_SECRET_789')
  })

  it('accepts an optional bounded state parameter', () => {
    const parsed = parseAuthCallbackUrl('stark://auth/callback?code=abc&state=xyz')
    assert.equal(parsed.code, 'abc')
    assert.equal(parsed.state, 'xyz')
  })

  it('rejects wrong hosts and paths', () => {
    for (const url of [
      'stark://evil/callback?code=abc',
      'stark://auth/other?code=abc',
      'stark://auth/callback/extra?code=abc',
      'stark://auth?code=abc'
    ]) {
      assert.throws(() => parseAuthCallbackUrl(url), /cloud-auth-callback-invalid/)
    }
  })

  it('rejects foreign schemes', () => {
    for (const url of [
      'http://auth/callback?code=abc',
      'https://auth/callback?code=abc',
      'file:///auth/callback?code=abc',
      'javascript:alert(1)',
      'stark2://auth/callback?code=abc'
    ]) {
      assert.throws(() => parseAuthCallbackUrl(url), /cloud-auth-callback-invalid/)
    }
  })

  it('rejects credentials in authority and fragment payloads', () => {
    assert.throws(() => parseAuthCallbackUrl('stark://user:pass@auth/callback?code=abc'), /cloud-auth-callback-invalid/)
    assert.throws(() => parseAuthCallbackUrl('stark://auth/callback?code=abc#fragment'), /cloud-auth-callback-invalid/)
  })

  it('rejects missing code, empty code, and unexpected parameters', () => {
    assert.throws(() => parseAuthCallbackUrl('stark://auth/callback'), /cloud-auth-callback-invalid/)
    assert.throws(() => parseAuthCallbackUrl('stark://auth/callback?code='), /cloud-auth-callback-invalid/)
    assert.throws(() => parseAuthCallbackUrl('stark://auth/callback?state=only'), /cloud-auth-callback-invalid/)
    assert.throws(() => parseAuthCallbackUrl('stark://auth/callback?code=abc&evil=1'), /cloud-auth-callback-invalid/)
    assert.throws(() => parseAuthCallbackUrl('stark://auth/callback?code=abc&token=xyz'), /cloud-auth-callback-invalid/)
  })

  it('rejects oversized URLs and parameters', () => {
    const big = `stark://auth/callback?code=${'a'.repeat(5000)}`
    assert.throws(() => parseAuthCallbackUrl(big), /cloud-auth-callback-invalid/)
    assert.throws(() => parseAuthCallbackUrl(''), /cloud-auth-callback-invalid/)
    assert.throws(() => parseAuthCallbackUrl(123), /cloud-auth-callback-invalid/)
  })

  it('extracts stark:// URLs from second-instance argv', () => {
    assert.equal(
      extractDeepLinkFromArgv(['stark.exe', 'stark://auth/callback?code=abc']),
      'stark://auth/callback?code=abc'
    )
    assert.equal(extractDeepLinkFromArgv(['stark.exe', '--other']), null)
    assert.equal(extractDeepLinkFromArgv([]), null)
  })
})
