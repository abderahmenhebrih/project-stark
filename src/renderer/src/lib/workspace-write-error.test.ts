import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyDraftChange,
  createEditorState,
  markEditorConflict,
  markEditorSaveFailed,
  markEditorSaving
} from '../features/explorer/editor-state'
import {
  normalizeWorkspaceWriteError,
  WRITE_CONFLICT_MESSAGE,
  WRITE_GENERIC_MESSAGE,
  WRITE_TOO_LARGE_MESSAGE,
  WRITE_UNSUPPORTED_MESSAGE
} from './workspace-write-error'

const REVISION_A = 'a'.repeat(64)

/**
 * Electron wraps invoke rejections as:
 * "Error invoking remote method '<channel>': Error: <public message>".
 * The boundary must recognize only the inner canonical application
 * message and never surface the transport wording.
 */
function transported(publicMessage: string): Error {
  return new Error(
    `Error invoking remote method 'stark:workspace-files:write-text-file': Error: ${publicMessage}`
  )
}

const FORBIDDEN_FRAGMENTS = [
  'Error invoking remote method',
  'stark:',
  'ipcRenderer',
  'Electron',
  'at ',
  'ENOENT',
  'EACCES',
  'EPERM',
  'C:\\',
  '/tmp/',
  '.stark-tmp-'
]

function assertDisplaySafe(message: string): void {
  for (const fragment of FORBIDDEN_FRAGMENTS) {
    assert.ok(!message.includes(fragment), `display copy must not contain ${JSON.stringify(fragment)}: ${message}`)
  }
}

describe('workspace write error boundary', () => {
  it('maps a transported conflict to the canonical conflict message only', () => {
    const normalized = normalizeWorkspaceWriteError(
      transported('This file changed on disk. Reload it before saving your changes.')
    )
    assert.equal(normalized.kind, 'conflict')
    assert.equal(normalized.message, WRITE_CONFLICT_MESSAGE)
    assert.equal(normalized.message, 'This file changed on disk. Reload it before saving your changes.')
    assertDisplaySafe(normalized.message)
  })

  it('maps a transported too-large failure to the canonical too-large message only', () => {
    const normalized = normalizeWorkspaceWriteError(transported('This file is too large to save.'))
    assert.equal(normalized.kind, 'too-large')
    assert.equal(normalized.message, WRITE_TOO_LARGE_MESSAGE)
    assert.equal(normalized.message, 'This file is too large to save with the current editor.')
    assertDisplaySafe(normalized.message)
  })

  it('maps a transported unsupported-text failure to the canonical message only', () => {
    const normalized = normalizeWorkspaceWriteError(transported('This file isn’t a supported text file.'))
    assert.equal(normalized.kind, 'unsupported-text')
    assert.equal(normalized.message, WRITE_UNSUPPORTED_MESSAGE)
    assertDisplaySafe(normalized.message)
  })

  it('maps a transported unavailable failure to the canonical unavailable message only', () => {
    const normalized = normalizeWorkspaceWriteError(transported('We couldn’t save this file.'))
    assert.equal(normalized.kind, 'unavailable')
    assert.equal(normalized.message, WRITE_GENERIC_MESSAGE)
    assertDisplaySafe(normalized.message)
  })

  it('collapses arbitrary unknown errors to the generic message', () => {
    const normalized = normalizeWorkspaceWriteError(new Error('secret internal detail ENOENT /etc/passwd'))
    assert.equal(normalized.kind, 'generic')
    assert.equal(normalized.message, 'We couldn’t save this file.')
    assert.ok(!normalized.message.includes('secret internal detail'))
    assertDisplaySafe(normalized.message)
  })

  it('collapses thrown strings to the generic message', () => {
    const normalized = normalizeWorkspaceWriteError('This file changed on disk. Reload it before saving your changes.')
    assert.equal(normalized.kind, 'generic')
    assert.equal(normalized.message, 'We couldn’t save this file.')
  })

  it('collapses null and undefined to the generic message', () => {
    for (const value of [null, undefined, 0, false, {}, { message: 'This file changed on disk.' }]) {
      const normalized = normalizeWorkspaceWriteError(value)
      assert.equal(normalized.kind, 'generic')
      assert.equal(normalized.message, 'We couldn’t save this file.')
    }
  })

  it('never emits transport or internals wording', () => {
    const samples = [
      transported('This file changed on disk. Reload it before saving your changes.'),
      transported('This file is too large to save.'),
      transported('This file isn’t a supported text file.'),
      transported('We couldn’t save this file.'),
      new Error('secret internal detail'),
      'a string',
      null,
      undefined,
      new Error('')
    ]
    for (const sample of samples) {
      assertDisplaySafe(normalizeWorkspaceWriteError(sample).message)
    }
  })

  it('conflict classification still drives conflict UI state', () => {
    const edited = markEditorSaving(applyDraftChange(createEditorState('old', REVISION_A), 'new'))
    const normalized = normalizeWorkspaceWriteError(
      transported('This file changed on disk. Reload it before saving your changes.')
    )
    const next =
      normalized.kind === 'conflict'
        ? markEditorConflict(edited, normalized.message)
        : markEditorSaveFailed(edited, normalized.message)
    assert.equal(next.conflict, true)
    assert.equal(next.saveError, WRITE_CONFLICT_MESSAGE)
  })

  it('failed saves still preserve the draft', () => {
    const edited = markEditorSaving(applyDraftChange(createEditorState('old', REVISION_A), 'new'))
    const conflicted = markEditorConflict(
      edited,
      normalizeWorkspaceWriteError(transported('This file changed on disk. Reload it before saving your changes.')).message
    )
    assert.equal(conflicted.draftContent, 'new')
    const failed = markEditorSaveFailed(
      edited,
      normalizeWorkspaceWriteError(new Error('boom ENOENT')).message
    )
    assert.equal(failed.draftContent, 'new')
    assert.equal(failed.conflict, false)
  })
})
