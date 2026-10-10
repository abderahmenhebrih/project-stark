import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildLanguageOverrides, detectEditorLanguage, detectEditorLanguageWithOverrides } from './editor-language'
import { convertExtensionTheme } from './editor-theme'

describe('extension language overrides', () => {
  it('keeps built-in detection without overrides', () => {
    assert.equal(detectEditorLanguage('a.ts'), 'typescript')
    assert.equal(detectEditorLanguageWithOverrides('a.ts', null), 'typescript')
  })

  it('applies contributed extensions first-registration-wins', () => {
    const overrides = buildLanguageOverrides([
      { id: 'vue', extensions: ['.vue'] },
      { id: 'other', extensions: ['.vue'] }
    ])
    assert.equal(detectEditorLanguageWithOverrides('a.vue', overrides), 'vue')
    assert.equal(detectEditorLanguageWithOverrides('a.ts', overrides), 'typescript')
    assert.equal(detectEditorLanguageWithOverrides('a.unknown-ext', overrides), 'plaintext')
  })
})

describe('extension theme conversion', () => {
  it('converts token colors and editor colors, ignoring the shell', () => {
    const converted = convertExtensionTheme({
      uiTheme: 'vs-dark',
      colors: { 'editor.background': '#1E1E1E', 'editor.foreground': '#D4D4D4', 'not a key!': '#fff' },
      tokenColors: [
        { scope: 'comment', settings: { foreground: '#6A9955', fontStyle: 'italic' } },
        { scope: ['keyword', 'storage'], settings: { foreground: '#569CD6' } }
      ]
    })
    assert.ok(converted !== null)
    assert.equal(converted?.base, 'vs-dark')
    assert.ok((converted?.rules.length ?? 0) >= 2)
    assert.equal(converted?.colors['editor.background'], '#1e1e1e')
  })

  it('returns null when nothing usable survives', () => {
    assert.equal(convertExtensionTheme({ uiTheme: 'vs-dark', colors: {}, tokenColors: [] }), null)
  })
})
