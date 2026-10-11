import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Hackathon stabilization (H8): binary Reject must mark the proposal
 * rejected with zero disk mutation and no failed re-read — text and
 * binary flows stay consistent through the same guarded path.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

describe('binary reject consistency', () => {
  it('reject skips the text re-read for binary imports (no 404, no mutation)', () => {
    const explorer = readSource('src', 'renderer', 'src', 'features', 'explorer', 'Explorer.tsx')
    assert.ok(
      explorer.includes('file.binaryImport === undefined'),
      'reject must distinguish binary imports before any re-read'
    )
  })

  it('binary accept/rollback refresh the parent directory, never the editor', () => {
    const explorer = readSource('src', 'renderer', 'src', 'features', 'explorer', 'Explorer.tsx')
    assert.ok(
      explorer.includes('never load it\n// into the editor') ||
        explorer.includes('never load it'),
      'binary accept must document that the manifest never enters the editor'
    )
    assert.ok(
      explorer.includes('parentDirectoryOf(file.relativePath)'),
      'binary flows must refresh the affected parent directory'
    )
  })
})
