import type { BrowserWindowConstructorOptions } from 'electron'
import { previewUrlForPort } from '../../shared/project-runtime/types'
import { MAX_RUNTIME_PORT, MIN_RUNTIME_PORT } from './project-runtime-limits'

/** Ephemeral partition scope for one runtime preview window. */
export function previewPartitionForRuntime(runtimeId: number): string {
  return `persist:stark-runtime-preview-${String(runtimeId)}`
}

/**
 * Hardened BrowserWindow options for an isolated Live Preview.
 * No Node integration, no STARK preload, sandboxed, web security on,
 * ephemeral per-runtime session partition. The preview renderer has
 * no bridge to credentials, the filesystem, or main-process APIs.
 */
export function buildPreviewWindowOptions(runtimeId: number): BrowserWindowConstructorOptions {
  return {
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 550,
    backgroundColor: '#0a0c0a',
    title: 'STARK Live Preview',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: previewPartitionForRuntime(runtimeId)
    }
  }
}

/**
 * Same-loopback-origin navigation allowlist for one approved preview
 * port. Same scheme + same host + same port navigations (any
 * path/query/hash) are allowed; everything else — external origins,
 * other ports or hosts (including `localhost` when the origin is
 * `127.0.0.1`), `file:`, `javascript:`, `data:`, custom schemes — is
 * denied. Pure and unit-testable.
 */
export function isAllowedPreviewNavigation(url: string, port: number): boolean {
  if (!Number.isInteger(port) || port < MIN_RUNTIME_PORT || port > MAX_RUNTIME_PORT) {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:') {
    return false
  }
  if (parsed.hostname !== '127.0.0.1') {
    return false
  }
  const effectivePort = parsed.port === '' ? 80 : Number(parsed.port)
  return Number.isInteger(effectivePort) && effectivePort === port
}

/** Exact initial preview URL derived from the persisted approved port. */
export function previewUrlForRuntime(port: number): string {
  return previewUrlForPort(port)
}

/** Sensitive web permissions are never granted to preview content. */
export const DENIED_PREVIEW_PERMISSIONS: readonly string[] = [  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'midi',
  'serial',
  'usb',
  'bluetooth',
  'clipboard-read',
  'fullscreen',
  'pointerLock'
]

/** True when a permission request from preview content must be denied. */
export function isDeniedPreviewPermission(permission: string): boolean {
  return (DENIED_PREVIEW_PERMISSIONS as readonly string[]).includes(permission)
}

/**
 * Structural preview-window surface used by the runtime service.
 * Implemented by the real Electron BrowserWindow in production and by
 * fakes in tests — the service never touches Electron directly.
 */
export interface PreviewWindow {
  readonly webContents: {
    on(event: 'will-navigate', listener: (details: { url: string; preventDefault: () => void }) => void): void
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void
    setPermissionRequestHandler(handler: (permission: string, decide: (granted: boolean) => void) => void): void
    loadURL(url: string): Promise<void>
    reload(): void
  }
  on(event: 'closed' | 'ready-to-show', listener: () => void): void
  show(): void
  isDestroyed(): boolean
}

/**
 * Hardens one preview window for isolated loopback content: popups
 * denied, off-origin navigation blocked, sensitive permissions
 * denied, close reported so the runtime (which keeps running) can
 * drop the reference. No STARK preload or bridge is ever attached —
 * the window is created without one.
 */
export function wirePreviewWindow(
  window: PreviewWindow,
  port: number,
  onClosed: () => void
): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (details) => {
    if (!isAllowedPreviewNavigation(details.url, port)) {
      details.preventDefault()
    }
  })
  window.webContents.setPermissionRequestHandler((permission, decide) => {
    decide(!isDeniedPreviewPermission(permission))
  })
  window.on('closed', onClosed)
  window.on('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show()
    }
  })
}
