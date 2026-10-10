import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseContributions, summarizeCapabilities } from './extension-contributions'

describe('contribution engine', () => {
  it('parses declarative contributions with bounds', () => {
    const parsed = parseContributions({
      languages: [{ id: 'typescript', extensions: ['.ts'], aliases: ['TypeScript'] }],
      grammars: [{ language: 'typescript', scopeName: 'source.ts', path: './syntaxes/ts.tmLanguage.json' }],
      snippets: [{ language: 'typescript', path: './snippets/ts.json' }],
      themes: [{ id: 'dark-plus', label: 'Dark Plus', path: './themes/dark.json', uiTheme: 'vs-dark' }],
      iconThemes: [{ id: 'icons', label: 'Icons', path: './icons/theme.json' }],
      commands: [{ command: 'eslint.executeAutofix', title: 'Fix all', category: 'ESLint' }],
      keybindings: [{ command: 'eslint.executeAutofix', key: 'ctrl+shift+f' }],
      configuration: {
        title: 'ESLint',
        properties: {
          'eslint.enable': { type: 'boolean', default: true, description: 'Enable ESLint' },
          'eslint.codeAction.showDocumentation': { type: 'string', enum: ['show', 'hide'], default: 'show' }
        }
      }
    })
    assert.equal(parsed.languages[0]?.id, 'typescript')
    assert.equal(parsed.grammars[0]?.scopeName, 'source.ts')
    assert.equal(parsed.snippets[0]?.path, './snippets/ts.json')
    assert.equal(parsed.themes[0]?.uiTheme, 'vs-dark')
    assert.equal(parsed.iconThemes[0]?.id, 'icons')
    assert.equal(parsed.commands[0]?.command, 'eslint.executeAutofix')
    assert.equal(parsed.keybindings[0]?.key, 'ctrl+shift+f')
    assert.equal(parsed.configuration.get('eslint.enable')?.default, true)
    assert.deepEqual(parsed.otherKeys, [])
  })

  it('rejects traversal paths and unknown shapes without executing', () => {
    const parsed = parseContributions({
      grammars: [{ language: 'x', scopeName: 's', path: '../../evil.json' }],
      themes: [{ label: 'T', path: '/abs/theme.json' }],
      languages: [{ id: '../evil' }],
      commands: [{ command: 'bad id!', title: 'Bad' }]
    })
    assert.equal(parsed.grammars.length, 0)
    assert.equal(parsed.themes.length, 0)
    assert.equal(parsed.languages.length, 0)
    assert.equal(parsed.commands.length, 0)
  })

  it('surfaces non-declarative keys for the compat analyzer', () => {
    const parsed = parseContributions({ webviews: [], debuggers: [] })
    assert.deepEqual(parsed.otherKeys, ['webviews', 'debuggers'])
  })

  it('derives honest capability summaries from evidence only', () => {
    const caps = summarizeCapabilities({
      hasMain: true,
      activationEvents: ['onLanguage:typescript'],
      contributesCommands: 2,
      observedProviders: ['documentFormatter'],
      observedChildProcesses: 0
    })
    assert.equal(caps.runsCode, true)
    assert.equal(caps.proposesEdits, true)
    assert.equal(caps.mayStartLanguageServer, true)
    const quiet = summarizeCapabilities({
      hasMain: false,
      activationEvents: [],
      contributesCommands: 0,
      observedProviders: [],
      observedChildProcesses: 0
    })
    assert.equal(quiet.runsCode, false)
    assert.equal(quiet.proposesEdits, false)
  })
})
