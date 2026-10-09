import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function root(): string {
  return process.cwd()
}

function packageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root(), 'package.json'), 'utf8')) as Record<string, unknown>
}

describe('production packaging configuration', () => {
  it('declares stable STARK metadata and semver', () => {
    const pkg = packageJson()
    const build = pkg['build'] as Record<string, unknown>
    assert.equal(build['productName'], 'STARK')
    assert.equal(build['appId'], 'com.stark.app')
    assert.ok(/^\d+\.\d+\.\d+/.test(String(pkg['version'])), 'version must be valid semver')
    assert.ok(String(pkg['description']).includes('STARK'))
  })

  it('targets Windows NSIS, macOS DMG+ZIP, Linux AppImage+DEB', () => {
    const pkg = packageJson()
    const build = pkg['build'] as Record<string, unknown>
    const win = build['win'] as Record<string, unknown>
    const mac = build['mac'] as Record<string, unknown>
    const linux = build['linux'] as Record<string, unknown>
    assert.deepEqual(win['target'], ['nsis'])
    assert.deepEqual(mac['target'], ['dmg', 'zip'])
    assert.deepEqual(linux['target'], ['AppImage', 'deb'])
  })

  it('registers the stark:// deep-link protocol', () => {
    const pkg = packageJson()
    const build = pkg['build'] as Record<string, unknown>
    const protocols = build['protocols'] as Array<Record<string, unknown>>
    assert.ok(
      protocols.some((entry) => (entry['schemes'] as string[]).includes('stark')),
      'stark:// scheme must be registered'
    )
  })

  it('excludes secrets, databases, logs, and env files from the package', () => {
    const pkg = packageJson()
    const build = pkg['build'] as Record<string, unknown>
    const files = JSON.stringify(build['files'])
    assert.ok(files.includes('out/**/*'))
    assert.ok(files.includes('node-pty'))
    for (const excluded of ['.env', '.db', '.log', 'coverage']) {
      assert.ok(files.includes(excluded), `package must exclude ${excluded}`)
    }
    assert.ok(!files.includes('supabase/service_role'), 'no service-role material may ship')
  })

  it('keeps native modules unpacked with ASAR-safe config', () => {
    const pkg = packageJson()
    const build = pkg['build'] as Record<string, unknown>
    const unpack = JSON.stringify(build['asarUnpack'])
    assert.ok(unpack.includes('node-pty'), 'node-pty prebuilds must unpack')
    assert.ok(unpack.includes('.node'), 'native modules must unpack')
  })

  it('bundles no provider keys or Supabase secrets as build config', () => {
    const raw = readFileSync(join(root(), 'package.json'), 'utf8')
    assert.ok(!raw.includes('sk-'), 'package must not bundle provider keys')
    assert.ok(!raw.includes('service_role'), 'package must not bundle service-role material')
    assert.ok(existsSync(join(root(), '.env.example')), '.env.example documents public config only')
  })
})
