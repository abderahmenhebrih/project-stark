import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * VS Code API compatibility inventory (Code OSS 1.90.0 target).
 *
 * Documents the ACTUAL supported subset the STARK Extension Host
 * exposes through its auditable shim — the foundation agent
 * extensions build on. Chat / language-model APIs are exposed as
 * explicit generic registries (participant/tool registration plus a
 * main-owned model gateway) so agent extensions use standard API
 * paths; unsupported or proposed surfaces still throw
 * `Unsupported VS Code API` instead of being faked.
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
      'export const authentication',
      'export const tasks',
      'export const debug',
      'export const scm',
      'export const chat',
      'export const lm',
      'export const tests',
      'export const comments'
    ]) {
      assert.ok(source.includes(domain), `shim must expose ${domain}`)
    }
    for (const type of ['export class Uri', 'export class EventEmitter', 'export class Disposable']) {
      assert.ok(source.includes(type), `shim must expose ${type}`)
    }
    assert.ok(!source.includes('new Proxy'), 'shim must not proxy unknown APIs')
  })

  it('exposes generic chat / language-model registries (never faked results)', () => {
    const lines = shimExports()
    assert.ok(lines.some((line) => line.includes('chat')), 'shim must expose the chat registry')
    assert.ok(
      lines.some((line) => line.startsWith('export const lm')),
      'shim must expose the language-model registry'
    )
    assert.ok(!lines.some((line) => /copilot/i.test(line)), 'shim must not claim provider APIs')
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'vscode-shim.mjs'), 'utf8')
    assert.ok(source.includes('Unsupported VS Code API'), 'unknown APIs must fail closed with an honest error')
    // No catch-all fake: model access routes through the main-owned
    // gateway and throws honestly without it.
    assert.ok(source.includes("lm.sendChatRequest (no language-model access)"))
  })
})
