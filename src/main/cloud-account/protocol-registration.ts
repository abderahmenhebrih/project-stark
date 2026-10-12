import { isAbsolute, resolve } from 'node:path'

/**
 * STARK auth-protocol registration (Stage 29 deep-link fix).
 *
 * The OAuth callback must reach the RUNNING STARK instance via
 * `stark://auth/callback?code=…`. Packaged builds register the
 * executable normally. Development Electron processes are the raw
 * Electron binary (`process.defaultApp`), so a bare
 * `setAsDefaultProtocolClient('stark')` registers a handler that can
 * never boot the app: the OS must also be told which app entry to
 * launch. The second launch then hits the single-instance lock, which
 * forwards the URL argv to the already-running instance and exits.
 *
 * No localhost callback server, no extra ports — custom protocol only.
 */

export interface AuthProtocolRegistration {
  /** Protocol scheme (always `stark`). */
  readonly protocol: 'stark'
  /** Executable the OS should launch (dev only; packaged uses the app binary). */
  readonly execPath: string | null
  /** Extra launch args carrying the app entry (dev only). */
  readonly args: readonly string[] | null
}

export interface AuthProtocolRegistrationInput {
  readonly isPackaged: boolean
  readonly defaultApp: boolean
  readonly execPath: string
  /** First user argv entry (`process.argv[1]`), if any. */
  readonly argv1: string | undefined
  /** Absolute application directory (`app.getAppPath()`). */
  readonly appPath: string
}

/**
 * Builds the registration for one launch mode (pure, unit-testable).
 *
 * - Packaged: plain registration (the app binary owns the scheme).
 * - Dev with an absolute argv entry: the documented Electron recipe
 *   (executable + resolved entry) so OS relaunches boot this app.
 * - Dev otherwise: executable + absolute app directory, so an OS
 *   relaunch still boots the app entry and reaches single-instance
 *   forwarding. Never a relative path (the OS launch cwd is not ours).
 */
export function buildAuthProtocolRegistration(input: AuthProtocolRegistrationInput): AuthProtocolRegistration {
  if (input.isPackaged) {
    return { protocol: 'stark', execPath: null, args: null }
  }
  if (
    input.defaultApp &&
    typeof input.argv1 === 'string' &&
    input.argv1 !== '' &&
    !input.argv1.startsWith('-') &&
    isAbsolute(input.argv1)
  ) {
    return { protocol: 'stark', execPath: input.execPath, args: [resolve(input.argv1)] }
  }
  return { protocol: 'stark', execPath: input.execPath, args: [input.appPath] }
}

export interface AuthProtocolClient {
  setAsDefaultProtocolClient(protocol: string, execPath?: string, args?: readonly string[]): boolean
}

/**
 * Applies one built registration through the Electron app seam.
 * Best-effort and boolean-safe: registration must never break
 * startup (the worst case is a manually-pasted callback, which the
 * strict parser still rejects safely).
 */
export function registerAuthProtocolClient(
  client: AuthProtocolClient,
  registration: AuthProtocolRegistration
): boolean {
  try {
    if (registration.execPath === null || registration.args === null) {
      return client.setAsDefaultProtocolClient(registration.protocol)
    }
    return client.setAsDefaultProtocolClient(registration.protocol, registration.execPath, [...registration.args])
  } catch {
    return false
  }
}
