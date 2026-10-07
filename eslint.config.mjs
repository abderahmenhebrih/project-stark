import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

/**
 * Flat ESLint configuration.
 *
 * - Base TypeScript rules apply to the whole repo.
 * - React rules apply to the renderer only.
 * - Node globals apply to the Electron main/preload layers and tooling configs.
 */
export default tseslint.config(
  {
    ignores: ['node_modules/**', 'out/**', 'dist/**', '.test-dist/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'electron.vite.config.ts', 'eslint.config.mjs'],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  }
)
