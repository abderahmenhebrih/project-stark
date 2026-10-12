import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { readPreviewProject } from './preview-project'

function craftProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stark-preview-proj-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

describe('preview project inspection', () => {
  it('detects npm + dev', async () => {
    const dir = craftProject({ 'package.json': JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }), 'package-lock.json': '{}' })
    try {
      const outcome = await readPreviewProject(dir)
      assert.equal(outcome.kind, 'ready')
      if (outcome.kind === 'ready') {
        assert.equal(outcome.plan.script, 'dev')
        assert.equal(outcome.plan.packageManager, 'npm')
        assert.deepEqual(outcome.plan.args, ['run', 'dev'])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects pnpm via lockfile and honors the packageManager field first', async () => {
    const dir = craftProject({ 'package.json': JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }), 'pnpm-lock.yaml': 'x' })
    try {
      const outcome = await readPreviewProject(dir)
      assert.equal(outcome.kind, 'ready')
      if (outcome.kind === 'ready') {
        assert.equal(outcome.plan.packageManager, 'pnpm')
        assert.equal(outcome.plan.program, 'pnpm')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const explicit = craftProject({
      'package.json': JSON.stringify({ name: 'web', packageManager: 'yarn@4.0.0', scripts: { dev: 'vite' } }),
      'pnpm-lock.yaml': 'x'
    })
    try {
      const outcome = await readPreviewProject(explicit)
      assert.equal(outcome.kind, 'ready')
      if (outcome.kind === 'ready') {
        assert.equal(outcome.plan.packageManager, 'yarn')
      }
    } finally {
      rmSync(explicit, { recursive: true, force: true })
    }
  })

  it('reports missing, invalid, and scriptless projects honestly', async () => {
    const missing = mkdtempSync(join(tmpdir(), 'stark-preview-missing-'))
    try {
      assert.deepEqual(await readPreviewProject(missing), { kind: 'no-package-json' })
    } finally {
      rmSync(missing, { recursive: true, force: true })
    }
    const bad = craftProject({ 'package.json': '{not json' })
    try {
      assert.deepEqual(await readPreviewProject(bad), { kind: 'invalid-manifest' })
    } finally {
      rmSync(bad, { recursive: true, force: true })
    }
    const plain = craftProject({ 'package.json': JSON.stringify({ name: 'lib', scripts: { build: 'tsc', test: 'vitest' } }) })
    try {
      assert.deepEqual(await readPreviewProject(plain), { kind: 'no-preview-script' })
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('never executes package scripts and refuses symlinked manifests', async () => {
    const dir = craftProject({
      'package.json': JSON.stringify({ name: 'web', scripts: { dev: 'vite', postinstall: 'touch PWNED' } })
    })
    try {
      const outcome = await readPreviewProject(dir)
      assert.equal(outcome.kind, 'ready')
      assert.ok(!existsSync(join(dir, 'PWNED')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const outer = mkdtempSync(join(tmpdir(), 'stark-preview-link-'))
    try {
      writeFileSync(join(outer, 'real.json'), JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }))
      const inner = join(outer, 'inner')
      mkdirSync(inner, { recursive: true })
      try {
        symlinkSync(join(outer, 'real.json'), join(inner, 'package.json'), 'file')
      } catch {
        return
      }
      assert.deepEqual(await readPreviewProject(inner), { kind: 'no-package-json' })
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })
})
