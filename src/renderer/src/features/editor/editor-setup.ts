/**
 * Local-only Monaco loading for the STARK renderer.
 *
 * No CDN, no remote origins: the editor bundle ships inside STARK and
 * every worker is a same-origin file produced by the Vite build.
 * Packaged file:// builds emit classic IIFE worker chunks (ES modules
 * are blocked over file://), so production uses classic construction;
 * the Vite dev server serves the raw ESM worker sources, so dev uses
 * module construction. Same-origin in both cases.
 * The production CSP needs no new script sources: workers fall back
 * to `script-src 'self'`, fonts/styles stay under the existing
 * `font-src`/`style-src 'self'` allowances.
 */

import editorWorkerUrl from 'monaco-editor/editor/editor.worker?worker&url'
import jsonWorkerUrl from 'monaco-editor/language/json/json.worker?worker&url'
import cssWorkerUrl from 'monaco-editor/language/css/css.worker?worker&url'
import htmlWorkerUrl from 'monaco-editor/language/html/html.worker?worker&url'
import tsWorkerUrl from 'monaco-editor/language/typescript/ts.worker?worker&url'
import 'monaco-editor/min/vs/editor/editor.main.css'

/** The loaded Monaco module shape used by STARK components. */
export type Monaco = typeof import('monaco-editor/editor/editor.api')

let environmentReady = false

/**
 * Constructs a same-origin worker matching the serving environment.
 * Exported for unit tests; the renderer always goes through getWorker.
 */
export function createLocalWorker(url: string, label: string): Worker {
  if (window.location.protocol === 'file:') {
    return new Worker(url, { name: `stark-${label}` })
  }
  return new Worker(url, { type: 'module', name: `stark-${label}` })
}

/** Points Monaco at same-origin local workers exactly once. */
export function ensureMonacoEnvironment(): void {
  if (environmentReady) {
    return
  }
  environmentReady = true
  const scope = globalThis as unknown & {
    MonacoEnvironment?: { getWorker: (moduleId: string, label: string) => Worker }
  }
  scope.MonacoEnvironment = {
    getWorker: (_moduleId: string, label: string): Worker => {
      const url =
        label === 'json'
          ? jsonWorkerUrl
          : label === 'css' || label === 'scss' || label === 'less'
            ? cssWorkerUrl
            : label === 'html'
              ? htmlWorkerUrl
              : label === 'typescript' || label === 'javascript'
                ? tsWorkerUrl
                : editorWorkerUrl
      return createLocalWorker(url, label)
    }
  }
}

/**
 * Lazily loads the full Monaco editor API module (separate chunk,
 * first editor mount only) after the worker environment is
 * configured. The deep `editor.api` entry carries the complete
 * typed surface; the package root re-exports only a subset.
 */
export async function loadMonaco(): Promise<Monaco> {
  ensureMonacoEnvironment()
  return import('monaco-editor/editor/editor.api')
}
