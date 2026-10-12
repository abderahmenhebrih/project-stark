import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  detectPackageManagerKind,
  detectPreviewPlan,
  detectPreviewScript,
  packageManagerLaunch,
  parseLoopbackUrlFromText,
  PREVIEW_STARTUP_TIMEOUT_MS
} from './preview-detection'

const EMPTY_LOCKS = { pnpmLock: false, yarnLock: false, bunLock: false, npmLock: false }

describe('preview script detection', () => {
  it('prefers dev, then preview/serve, then safe start only', () => {
    assert.equal(detectPreviewScript({ dev: 'vite', start: 'node server.js' }), 'dev')
    assert.equal(detectPreviewScript({ preview: 'vite preview', start: 'node server.js' }), 'preview')
    assert.equal(detectPreviewScript({ serve: 'serve dist' }), 'serve')
    // `start` runs only when it clearly describes a dev server.
    assert.equal(detectPreviewScript({ start: 'vite --port 5173' }), 'start')
    assert.equal(detectPreviewScript({ start: 'next dev' }), 'start')
    assert.equal(detectPreviewScript({ start: 'node server.js' }), null)
    assert.equal(detectPreviewScript({ build: 'tsc' }), null)
    assert.equal(detectPreviewScript(null), null)
    assert.equal(detectPreviewScript({ dev: '' }), null)
    assert.equal(detectPreviewScript({ dev: 42 }), null)
  })

  it('derives the package manager from source truth', () => {
    assert.equal(detectPackageManagerKind('pnpm@9.0.0', { ...EMPTY_LOCKS, npmLock: true }), 'pnpm')
    assert.equal(detectPackageManagerKind('yarn@4.0.0', EMPTY_LOCKS), 'yarn')
    assert.equal(detectPackageManagerKind('bun@1.0.0', EMPTY_LOCKS), 'bun')
    assert.equal(detectPackageManagerKind(undefined, { ...EMPTY_LOCKS, pnpmLock: true, npmLock: true }), 'pnpm')
    assert.equal(detectPackageManagerKind(undefined, { ...EMPTY_LOCKS, yarnLock: true }), 'yarn')
    assert.equal(detectPackageManagerKind(undefined, { ...EMPTY_LOCKS, bunLock: true }), 'bun')
    assert.equal(detectPackageManagerKind(undefined, EMPTY_LOCKS), 'npm')
    assert.equal(detectPackageManagerKind('weird-tool@1', { ...EMPTY_LOCKS, yarnLock: true }), 'yarn')
  })

  it('launches direct executables with inert args (no shell)', () => {
    assert.deepEqual(packageManagerLaunch('npm', 'dev'), { program: 'npm', args: ['run', 'dev'] })
    assert.deepEqual(packageManagerLaunch('pnpm', 'dev'), { program: 'pnpm', args: ['run', 'dev'] })
    assert.deepEqual(packageManagerLaunch('yarn', 'dev'), { program: 'yarn', args: ['run', 'dev'] })
    assert.deepEqual(packageManagerLaunch('bun', 'dev'), { program: 'bun', args: ['run', 'dev'] })
  })

  it('detects full plans end to end', () => {
    const plan = detectPreviewPlan({ scripts: { dev: 'vite' }, packageManagerField: undefined, lockfiles: EMPTY_LOCKS })
    assert.deepEqual(plan, { script: 'dev', packageManager: 'npm', program: 'npm', args: ['run', 'dev'] })
    assert.equal(detectPreviewPlan({ scripts: { build: 'tsc' }, packageManagerField: undefined, lockfiles: EMPTY_LOCKS }), null)
  })
})

describe('loopback URL discovery', () => {
  it('recognizes common dev-server forms', () => {
    assert.equal(parseLoopbackUrlFromText('  ➜  Local:   http://localhost:5173/'), 'http://localhost:5173/')
    assert.equal(parseLoopbackUrlFromText('started on http://127.0.0.1:3000'), 'http://127.0.0.1:3000')
    assert.equal(parseLoopbackUrlFromText('ready on http://[::1]:3000/'), 'http://[::1]:3000/')
    assert.equal(parseLoopbackUrlFromText('Listening at http://localhost:8080/app?x=1'), 'http://localhost:8080/app?x=1')
    // Most recent URL wins.
    assert.equal(parseLoopbackUrlFromText('http://localhost:3000 old\nhttp://localhost:3001 new'), 'http://localhost:3001')
  })

  it('rejects remote, LAN, schemeless, and portless output', () => {
    assert.equal(parseLoopbackUrlFromText('go to https://example.com:3000'), null)
    assert.equal(parseLoopbackUrlFromText('at http://192.168.1.5:3000'), null)
    assert.equal(parseLoopbackUrlFromText('at http://localhost'), null)
    assert.equal(parseLoopbackUrlFromText('at http://localhost:99999'), null)
    assert.equal(parseLoopbackUrlFromText(''), null)
    assert.equal(parseLoopbackUrlFromText('file:///etc/passwd'), null)
  })

  it('bounds the startup window (20–30 seconds)', () => {
    assert.ok(PREVIEW_STARTUP_TIMEOUT_MS >= 20_000 && PREVIEW_STARTUP_TIMEOUT_MS <= 30_000)
  })
})
