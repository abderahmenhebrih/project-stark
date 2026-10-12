import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * VS Code API compatibility inventory (§10/§11 evidence).
 *
 * Documents the ACTUAL supported subset the STARK Extension Host
 * exposes through its auditable shim — the foundation agent
 * extensions build on. Chat / language-model APIs are honestly
 * absent (the shim throws `Unsupported VS Code API` instead of
 * faking them), which is why agent execution flows through
 * manifest-declared commands today.
 */

function shimExports(): readonly string[] {
  const source = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'vscode-shim.mjs'), 'utf8')
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('export '))
}

describe('vscode compatibility inventory', () => {
  it('exposes the safe generic subset (no catch-all, no proxy)', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'vscode-shim.mjs'), 'utf8')
    for (const domain of [
      'export const commands',
      'export const workspace',
      'export const window',
      'export const languages',
      'export const extensions',
      'export const env',
      'export const authentication'
    ]) {
      assert.ok(source.includes(domain), `shim must expose ${domain}`)
    }
    for (const type of ['export class Uri', 'export class EventEmitter', 'export class Disposable']) {
      assert.ok(source.includes(type), `shim must expose ${type}`)
    }
    assert.ok(!source.includes('new Proxy'), 'shim must not proxy unknown APIs')
  })

  it('honestly lacks chat / language-model APIs (never faked)', () => {
    const lines = shimExports()
    for (const line of lines) {
      assert.ok(!/chat/i.test(line), `shim must not claim chat APIs (${line.slice(0, 80)})`)
      assert.ok(!/languagemodel/i.test(line), `shim must not claim language-model APIs (${line.slice(0, 80)})`)
      assert.ok(!/copilot/i.test(line), `shim must not claim provider APIs (${line.slice(0, 80)})`)
    }
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'vscode-shim.mjs'), 'utf8')
    assert.ok(source.includes('Unsupported VS Code API'), 'unknown APIs must fail closed with an honest error')
  })
})
