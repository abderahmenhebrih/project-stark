import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { ExtensionHostManager } from './extension-host-manager'
import { ExtensionHostError } from './errors'
import {
  buildHostPayloadMessage,
  parseHostPayloadMessage
} from './protocol'
import {
  EXTENSION_INSTALL_MANIFEST_NAME,
  validatedInstallIdentity,
  type ValidatedInstallIdentity
} from '../extension-install/extension-install-service'
import { readExtensionEnabledStates, extensionStateKey } from '../extension-install/extension-state'
import { readNormalizedManifest, requireSupportedExtensionKind, isDeclarativeOnlyManifest, type NormalizedExtensionManifest } from './extension-manifest'
import { resolveExtensionEntrypoint, verifyExtensionDirContained } from './extension-entrypoint'
import { ExtensionActivationError } from './extension-activation-errors'

/**
 * Generic extension-activation service (Step 7, main-side).
 *
 * Demand-driven only: explicit `activateExtension(identity)` calls
 * from STARK features (Format Document, future command invocation)
 * are the ONLY trigger. Enabled means "allowed to activate", never
 * "running" — there is no startup sweep, no `for (enabled)
 * activate()`, no `*` auto-activation. Manifest `activationEvents`
 * are parsed and recorded but never trigger background execution.
 *
 * Verification order per request (fail closed, renderer supplies
 * identity only — never paths):
 *   installed (install record, source `open-vsx`) →
 *   enabled (state file, missing defaults true) →
 *   manifest valid + identity-matching (data only) →
 *   kind supported (`main` present; `browser`-only rejected) →
 *   entrypoint contained + regular file →
 *   host ready on demand →
 *   single bounded ACTIVATE_EXTENSION flight (10s, no retry).
 *
 * The host re-verifies containment + identity from disk regardless;
 * main never imports extension code (only the host imports the
 * verified file URL). Deactivation is bounded at 5s with exact-host
 * stop as the hang fallback.
 */

/** Activation bound (import + register). */
export const EXTENSION_ACTIVATION_TIMEOUT_MS = 10_000

/** Deactivation bound (bounded deactivate() + disposal). */
export const EXTENSION_DEACTIVATION_TIMEOUT_MS = 5_000

/** Maximum install-record bytes read as data. */
const INSTALL_RECORD_MAX_BYTES = 1024 * 1024

export interface ExtensionActivationResult {
  readonly extensionId: string
  readonly displayName: string
}

interface PendingWaiter {
  readonly resolve: (value: never) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface ExtensionActivationServiceOptions {
  readonly manager: ExtensionHostManager
  readonly installService: { listInstalled(): Promise<readonly { namespace: string; name: string; version: string; displayName: string; enabled: boolean }[]> }
  /** Main-owned `<userData>/extensions` directory (never renderer-supplied). */
  readonly installRoot: string
  readonly activationTimeoutMs?: number
  readonly deactivationTimeoutMs?: number
}

export function extensionInstanceId(identity: ValidatedInstallIdentity): string {
  return `${identity.namespace}.${identity.name}@${identity.version}`
}

export class ExtensionActivationService {
  private readonly manager: ExtensionHostManager
  private readonly installService: ExtensionActivationServiceOptions['installService']
  private readonly installRoot: string
  private readonly activationTimeoutMs: number
  private readonly deactivationTimeoutMs: number
  private readonly active = new Map<string, { displayName: string }>()
  private readonly activationFlights = new Map<string, Promise<ExtensionActivationResult>>()
  private readonly deactivationFlights = new Map<string, Promise<boolean>>()
  private readonly pending = new Map<string, PendingWaiter>()
  private readonly unsubscribe: () => void

