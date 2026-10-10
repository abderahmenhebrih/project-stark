import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ExtensionWatcherService, matchWatcherPattern, validatedWatcherPattern } from './extension-watchers'

describe('extension watcher service', () => {
  it('validates workspace-contained patterns only', () => {
    assert.equal(validatedWatcherPattern('**/*.ts'), '**/*.ts')
    assert.equal(validatedWatcherPattern('package.json'), 'package.json')
    for (const bad of ['', '/abs/pattern', 'C:\\win', '..\\evil', '../evil', 'a\0b']) {
      assert.throws(() => validatedWatcherPattern(bad), /not valid|escapes/)
    }
  })

  it('matches root globs without recursion surprises', () => {
    assert.equal(matchWatcherPattern('package.json', 'package.json'), true)
    assert.equal(matchWatcherPattern('package.json', 'src/package.json'), false)
    assert.equal(matchWatcherPattern('**/package.json', 'src/package.json'), true)
    assert.equal(matchWatcherPattern('*.json', 'tsconfig.json'), true)
    assert.equal(matchWatcherPattern('*.json', 'src/tsconfig.json'), false)
    assert.equal(matchWatcherPattern('src/*.ts', 'src/a.ts'), true)
    assert.equal(matchWatcherPattern('src/*.ts', 'src/nested/a.ts'), false)
    assert.equal(matchWatcherPattern('src/**/*.ts', 'src/nested/a.ts'), true)
  })

  it('registers with per-extension caps and unregisters exactly', () => {
    const service = new ExtensionWatcherService({ workspaceRootProvider: () => null })
    try {
      const first = service.register('a.ext@1.0.0', '**/*.ts', 7)
      assert.equal(first.owner, 'a.ext@1.0.0')
      assert.equal(service.unregister(first.id), true)
      assert.equal(service.unregister(first.id), false)
      service.register('a.ext@1.0.0', '**/*.ts', 1)
      service.unregisterOwner('a.ext@1.0.0')
      assert.equal(service.listRegistrations().length, 0)
    } finally {
      service.dispose()
    }
  })

  it('dispatches debounced workspace events to matching watchers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-watch-'))
    const service = new ExtensionWatcherService({ workspaceRootProvider: () => root, debounceMs: 20 })
    try {
      const seen: { hostWatcherId: number; kind: string }[] = []
      service.setDispatchListener((event) => {
        seen.push({ hostWatcherId: event.hostWatcherId, kind: event.kind })
      })
      service.register('a.ext@1.0.0', '*.json', 11)
      service.register('a.ext@1.0.0', '*.ts', 12)
      writeFileSync(join(root, 'package.json'), '{}')
      await new Promise((resolve) => setTimeout(resolve, 400))
      assert.ok(seen.some((event) => event.hostWatcherId === 11), `json watcher must fire, saw ${JSON.stringify(seen)}`)
      assert.ok(!seen.some((event) => event.hostWatcherId === 12), 'ts watcher must not fire for a json file')
    } finally {
      service.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
