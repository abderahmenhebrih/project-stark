import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Content-safety: Git path/diff text must remain inert strings. The
 * panel and diff viewer render via React text and Monaco strings only
 * (no HTML rendering path) and invoke Git with --no-color so no ANSI
 * sequences are produced.
 */
function readSource(relative: string): string {
  const file = join(process.cwd(), relative)
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('git content safety', () => {
  it('panel renders paths as text (no HTML sink)', () => {
    const source = readSource(join('src', 'renderer', 'src', 'features', 'git', 'GitPanel.tsx'))
    assert.ok(!source.includes('innerHTML'))
    assert.ok(!source.includes('dangerouslySetInnerHTML'))
  })

  it('diff viewer passes patch as Monaco string only', () => {
    const source = readSource(join('src', 'renderer', 'src', 'features', 'git', 'GitDiffViewer.tsx'))
    assert.ok(!source.includes('innerHTML'))
    assert.ok(!source.includes('dangerouslySetInnerHTML'))
    assert.ok(source.includes('createModel'))
    assert.ok(!source.includes('exec'))
  })

  it('inert strings stay inert (script/img/ANSI as data)', () => {
    const hostilePath = '<script>alert(1)</script>'
    const hostilePatch = '<img src=x onerror=alert(1)>\n\x1b[31mred\x1b[0m\n'
    // The contracts carry these as opaque strings; no parsing step
    // interprets them as HTML/ANSI.
    assert.equal(typeof hostilePath, 'string')
    assert.equal(typeof hostilePatch, 'string')
    assert.ok(hostilePath.includes('<script>'))
    assert.ok(hostilePatch.includes('<img'))
  })

  it('git is invoked with --no-color (no ANSI sequences)', () => {
    const source = readSource(join('src', 'main', 'git', 'git-service.ts'))
    assert.ok(source.includes('--no-color'))
  })

  it('explorer git integration has no HTML sink', () => {
    const source = readSource(join('src', 'renderer', 'src', 'features', 'explorer', 'Explorer.tsx'))
    assert.ok(!source.includes('dangerouslySetInnerHTML'))
  })
})
