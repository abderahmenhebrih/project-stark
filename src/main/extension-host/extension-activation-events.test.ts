import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildActivationIndex,
  extensionsForCommand,
  extensionsForLanguage,
  extensionsForStartupFinished,
  extensionsForWorkspace,
  matchWorkspaceContainsPattern,
  parseActivationEvent
} from './extension-activation-events'

describe('activation events engine', () => {
  it('parses common stable events and quarantines star/unknown', () => {
    assert.deepEqual(parseActivationEvent('onLanguage:typescript'), {
      raw: 'onLanguage:typescript',
      kind: 'onLanguage',
      value: 'typescript'
    })
    assert.deepEqual(parseActivationEvent('onCommand:eslint.executeAutofix'), {
      raw: 'onCommand:eslint.executeAutofix',
      kind: 'onCommand',
      value: 'eslint.executeAutofix'
    })
    assert.deepEqual(parseActivationEvent('workspaceContains:package.json'), {
      raw: 'workspaceContains:package.json',
      kind: 'workspaceContains',
      value: 'package.json'
    })
    assert.equal(parseActivationEvent('onStartupFinished').kind, 'onStartupFinished')
    assert.equal(parseActivationEvent('*').kind, 'star')
    assert.equal(parseActivationEvent('onView:explorer').kind, 'other')
    assert.equal(parseActivationEvent('').kind, 'other')
  })

  it('indexes onLanguage case-insensitively with sorted candidates', () => {
    const index = buildActivationIndex([
      { extensionId: 'b.eslint@1.0.0', activationEvents: ['onLanguage:TypeScript'] },
      { extensionId: 'a.prettier@1.0.0', activationEvents: ['onLanguage:typescript'] }
    ])
    assert.deepEqual(extensionsForLanguage(index, 'typescript'), ['a.prettier@1.0.0', 'b.eslint@1.0.0'])
    assert.deepEqual(extensionsForLanguage(index, 'TYPESCRIPT'), ['a.prettier@1.0.0', 'b.eslint@1.0.0'])
    assert.deepEqual(extensionsForLanguage(index, 'python'), [])
  })

  it('indexes onCommand and startupFinished explicitly', () => {
    const index = buildActivationIndex([
      { extensionId: 'x.a@1.0.0', activationEvents: ['onCommand:x.run', 'onStartupFinished'] },
      { extensionId: 'x.b@1.0.0', activationEvents: ['onCommand:x.run'] }
    ])
    assert.deepEqual(extensionsForCommand(index, 'x.run'), ['x.a@1.0.0', 'x.b@1.0.0'])
    assert.deepEqual(extensionsForStartupFinished(index), ['x.a@1.0.0'])
  })

  it('never auto-indexes star extensions', () => {
    const index = buildActivationIndex([
      { extensionId: 'x.star@1.0.0', activationEvents: ['*'] },
      { extensionId: 'x.mixed@1.0.0', activationEvents: ['*', 'onLanguage:go'] }
    ])
    assert.deepEqual(extensionsForStartupFinished(index), [])
    assert.deepEqual(extensionsForCommand(index, '*'), [])
    // The mixed extension still fires on its explicit event only.
    assert.deepEqual(extensionsForLanguage(index, 'go'), ['x.mixed@1.0.0'])
    assert.deepEqual(extensionsForLanguage(index, 'rust'), [])
  })

  it('matches workspaceContains at root level only with bounded globs', () => {
    assert.equal(matchWorkspaceContainsPattern('package.json', ['package.json', 'src']), true)
    assert.equal(matchWorkspaceContainsPattern('package.json', ['src', 'README.md']), false)
    assert.equal(matchWorkspaceContainsPattern('*.json', ['tsconfig.json']), true)
    assert.equal(matchWorkspaceContainsPattern('**/package.json', ['package.json']), true)
    assert.equal(matchWorkspaceContainsPattern('src/package.json', ['package.json']), false)
    assert.equal(matchWorkspaceContainsPattern('', ['package.json']), false)
  })

  it('resolves workspace candidates deterministically', () => {
    const index = buildActivationIndex([
      { extensionId: 'b.eslint@1.0.0', activationEvents: ['workspaceContains:package.json'] },
      { extensionId: 'a.other@1.0.0', activationEvents: ['workspaceContains:*.sln'] }
    ])
    assert.deepEqual(extensionsForWorkspace(index, ['package.json']), ['b.eslint@1.0.0'])
    assert.deepEqual(extensionsForWorkspace(index, ['README.md']), [])
  })

  it('stays bounded for oversized inputs', () => {
    const events = Array.from({ length: 500 }, (_, i) => `onLanguage:lang${i}`)
    const index = buildActivationIndex([{ extensionId: 'x.big@1.0.0', activationEvents: events }])
    // Only the first 128 events index (manifest cap); the rest drop.
    assert.deepEqual(extensionsForLanguage(index, 'lang0'), ['x.big@1.0.0'])
    assert.deepEqual(extensionsForLanguage(index, 'lang400'), [])
    assert.ok((index.byLanguage.get('lang0') ?? []).length <= 128)
  })
})