  constructor(options: ExtensionActivationServiceOptions) {
    this.manager = options.manager
    this.installService = options.installService
    this.installRoot = options.installRoot
    this.activationTimeoutMs = options.activationTimeoutMs ?? EXTENSION_ACTIVATION_TIMEOUT_MS
    this.deactivationTimeoutMs = options.deactivationTimeoutMs ?? EXTENSION_DEACTIVATION_TIMEOUT_MS
    this.unsubscribe = this.manager.onHostEvent((event) => {
      if (event.kind === 'exit') {
        this.failAllPending(new ExtensionActivationError('host-unavailable', 'The Extension Host is unavailable.'))
        this.activationFlights.clear()
        this.deactivationFlights.clear()
        this.active.clear()
        return
      }
      const parsed = parseHostPayloadMessage(event.raw)
      if (parsed === null) {
        return
      }
      if (parsed.type === 'EXTENSION_ACTIVATED') {
        this.settle(`activate:${parsed.payload.activationId}`, null, parsed.payload)
        return
      }
      if (parsed.type === 'EXTENSION_DEACTIVATED') {
        this.settle(`deactivate:${parsed.payload.activationId}`, null, parsed.payload)
        return
      }
      if (parsed.type === 'EXTENSION_ACTIVATION_ERROR') {
        const error = activationErrorFromHostCode(parsed.payload.code, parsed.payload.unsupportedApi)
        this.settle(`activate:${parsed.payload.activationId}`, error, null)
      }
    })
  }

  /** Detaches the host subscription (shutdown/test teardown only). */
  dispose(): void {
    this.unsubscribe()
  }

  /** Currently active extension instance ids (main-known, bounded). */
  listActive(): readonly string[] {
    return [...this.active.keys()]
  }

  /** Whether main knows an instance as currently active. */
  isActive(identity: ValidatedInstallIdentity): boolean {
    return this.active.has(extensionInstanceId(identity))
  }

  /**
   * Activates one installed + enabled extension by identity.
   * One flight per instance id; concurrent duplicates share it.
   * No retry, no polling, no recursive activation.
   */
  async activateExtension(rawIdentity: unknown): Promise<ExtensionActivationResult> {
    const identity = validatedInstallIdentity(rawIdentity)
    const id = extensionInstanceId(identity)
    const existing = this.activationFlights.get(id)
    if (existing !== undefined) {
      return existing
    }
    if (this.active.has(id)) {
      const displayName = this.active.get(id)?.displayName ?? identity.name
      return { extensionId: id, displayName }
    }
    const flight = this.runActivation(identity)
    this.activationFlights.set(id, flight)
    try {
      return await flight
    } finally {
      if (this.activationFlights.get(id) === flight) {
        this.activationFlights.delete(id)
      }
    }
  }

  /**
   * Deactivates one active extension by identity (bounded
   * DEACTIVATE_EXTENSION + disposal). Calls the extension's
   * `deactivate()` export inside the host with a 5s bound; a hang or
   * failure stops the exact owned host. Never throws for absent ids.
   * One flight per instance id.
   */
  async deactivateExtension(rawIdentity: unknown): Promise<boolean> {
    const identity = validatedInstallIdentity(rawIdentity)
    const id = extensionInstanceId(identity)
    const existing = this.deactivationFlights.get(id)
    if (existing !== undefined) {
      return existing
    }
    if (!this.active.has(id)) {
      return true
    }
    const flight = this.runDeactivation(identity)
    this.deactivationFlights.set(id, flight)
    try {
      return await flight
    } finally {
      if (this.deactivationFlights.get(id) === flight) {
        this.deactivationFlights.delete(id)
      }
    }
  }

  private settle(key: string, error: Error | null, value: unknown): void {
    const waiter = this.pending.get(key)
    if (waiter === undefined) {
      return
    }
    this.pending.delete(key)
    clearTimeout(waiter.timer)
    if (error !== null) {
      waiter.reject(error)
    } else {
      waiter.resolve(value as never)
    }
  }

