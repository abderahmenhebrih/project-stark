import type { BrowserWindow } from 'electron'

/**
 * Microphone permission policy (Step 4).
 *
 * Electron's secure permission architecture: only STARK's trusted
 * renderer may request microphone access, audio-only, after an
 * explicit user click. Everything else fails closed — camera, screen
 * capture, and any non-audio media request are denied, as are
 * requests from unexpected origins/windows.
 */

/** Media types STARK ever grants: audio capture only. */
const ALLOWED_MEDIA_TYPES: readonly string[] = ['audio']

/**
 * Pure permission decision: true only for an audio-only media
 * request. Camera/video/screen or any other permission is denied.
 * Unit-testable without Electron.
 */
export function decideMediaPermission(permission: string, mediaTypes: readonly string[] | undefined): boolean {
  if (permission !== 'media') {
    return false
  }
  if (mediaTypes === undefined || mediaTypes.length === 0) {
    return false
  }
  return mediaTypes.length === 1 && ALLOWED_MEDIA_TYPES.includes(mediaTypes[0] as string)
}

/**
 * Installs the audio-only permission handler on the application
 * window's session. Never grants camera, screen capture, or other
 * permissions. Must be called once per window after creation.
 */
export function configureMicrophonePermissions(window: BrowserWindow): void {
  try {
    window.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      void webContents
      const mediaTypes = readMediaTypes(details)
      callback(decideMediaPermission(permission, mediaTypes))
    })
  } catch {
    // Best effort: a missing session API must never break window creation.
  }
}

function readMediaTypes(details: unknown): readonly string[] | undefined {
  if (typeof details !== 'object' || details === null) {
    return undefined
  }
  const record = details as Record<string, unknown>
  const plural = record['mediaTypes']
  if (Array.isArray(plural) && plural.every((entry) => typeof entry === 'string')) {
    return plural as string[]
  }
  const singular = record['mediaType']
  if (typeof singular === 'string') {
    return [singular]
  }
  return undefined
}
