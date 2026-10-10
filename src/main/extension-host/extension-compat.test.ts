import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { analyzeCompatibility, compatibilityLabel } from './extension-compat'

describe('compatibility analyzer', () => {
  it('marks declarative extensions compatible without activation', () => {
    const result = analyzeCompatibility({
      hasMain: false,
      hasBrowserOnly: false,
      contributesKeys: ['themes', 'snippets', 'languages', 'configuration', 'commands'],
      unsupportedApis: [],
      proposedApis: [],
      hasNativeModules: false,
      activationFailed: false,
      failureCode: null
    })
    assert.equal(result.level, 'compatible')
    assert.deepEqual(result.reasons, [])
    assert.equal(compatibilityLabel(result.level), 'Compatible')
  })

  it('marks grammars partial (recognized, highlighted by built-ins)', () => {
    const result = analyzeCompatibility({
      hasMain: false,
      hasBrowserOnly: false,
      contributesKeys: ['grammars'],
      unsupportedApis: [],
      proposedApis: [],
      hasNativeModules: false,
      activationFailed: false,
      failureCode: null
    })
    assert.equal(result.level, 'partial')
    assert.ok(result.reasons.some((reason) => reason.includes('grammar')))
  })

  it('marks browser-only extensions unsupported honestly', () => {
    const result = analyzeCompatibility({
      hasMain: false,
      hasBrowserOnly: true,
      contributesKeys: [],
      unsupportedApis: [],
      proposedApis: [],
      hasNativeModules: false,
      activationFailed: false,
      failureCode: null
    })
    assert.equal(result.level, 'unsupported')
    assert.ok(result.reasons.some((reason) => reason.includes('Browser')))
    assert.equal(compatibilityLabel(result.level), 'Unsupported')
  })

  it('downgrades on observed unsupported and proposed APIs', () => {
    const partial = analyzeCompatibility({
      hasMain: true,
      hasBrowserOnly: false,
      contributesKeys: ['commands'],
      unsupportedApis: ['vscode.debug'],
      proposedApis: [],
      hasNativeModules: false,
      activationFailed: false,
      failureCode: null
    })
    assert.equal(partial.level, 'partial')
    assert.ok(partial.reasons.some((reason) => reason.includes('vscode.debug')))
    const proposed = analyzeCompatibility({
      hasMain: true,
      hasBrowserOnly: false,
      contributesKeys: ['commands'],
      unsupportedApis: [],
      proposedApis: ['proposed:terminalDataWriteEvent'],
      hasNativeModules: false,
      activationFailed: false,
      failureCode: null
    })
    assert.equal(proposed.level, 'partial')
  })

  it('marks debuggers unsupported and webviews partial', () => {
    const debug = analyzeCompatibility({
      hasMain: true,
      hasBrowserOnly: false,
      contributesKeys: ['debuggers'],
      unsupportedApis: [],
      proposedApis: [],
      hasNativeModules: false,
      activationFailed: false,
      failureCode: null
    })
    assert.equal(debug.level, 'unsupported')
    const webview = analyzeCompatibility({
      hasMain: true,
      hasBrowserOnly: false,
      contributesKeys: ['webviews'],
      unsupportedApis: [],
      proposedApis: [],
      hasNativeModules: false,
      activationFailed: false,
      failureCode: null
    })
    assert.equal(webview.level, 'partial')
  })

  it('rejects native modules and reports activation failures', () => {
    const native = analyzeCompatibility({
      hasMain: true,
      hasBrowserOnly: false,
      contributesKeys: [],
      unsupportedApis: [],
      proposedApis: [],
      hasNativeModules: true,
      activationFailed: false,
      failureCode: null
    })
    assert.equal(native.level, 'unsupported')
    const failed = analyzeCompatibility({
      hasMain: true,
      hasBrowserOnly: false,
      contributesKeys: ['commands'],
      unsupportedApis: [],
      proposedApis: [],
      hasNativeModules: false,
      activationFailed: true,
      failureCode: 'timeout'
    })
    assert.equal(failed.level, 'partial')
    assert.ok(failed.reasons.some((reason) => reason.includes('timeout')))
  })

  it('never invents percentages', () => {
    const result = analyzeCompatibility({
      hasMain: true,
      hasBrowserOnly: false,
      contributesKeys: ['unknownFutureThing'],
      unsupportedApis: [],
      proposedApis: [],
      hasNativeModules: false,
      activationFailed: false,
      failureCode: null
    })
    assert.equal(result.level, 'partial')
    assert.ok(result.reasons.every((reason) => !reason.includes('%')))
  })

  it('treats supported jsonValidation as compatible (real Prettier 12.4.0 shape)', () => {
    const result = analyzeCompatibility({
      hasMain: true,
      hasBrowserOnly: false,
      contributesKeys: ['configuration', 'jsonValidation', 'languages', 'commands'],
      unsupportedApis: [],
      proposedApis: [],
      hasNativeModules: false,
      activationFailed: false,
      failureCode: null
    })
    assert.equal(result.level, 'compatible')
    assert.deepEqual(result.reasons, [])
  })

  it('deduplicates identical reasons with stable ordering', () => {
    const result = analyzeCompatibility({
      hasMain: true,
      hasBrowserOnly: false,
      contributesKeys: ['webviews', 'webviews', 'unknownThing', 'unknownThing'],
      unsupportedApis: ['vscode.debug', 'vscode.debug'],
      proposedApis: [],
      hasNativeModules: false,
      activationFailed: true,
      failureCode: 'timeout'
    })
    assert.equal(result.level, 'partial')
    assert.deepEqual(result.reasons, [...new Set(result.reasons)])
    assert.equal(result.reasons.filter((reason) => reason.includes('webview')).length, 1)
    assert.equal(result.reasons.filter((reason) => reason.includes('vscode.debug')).length, 1)
  })
})
