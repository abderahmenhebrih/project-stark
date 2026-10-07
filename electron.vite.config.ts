import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * electron-vite build configuration.
 *
 * Three independent bundles are produced:
 * - main:    Electron main process      (src/main/index.ts)
 * - preload: secure context bridge      (src/preload/index.ts)
 * - renderer: React application         (src/renderer/index.html)
 *
 * The renderer bundle is framework code only — it never receives
 * direct Node.js access. All privileged operations must cross the
 * preload bridge (see src/preload/index.ts).
 *
 * The preload bundle is CommonJS on purpose: sandboxed renderers expose
 * only a polyfilled require('electron') to preload scripts, so ESM
 * `import` statements cannot load there. The bridge source stays a single
 * bundled file so it never needs multi-file requires either.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: 'src/renderer/index.html'
      }
    },
    plugins: [react()],
    resolve: {
      alias: [
        {
          // Monaco's package exports map only covers JS subpaths, so the
          // bundled editor stylesheet needs an explicit file alias. The
          // CSS still ships inside STARK's own assets — no remote origin.
          find: 'monaco-editor/min/vs/editor/editor.main.css',
          replacement: fileURLToPath(
            new URL('./node_modules/monaco-editor/min/vs/editor/editor.main.css', import.meta.url)
          )
        }
      ]
    }
  }
})
