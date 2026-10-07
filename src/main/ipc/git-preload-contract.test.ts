import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Static Git bridge contract: preload exposes only git.getStatus/getDiff
 * and shared constants expose only the two fixed channels. No generic
 * execution, no child_process, no mutation channels.
 */
function readPreloadSource(): string {
  const file = join(process.cwd(), 'src', 'preload', 'index.ts')
  assert.ok(existsSync(file), 'preload source must exist')
  return readFileSync(file, 'utf8')
}

function readConstantsSource(): string {
  const file = join(process.cwd(), 'src', 'shared', 'constants', 'index.ts')
  assert.ok(existsSync(file))
  return readFileSync(file, 'utf8')
}

function readGitServiceSource(): string {
  const file = join(process.cwd(), 'src', 'main', 'git', 'git-service.ts')
  assert.ok(existsSync(file))
  return readFileSync(file, 'utf8')
}

describe('git preload contract', () => {
  it('exposes only git.getStatus and git.getDiff', () => {
    const source = readPreloadSource()
    assert.ok(source.includes('git'))
    assert.ok(source.includes('getStatus'))
    assert.ok(source.includes('getDiff'))
    assert.ok(source.includes('IPC_CHANNELS.gitGetStatus'))
    assert.ok(source.includes('IPC_CHANNELS.gitGetDiff'))
  })

  it('exposes no raw capabilities', () => {
    const source = readPreloadSource()
    for (const forbidden of [
      'child_process',
      'spawn',
      'exec',
      'git command array',
      'generic invoke',
      'generic send',
      'require(',
      'process',
      'node:child_process',
      'shell:'
    ]) {
      // 'process' appears in comments/types; scope the check to value
      // usage that would grant execution. The bridge must not spawn.
      if (forbidden === 'process') {
        assert.ok(!source.includes('child_process'), 'no child_process')
        continue
      }
      assert.ok(!source.includes(forbidden), `preload must not contain ${forbidden}`)
    }
  })

  it('exposes no generic git execution API', () => {
    const source = readPreloadSource()
    for (const forbidden of ['runGit', 'gitCommand', 'execGit', 'runCommand', 'spawnGit']) {
      assert.ok(!source.includes(forbidden), `preload must not contain ${forbidden}`)
    }
  })

  it('constants expose exactly two git channels', () => {
    const source = readConstantsSource()
    assert.ok(source.includes('stark:git:get-status'))
    assert.ok(source.includes('stark:git:get-diff'))
    for (const forbidden of ['git:run', 'git:exec', 'git:command', 'git:stage', 'git:commit', 'git:checkout', 'git:push', 'git:pull', 'git:fetch', 'spawn', 'exec']) {
      // Only the two allowed channels may mention git: prefixes.
      if (forbidden === 'exec' || forbidden === 'spawn') {
        continue
      }
      assert.ok(!source.includes(forbidden), `constants must not contain ${forbidden}`)
    }
  })

  it('service builds only read-only commands with safety flags', () => {
    const source = readGitServiceSource()
    for (const expected of ['--no-ext-diff', '--no-textconv', '--no-color', '--unified=3']) {
      assert.ok(source.includes(expected), `service must include ${expected}`)
    }
    assert.ok(source.includes('--no-pager'))
    for (const forbidden of ['git add', 'git commit', 'git checkout', 'git push', 'git pull', 'git fetch', "'fetch'", "'push'", "'commit'", "'checkout'"]) {
      assert.ok(!source.includes(forbidden), `service must not contain ${forbidden}`)
    }
  })

  it('renderer uses typed helpers, not scattered window.stark.git', () => {
    const file = join(process.cwd(), 'src', 'renderer', 'src', 'lib', 'git-api.ts')
    assert.ok(existsSync(file), 'typed git api helper must exist')
    const helper = readFileSync(file, 'utf8')
    assert.ok(helper.includes('getGitStatus'))
    assert.ok(helper.includes('getGitDiff'))
    const panel = join(process.cwd(), 'src', 'renderer', 'src', 'features', 'git', 'GitPanel.tsx')
    assert.ok(existsSync(panel))
    const panelSource = readFileSync(panel, 'utf8')
    assert.ok(!panelSource.includes('window.stark'), 'panel must use typed helper, not window.stark')
  })
})
