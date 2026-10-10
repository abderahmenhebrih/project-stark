import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registerStarkTheme, STARK_EDITOR_THEME_NAME, starkEditorTheme } from './editor-theme'

describe('stark editor theme', () => {
  it('uses the obsidian base with the STARK name', () => {
    assert.equal(STARK_EDITOR_THEME_NAME, 'stark-obsidian')
    const theme = starkEditorTheme()
    assert.equal(theme.base, 'vs-dark')
    assert.equal(theme.inherit, true)
    assert.ok(theme.rules.length > 0)
  })

  it('keeps surfaces near-black with light text', () => {
    const theme = starkEditorTheme()
    assert.equal(theme.colors['editor.background'], '#0A0C0A')
    assert.equal(theme.colors['editor.foreground'], '#E9F1EA')
  })

  it('reserves neon lime for caret and accents, not the whole grammar', () => {
    const theme = starkEditorTheme()
    assert.equal(theme.colors['editorCursor.foreground'], '#C8FF00')
    const limeRules = theme.rules.filter((rule) => rule.foreground.toUpperCase() === 'C8FF00')
    assert.deepEqual(limeRules, [], 'no token rule may wear UI lime')
  })

  it('gives every syntax category a distinct readable foreground', () => {
    const theme = starkEditorTheme()
    const byToken = new Map(theme.rules.map((rule) => [rule.token, rule.foreground.toLowerCase()]))
    for (const token of ['comment', 'keyword', 'string', 'number', 'type', 'function', 'property', 'identifier', 'delimiter']) {
      const foreground = byToken.get(token)
      assert.ok(typeof foreground === 'string' && /^[0-9a-f]{6}$/.test(foreground), `${token} must have a token rule`)
    }
    // Keywords read magenta-family (never lime, never default white).
    const keyword = byToken.get('keyword') ?? ''
    assert.ok(!['c8ff00', 'e9f1ea'].includes(keyword), 'keywords must be visually distinct')
    // No two semantic categories share one foreground: comments,
    // strings, keywords, types, numbers, functions and properties
    // must all differ from each other and from the default text.
    const varied = ['comment', 'keyword', 'string', 'number', 'type', 'function', 'property'].map((token) => byToken.get(token))
    assert.deepEqual([...new Set(varied)].length, varied.length, 'syntax categories must not share a foreground')
    assert.ok(!varied.includes('e9f1ea'), 'no syntax category may reuse the default text foreground')
  })

  it('carries no VS Code blue branding', () => {
    const serialized = JSON.stringify(starkEditorTheme()).toUpperCase()
    assert.ok(!serialized.includes('007ACC'))
    assert.ok(!serialized.includes('0000FF'))
  })

  it('registers and activates through the narrow seam exactly once each', () => {
    const calls: string[] = []
    registerStarkTheme({
      editor: {
        defineTheme: (name) => {
          calls.push(`define:${name}`)
        },
        setTheme: (name) => {
          calls.push(`set:${name}`)
        }
      }
    })
    assert.deepEqual(calls, [`define:${STARK_EDITOR_THEME_NAME}`, `set:${STARK_EDITOR_THEME_NAME}`])
  })
})
