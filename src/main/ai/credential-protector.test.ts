import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ElectronSafeStorageCredentialProtector, zeroBuffer, type CredentialProtector } from './credential-protector'
import { SecureStorageUnavailableError } from './errors'

/**
 * Test-double protector: reversible toy transform, never Electron.
 * Unit suites use this (or instances like it) so secret tests never
 * require OS keychain access.
 */
export class FakeCredentialProtector implements CredentialProtector {
  private available = true
  private failDecrypt = false
  private reEncrypt = false
  decryptCalls = 0

  setAvailable(available: boolean): void {
    this.available = available
  }

  setFailDecrypt(fail: boolean): void {
    this.failDecrypt = fail
  }

  setReEncrypt(reEncrypt: boolean): void {
    this.reEncrypt = reEncrypt
  }

  async isAvailable(): Promise<boolean> {
    return this.available
  }

  async encrypt(secret: string): Promise<Buffer> {
    if (!this.available) {
      throw new SecureStorageUnavailableError()
    }
    return Buffer.from(`fake:${secret}`, 'utf8')
  }

  async decrypt(ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
    this.decryptCalls += 1
    if (!this.available) {
      throw new SecureStorageUnavailableError()
    }
    if (this.failDecrypt) {
      throw new SecureStorageUnavailableError({ cause: new Error('temporary backend failure') })
    }
    const text = ciphertext.toString('utf8')
    if (!text.startsWith('fake:')) {
      throw new SecureStorageUnavailableError({ cause: new Error('unrecognized ciphertext') })
    }
    return { secret: text.slice('fake:'.length), shouldReEncrypt: this.reEncrypt }
  }
}

describe('credential protector', () => {
  it('fake round-trips secrets without Electron', async () => {
    const protector = new FakeCredentialProtector()
    assert.equal(await protector.isAvailable(), true)
    const ciphertext = await protector.encrypt('sk-test-secret')
    assert.ok(ciphertext instanceof Buffer)
    const { secret, shouldReEncrypt } = await protector.decrypt(ciphertext)
    assert.equal(secret, 'sk-test-secret')
    assert.equal(shouldReEncrypt, false)
  })

  it('fake fails closed when unavailable', async () => {
    const protector = new FakeCredentialProtector()
    protector.setAvailable(false)
    assert.equal(await protector.isAvailable(), false)
    await assert.rejects(protector.encrypt('x'), SecureStorageUnavailableError)
    await assert.rejects(protector.decrypt(Buffer.from([1])), SecureStorageUnavailableError)
  })

  it('surfaces temporary decrypt failures distinctly', async () => {
    const protector = new FakeCredentialProtector()
    protector.setFailDecrypt(true)
    await assert.rejects(protector.decrypt(Buffer.from('fake:x', 'utf8')), SecureStorageUnavailableError)
  })

  it('honors the shouldReEncrypt rotation signal', async () => {
    const protector = new FakeCredentialProtector()
    protector.setReEncrypt(true)
    const { shouldReEncrypt } = await protector.decrypt(await protector.encrypt('rotating'))
    assert.equal(shouldReEncrypt, true)
  })

  it('zeroes temporary buffers', () => {
    const buffer = Buffer.from([1, 2, 3, 4])
    zeroBuffer(buffer)
    assert.deepEqual([...buffer], [0, 0, 0, 0])
  })

  it('production protector fails closed without Electron secrets', async () => {
    // In plain Node there is no Electron safeStorage: the production
    // implementation must report unavailable and refuse both
    // directions rather than touching any fallback.
    const protector = new ElectronSafeStorageCredentialProtector()
    assert.equal(await protector.isAvailable(), false)
    await assert.rejects(
      protector.encrypt('STARK_SAFE_STORAGE_TEST_ONLY'),
      (error: unknown) => {
        assert.ok(error instanceof SecureStorageUnavailableError)
        assert.equal(error.message, 'Secure credential storage is not available on this system.')
        return true
      }
    )
    await assert.rejects(protector.decrypt(Buffer.from([0, 1])), SecureStorageUnavailableError)
  })
})
