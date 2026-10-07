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
    assert.ok(limeRules.length >= 1)
    assert.ok(limeRules.length < theme.rules.length)
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