  private failAllPending(error: Error): void {
    for (const [key, waiter] of [...this.pending]) {
      this.pending.delete(key)
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  private track<T>(key: string, timeoutMs: number, onTimeout: () => Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(onTimeout())
      }, timeoutMs)
      this.pending.set(key, { resolve: resolve as (value: never) => void, reject, timer })
    })
  }

  private async postAndWait<T>(key: string, timeoutMs: number, onTimeout: () => Error, post: () => void): Promise<T> {
    const gate = this.track<T>(key, timeoutMs, onTimeout)
    try {
      post()
    } catch (error: unknown) {
      const waiter = this.pending.get(key)
      if (waiter !== undefined) {
        this.pending.delete(key)
        clearTimeout(waiter.timer)
      }
      throw error
    }
    return gate
  }

  private readInstallRecord(versionDir: string): Record<string, unknown> | null {
    const manifestPath = join(versionDir, EXTENSION_INSTALL_MANIFEST_NAME)
    let parsed: unknown
    try {
      if (statSync(manifestPath).size > INSTALL_RECORD_MAX_BYTES) {
        return null
      }
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    return parsed as Record<string, unknown>
  }

  private async runActivation(identity: ValidatedInstallIdentity): Promise<ExtensionActivationResult> {
    const id = extensionInstanceId(identity)
    // 1. Installed + enabled (service truth: exact version match).
    let installed: readonly { namespace: string; name: string; version: string; displayName: string; enabled: boolean }[]
    try {
      installed = await this.installService.listInstalled()
    } catch (error: unknown) {
      throw new ExtensionActivationError('not-installed', 'That extension is not installed.', { cause: error })
    }
    const match = installed.find(
      (entry) => entry.namespace === identity.namespace && entry.name === identity.name && entry.version === identity.version
    )
    if (match === undefined) {
      throw new ExtensionActivationError('not-installed', 'That extension is not installed.')
    }
    if (!match.enabled) {
      throw new ExtensionActivationError('disabled', 'That extension is disabled.')
    }
    // 2. Canonical version directory contained under the store root.
    const root = resolve(this.installRoot)
    const versionDir = join(root, `${identity.namespace}.${identity.name}`, identity.version)
    const expected = join(`${identity.namespace}.${identity.name}`, identity.version)
    if (relative(root, versionDir) !== expected) {
      throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
    }
    verifyExtensionDirContained(root, versionDir)
    // 3. Install record proves source + identity (defense in depth;
    //    listInstalled already filtered source=open-vsx).
    const record = this.readInstallRecord(versionDir)
    if (
      record === null ||
      record['namespace'] !== identity.namespace ||
      record['name'] !== identity.name ||
      record['version'] !== identity.version ||
      record['source'] !== 'open-vsx'
    ) {
      throw new ExtensionActivationError('not-installed', 'That extension is not installed.')
    }
    // 4. Enabled state re-check from disk truth (a raced disable
    //    between listInstalled and activation must still fail closed).
    const states = readExtensionEnabledStates(root)
    if ((states.get(extensionStateKey(identity)) ?? true) !== true) {
      throw new ExtensionActivationError('disabled', 'That extension is disabled.')
    }
    // 5. Manifest as data only + identity match.
    let manifest: NormalizedExtensionManifest
    try {
      manifest = readNormalizedManifest(versionDir, identity)
    } catch (error: unknown) {
      if (error instanceof ExtensionActivationError) {
        throw error
      }
      throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.', { cause: error })
    }
    // 6. Kind gate: Node `main` only; browser-only rejected honestly.
    // Purely declarative manifests (themes/snippets/grammars/…) need
    // no activation — contributions apply without running code, so
    // this resolves as a successful no-op (never recorded active:
    // no code runs).
    try {
      requireSupportedExtensionKind(manifest)
    } catch (error: unknown) {
      if (isDeclarativeOnlyManifest(manifest)) {
        return { extensionId: id, displayName: manifest.displayName }
      }
      if (error instanceof ExtensionActivationError) {
        throw error
      }
      throw new ExtensionActivationError('unsupported-extension-kind', 'This extension is not supported in STARK yet.', { cause: error })
    }
    // 7. Entrypoint containment + regular file (never execute scripts).
    try {
      resolveExtensionEntrypoint(join(versionDir, 'extension'), manifest.main)
    } catch (error: unknown) {
      if (error instanceof ExtensionActivationError) {
        throw error
      }
      throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.', { cause: error })
    }
    // 8. Host ready on demand (explicit activation only — never at startup).
    if (this.manager.getStatus().state !== 'ready') {
      try {
        await this.manager.start()
      } catch (error: unknown) {
        throw new ExtensionActivationError('host-unavailable', 'The Extension Host is unavailable.', { cause: error })
      }
    }
    // 9. Single bounded ACTIVATE_EXTENSION flight (no retry).
    const activationId = randomBytes(8).toString('hex')
    try {
      const reply = await this.postAndWait<{ extensionId: string }>(
        `activate:${activationId}`,
        this.activationTimeoutMs,
        () => new ExtensionActivationError('timeout', 'That extension timed out. No changes were made.'),
        () => {
          this.manager.postToHost(
            buildHostPayloadMessage('ACTIVATE_EXTENSION', {
              activationId,
              extensionId: id,
              storeRoot: root,
              extensionDir: versionDir,
              manifest: {
                name: manifest.name,
                publisher: manifest.publisher,
                version: manifest.version,
                displayName: manifest.displayName,
                main: manifest.main,
                browser: manifest.browser,
                activationEvents: [...manifest.activationEvents],
                enginesVscode: manifest.enginesVscode
              }
            })
          )
        }
      )
      if (reply.extensionId !== id) {
        throw new ExtensionActivationError('activation-failed', 'That extension could not be activated.')
      }
    } catch (error: unknown) {
      if (error instanceof ExtensionHostError) {
        throw new ExtensionActivationError('host-unavailable', 'The Extension Host is unavailable.', { cause: error })
      }
      if (error instanceof ExtensionActivationError) {
        throw error
      }
      throw new ExtensionActivationError('activation-failed', 'That extension could not be activated.', { cause: error })
    }
    const result = { extensionId: id, displayName: manifest.displayName }
    this.active.set(id, { displayName: manifest.displayName })
    return result
  }

  private async runDeactivation(identity: ValidatedInstallIdentity): Promise<boolean> {
    const id = extensionInstanceId(identity)
    // Host may already be gone (crash/stop): consider the extension
    // unloaded and clear local state without a round-trip.
    if (this.manager.getStatus().state !== 'ready') {
      this.active.delete(id)
      return true
    }
    const activationId = randomBytes(8).toString('hex')
    try {
      const reply = await this.postAndWait<{ extensionId: string }>(
        `deactivate:${activationId}`,
        this.deactivationTimeoutMs,
        () => new ExtensionActivationError('timeout', 'That extension could not be deactivated.'),
        () => {
          this.manager.postToHost(buildHostPayloadMessage('DEACTIVATE_EXTENSION', { activationId, extensionId: id }))
        }
      )
      void reply
      this.active.delete(id)
      return true
    } catch {
      // Hang or failure: stop the exact owned host so a wedged
      // `deactivate()` can never block future work. The extension is
      // unloaded either way (process stop drops all modules).
      this.active.delete(id)
      try {
        await this.manager.stop()
      } catch {
        // Best effort during unload.
      }
      return false
    }
  }
}

function activationErrorFromHostCode(code: string, unsupportedApi: string | undefined): ExtensionActivationError {
  if (code === 'unsupported-extension-kind') {
    return new ExtensionActivationError('unsupported-extension-kind', 'This extension is not supported in STARK yet.')
  }
  if (code === 'unsupported-api') {
    return new ExtensionActivationError(
      'unsupported-api',
      'This extension requires a VS Code API that STARK does not support yet.',
      typeof unsupportedApi === 'string' && unsupportedApi !== '' ? { unsupportedApi: unsupportedApi.slice(0, 256) } : undefined
    )
  }
  if (code === 'busy') {
    return new ExtensionActivationError('busy', 'That extension is already working. Try again in a moment.')
  }
  return new ExtensionActivationError('activation-failed', 'That extension could not be activated.')
}
