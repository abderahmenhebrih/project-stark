import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  buildPreviewWindowOptions,
  DENIED_PREVIEW_PERMISSIONS,
  isAllowedPreviewNavigation,
  isDeniedPreviewPermission,
  previewPartitionForRuntime,
  wirePreviewWindow
} from '../project-runtime/runtime-preview'

function readMain(relative: string): string {
  return readFileSync(`src/main/${relative}`, 'utf8')
}

describe('hidden inspector security', () => {
  it('uses hardened window options with no preload or node integration', () => {
    const options = buildPreviewWindowOptions(42) as {
      webPreferences?: Record<string, unknown>
      show?: boolean
    }
    assert.equal(options.show, false)
    assert.equal(options.webPreferences?.['nodeIntegration'], false)
    assert.equal(options.webPreferences?.['contextIsolation'], true)
    assert.equal(options.webPreferences?.['sandbox'], true)
    assert.equal(options.webPreferences?.['webSecurity'], true)
    assert.ok(typeof options.webPreferences?.['partition'] === 'string')
    assert.ok(!('preload' in (options.webPreferences ?? {})))
  })

  it('uses the same ephemeral runtime partition', () => {
    assert.equal(previewPartitionForRuntime(42), 'persist:stark-runtime-preview-42')
    const options = buildPreviewWindowOptions(42) as { webPreferences?: { partition?: string } }
    assert.equal(options.webPreferences?.partition, previewPartitionForRuntime(42))
  })

  it('denies sensitive permissions and popups', () => {
    for (const permission of ['camera', 'microphone', 'geolocation', 'clipboard-read']) {
      assert.ok(isDeniedPreviewPermission(permission), permission)
    }
    assert.ok(DENIED_PREVIEW_PERMISSIONS.length > 0)
    let handler: ((details: { url: string }) => { action: 'deny' | 'allow' }) | undefined
    let navigations = 0
    const fake = {
      webContents: {
        on: () => {
          navigations += 1
        },
        setWindowOpenHandler: (next: (details: { url: string }) => { action: 'deny' | 'allow' }) => {
          handler = next
        },
        setPermissionRequestHandler: () => undefined,
        loadURL: async () => undefined,
        reload: () => undefined
      },
      on: () => undefined,
      show: () => undefined,
      isDestroyed: () => false
    }
    wirePreviewWindow(fake as never, 5173, () => undefined)
    assert.ok(handler !== undefined)
    assert.equal(handler?.({ url: 'http://127.0.0.1:5173/' }).action, 'deny')
    assert.ok(navigations >= 1)
  })

  it('allows only same loopback origin navigation', () => {
    assert.ok(isAllowedPreviewNavigation('http://127.0.0.1:5173/dashboard?x=1#y', 5173))
    assert.ok(!isAllowedPreviewNavigation('https://example.com/', 5173))
    assert.ok(!isAllowedPreviewNavigation('http://localhost:5173/', 5173))
    assert.ok(!isAllowedPreviewNavigation('http://127.0.0.1:9999/', 5173))
    assert.ok(!isAllowedPreviewNavigation('file:///etc/passwd', 5173))
    assert.ok(!isAllowedPreviewNavigation('javascript:alert(1)', 5173))
    assert.ok(!isAllowedPreviewNavigation('data:text/html,hi', 5173))
  })

  it('blocks off-origin will-navigate', () => {
    let prevented = false
    const fake = {
      webContents: {
        on: (event: string, listener: (details: { url: string; preventDefault: () => void }) => void) => {
          if (event === 'will-navigate') {
            listener({ url: 'https://example.com/', preventDefault: () => {
              prevented = true
            } })
          }
        },
        setWindowOpenHandler: () => undefined,
        setPermissionRequestHandler: () => undefined,
        loadURL: async () => undefined,
        reload: () => undefined
      },
      on: () => undefined,
      show: () => undefined,
      isDestroyed: () => false
    }
    wirePreviewWindow(fake as never, 5173, () => undefined)
    assert.equal(prevented, true)
  })

  it('inspection service has no screenshot or network surface (static)', () => {
    const service = readMain('preview-inspection/preview-inspection-service.ts')
    for (const forbidden of ['capturePage', 'screenshot', 'base64', 'fetch(', 'XMLHttpRequest', 'cookies', 'localStorage']) {
      assert.ok(!service.includes(forbidden), `inspection service must not contain ${forbidden}`)
    }
    const script = readMain('preview-inspection/preview-inspection-script.ts')
    assert.ok(!script.includes('capturePage'))
  })

  it('production IPC surface has no browser-execute channel (static)', () => {
    const constants = readFileSync('src/shared/constants/index.ts', 'utf8')
    assert.ok(!constants.includes('browser-execute'))
    assert.ok(!constants.includes('agent-runtime-read'))
    assert.ok(!constants.includes('observeRuntimeAsAgent'))
    assert.ok(!constants.includes('inspectPreviewAsAgent'))
    const ipc = readMain('ipc/index.ts')
    assert.ok(!ipc.includes('browser-execute'))
    const preload = readFileSync('src/preload/index.ts', 'utf8')
    assert.ok(!preload.includes('observeRuntimeAsAgent'))
    assert.ok(!preload.includes('inspectPreviewAsAgent'))
    assert.ok(!preload.includes('executeBrowser'))
    assert.ok(!preload.includes('evaluateJavaScript'))
  })
})
