import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CredentialProtector } from '../ai/credential-protector'
import {
  parseSessionEnvelope,
  serializeSessionEnvelope,
  SessionProtector,
  validateSessionEnvelope
} from './cloud-auth-session-store'
import type { CloudSessionEnvelope } from './cloud-account-types'

function envelope(): CloudSessionEnvelope {
  return { accessToken: 'ACCESS_SECRET_123', refreshToken: 'REFRESH_SECRET_456', expiresAt: null, userId: 'user-1' }
}

class ObscuringProtector implements CredentialProtector {
  constructor(private readonly available: boolean = true) {}
  async isAvailable(): Promise<boolean> {
    return this.available
  }
  async encrypt(secret: string): Promise<Buffer> {
    // Obscure so the ciphertext never literally contains the secret.
    return Buffer.from(`fake-enc:${Buffer.from(secret, 'utf8').toString('base64')}`, 'utf8')
  }
  async decrypt(ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
    const text = ciphertext.toString('utf8')
    assert.ok(text.startsWith('fake-enc:'))
    return { secret: Buffer.from(text.slice('fake-enc:'.length), 'base64').toString('utf8'), shouldReEncrypt: false }
  }
}

describe('encrypted session envelope', () => {
  it('validates strict shape and rejects extras', () => {
    validateSessionEnvelope(envelope())
    assert.throws(() => validateSessionEnvelope({ ...envelope(), extra: 1 }))
    assert.throws(() => validateSessionEnvelope({ accessToken: '', refreshToken: 'r', expiresAt: null, userId: 'u' }))
    assert.throws(() => validateSessionEnvelope(null))
  })

  it('round-trips serialize/parse exactly', () => {
    const parsed = parseSessionEnvelope(serializeSessionEnvelope(envelope()))
    assert.deepEqual(parsed, envelope())
  })

  it('seal/open round-trips when secure storage is available', async () => {
    const protector = new SessionProtector(new ObscuringProtector(true))
    const sealed = await protector.seal(envelope())
    assert.ok(!sealed.toString('utf8').includes('ACCESS_SECRET_123'))
    const opened = await protector.open(sealed)
    assert.deepEqual(opened, envelope())
  })

  it('fails closed when secure storage is unavailable', async () => {
    const protector = new SessionProtector(new ObscuringProtector(false))
    await assert.rejects(() => protector.seal(envelope()), /cloud-auth-secure-storage-unavailable/)
    await assert.rejects(() => protector.open(Buffer.from('anything')), /cloud-auth-secure-storage-unavailable/)
  })

  it('treats corrupt ciphertext as an exchange failure, never plaintext', async () => {
    class Corrupt implements CredentialProtector {
      async isAvailable(): Promise<boolean> {
        return true
      }
      async encrypt(secret: string): Promise<Buffer> {
        void secret
        return Buffer.from('x')
      }
      async decrypt(_ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
        void _ciphertext
        return { secret: 'not-json{{{', shouldReEncrypt: false }
      }
    }
    const protector = new SessionProtector(new Corrupt())
    await assert.rejects(() => protector.open(Buffer.from('x')), /cloud-auth-exchange-failed/)
  })
})
