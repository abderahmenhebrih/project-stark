import { safeStorage } from 'electron'
import { SecureStorageUnavailableError } from './errors'
import { SAFE_STORAGE_TIMEOUT_MS } from './limits'

/**
 * OS-backed credential protection (Stage 14).
 *
 * The interface is the seam that keeps Electron-native secret APIs
 * out of ordinary Node unit tests: production uses
 * `ElectronSafeStorageCredentialProtector`, tests use fakes. Only
 * opaque ciphertext crosses into SQLite; plaintext only exists
 * transiently inside main-process memory around a provider call.
 *
 * Memory note: decrypted secrets are held as JavaScript strings,
 * which cannot be reliably zeroed — callers must drop references
 * immediately after use. Temporary encoded Buffers are zeroed where
 * practical (see `zeroBuffer`).
 */

/** Zeroes a temporary buffer's bytes in place. Best effort. */
export function zeroBuffer(buffer: Buffer): void {
  buffer.fill(0)
}

export interface DecryptResult {
  readonly secret: string
  readonly shouldReEncrypt: boolean
}

export interface CredentialProtector {
  /** Whether the OS can hold credentials persistently right now. */
  isAvailable(): Promise<boolean>
  /** Encrypts a secret into opaque ciphertext for storage. */
  encrypt(secret: string): Promise<Buffer>
  /**
   * Decrypts stored ciphertext. `shouldReEncrypt` follows the
   * safeStorage key-rotation contract: callers must re-encrypt and
   * replace the stored bytes when true.
   */
  decrypt(ciphertext: Buffer): Promise<DecryptResult>
}

function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bounded = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`secure storage ${label} timed out`))
    }, SAFE_STORAGE_TIMEOUT_MS)
  })
  return Promise.race([operation, bounded]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  })
}

/**
 * Production protector over Electron safeStorage. MAIN PROCESS ONLY,
 * and only after `app.whenReady()` — every method fails closed (never
 * plaintext) when encryption is unavailable, when the call happens too
 * early, or when Linux reports the insecure `basic_text` backend.
 * `setUsePlainTextEncryption(true)` is never called anywhere.
 */
export class ElectronSafeStorageCredentialProtector implements CredentialProtector {
  async isAvailable(): Promise<boolean> {
    try {
      const storage = safeStorage
      if (storage === undefined || storage === null) {
        return false
      }
      if (typeof storage.getSelectedStorageBackend === 'function') {
        if (storage.getSelectedStorageBackend() === 'basic_text') {
          return false
        }
      }
      if (typeof storage.isAsyncEncryptionAvailable === 'function') {
        return await withTimeout(storage.isAsyncEncryptionAvailable(), 'availability check')
      }
      return storage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  async encrypt(secret: string): Promise<Buffer> {
    if (!(await this.isAvailable())) {
      throw new SecureStorageUnavailableError()
    }
    const ciphertext = await withTimeout(safeStorage.encryptStringAsync(secret), 'encryption')
    return Buffer.from(ciphertext)
  }

  async decrypt(ciphertext: Buffer): Promise<DecryptResult> {
    if (!(await this.isAvailable())) {
      throw new SecureStorageUnavailableError()
    }
    const outcome = await withTimeout(safeStorage.decryptStringAsync(Buffer.from(ciphertext)), 'decryption')
    return { secret: outcome.result, shouldReEncrypt: outcome.shouldReEncrypt }
  }
}
