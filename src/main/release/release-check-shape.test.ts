import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function root(): string {
  return process.cwd()
}

describe('release:check script shape', () => {
  it('exists as an npm script backed by a bounded fail-fast script', () => {
    const pkg = JSON.parse(readFileSync(join(root(), 'package.json'), 'utf8')) as Record<string, unknown>
    const scripts = pkg['scripts'] as Record<string, unknown>
    assert.equal(scripts['release:check'], 'node scripts/release-check.cjs')
    assert.ok(existsSync(join(root(), 'scripts', 'release-check.cjs')))
    const source = readFileSync(join(root(), 'scripts', 'release-check.cjs'), 'utf8')
    for (const stage of ['typecheck', 'lint', 'build', 'test']) {
      assert.ok(source.includes(`'${stage}'`), `release:check must run ${stage}`);
    }
    assert.ok(source.includes('TIMEOUT') || source.includes('timeout'), 'release:check must bound each step')
    assert.ok(source.includes('process.exit(1)'), 'release:check must fail fast')
    assert.ok(!source.toLowerCase().includes('retry'), 'release:check must not retry')
    // Manual acceptance is documented, never executed, by release:check.
    for (const runner of ['playwright', 'spectron', 'webdriver', 'manual-acceptance:run']) {
      assert.ok(!source.toLowerCase().includes(runner), `release:check must not launch ${runner}`)
    }
  })

  it('ships a bounded single-launch packaged smoke runner', () => {
    assert.ok(existsSync(join(root(), 'scripts', 'packaged-smoke.cjs')))
    const source = readFileSync(join(root(), 'scripts', 'packaged-smoke.cjs'), 'utf8')
    assert.ok(source.includes('20_000'), 'smoke runner must carry the 20s hard timeout')
    assert.ok(source.includes('STARK_RELEASE_SMOKE'), 'smoke runner must use the test-only smoke flag')
    assert.ok(source.includes('STARK_SMOKE_USERDATA'), 'smoke runner must isolate userdata')
    assert.ok(!source.toLowerCase().includes('retry'), 'smoke runner must not retry')
  })
})
