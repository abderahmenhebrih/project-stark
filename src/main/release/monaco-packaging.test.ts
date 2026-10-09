import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function root(): string {
  return process.cwd()
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') {
      continue
    }
    const full = join(dir, entry)
    try {
      if (statSync(full).isDirectory()) {
        out.push(...listFilesRecursive(full))
      } else {
        out.push(full)
      }
    } catch {
      continue
    }
  }
  return out
}

describe('Monaco packaged asset coverage', () => {
  it('bundles Monaco locally with no CDN fallback', () => {
    const pkg = JSON.parse(readFileSync(join(root(), 'package.json'), 'utf8')) as Record<string, unknown>
    const deps = pkg['dependencies'] as Record<string, unknown>
    assert.ok(typeof deps['monaco-editor'] === 'string', 'monaco-editor must be a bundled dependency')
    const rendererFiles = listFilesRecursive(join(root(), 'src', 'renderer')).filter(
      (file) => file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.html') || file.endsWith('.css')
    )
    for (const file of rendererFiles) {
      const source = readFileSync(file, 'utf8')
      assert.ok(!source.includes('cdn.jsdelivr'), `${file} must not use a Monaco CDN`)
      assert.ok(!source.includes('unpkg.com'), `${file} must not use a Monaco CDN`)
    }
    const vite = readFileSync(join(root(), 'electron.vite.config.ts'), 'utf8')
    assert.ok(vite.includes('monaco-editor'), 'vite config must resolve Monaco locally')
  })
})
