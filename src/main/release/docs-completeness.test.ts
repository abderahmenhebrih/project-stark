import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function root(): string {
  return process.cwd()
}

function doc(name: string): string {
  return readFileSync(join(root(), 'docs', name), 'utf8')
}

const ACCEPTANCE_SECTIONS = [
  '## A. First Launch / Onboarding',
  '## B. Workspace',
  '## C. Explorer',
  '## D. Search',
  '## E. Editor / Monaco',
  '## F. Change Transactions',
  '## G. Change Sets',
  '## H. Human Terminal',
  '## I. Git',
  '## J. Sessions / Ask',
  '## K. Providers / Credentials',
  '## L. Explicit Context',
  '## M. Propose',
  '## N. Brain',
  '## O. Heart',
  '## P. Looplink',
  '## Q. Recovery',
  '## R. Agent Permissions',
  '## S. Worker Read/Search/Git Tools',
  '## T. Worker change.propose',
  '## U. Worker terminal_execute',
  '## V. Managed Runtime',
  '## W. Runtime Observation',
  '## X. Preview Inspection',
  '## Y. Usage / Threshold Routing',
  '## Z. Account / OAuth',
  '## AA. Persistence / Restart',
  '## AB. Crash / Interrupted States',
  '## AC. Security',
  '## AD. Packaging / Install / Uninstall',
  '## AE. Offline Behavior',
  '## AF. Final Regression'
]

describe('release documents completeness', () => {
  it('acceptance matrix covers every subsystem with UNTESTED checks', () => {
    const acceptance = doc('RELEASE_ACCEPTANCE_V1.md')
    for (const section of ACCEPTANCE_SECTIONS) {
      assert.ok(acceptance.includes(section), `acceptance matrix must contain ${section}`)
    }
    assert.ok(acceptance.includes('NOT EXECUTED'), 'acceptance must record NOT EXECUTED')
    const untested = acceptance.match(/Status: UNTESTED/g) ?? []
    assert.ok(untested.length >= 70, `acceptance must hold the full matrix (found ${String(untested.length)})`)
    assert.ok(!acceptance.includes('Status: PASS'), 'no check may be pre-marked PASS')
    for (const field of ['Preconditions:', 'Steps:', 'Expected:']) {
      const count = acceptance.split(field).length - 1
      assert.ok(count >= 70, `every check needs ${field} (found ${String(count)})`)
    }
    for (const priority of ['[P0]', '[P1]', '[P2]']) {
      assert.ok(acceptance.includes(priority), `acceptance must prioritize with ${priority}`)
    }
  })

  it('readiness document records schema, scope, and unexecuted acceptance honestly', () => {
    const readiness = doc('RELEASE_READINESS_V1.md')
    assert.ok(readiness.includes('v18'), 'readiness must record schema v18')
    assert.ok(readiness.includes('NOT YET EXECUTED'), 'readiness must record acceptance as NOT YET EXECUTED')
    assert.ok(!readiness.toLowerCase().includes('production release ready'), 'readiness must not claim release-ready')
    for (const required of ['code signing', 'Stage 31', 'Manual acceptance status']) {
      assert.ok(readiness.toLowerCase().includes(required.toLowerCase()), `readiness must cover ${required}`)
    }
  })
})
