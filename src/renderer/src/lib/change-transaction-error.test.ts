import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CHANGE_CONFLICT_MESSAGE,
  CHANGE_CORRUPT_MESSAGE,
  CHANGE_GENERIC_MESSAGE,
  CHANGE_NO_CHANGES_MESSAGE,
  CHANGE_NOT_FOUND_MESSAGE,
  CHANGE_ROLLBACK_CONFLICT_MESSAGE,
  CHANGE_STATE_MESSAGE,
  CHANGE_TOO_LARGE_MESSAGE,
  CHANGE_UNSUPPORTED_MESSAGE,
  CHANGE_WORKSPACE_GONE_MESSAGE,
  normalizeChangeTransactionError
} from './change-transaction-error'

/**
 * Electron wraps invoke rejections as:
 * "Error invoking remote method '<channel>': Error: <public message>".
 * The boundary must recognize only the inner canonical application
 * message and never surface transport, database, or Node wording.
 */
function transported(channel: string, publicMessage: string): Error {
  return new Error(`Error invoking remote method '${channel}': Error: ${publicMessage}`)
}

const CREATE = 'stark:changes:create'

const FORBIDDEN_FRAGMENTS = [
  'Error invoking remote method',
  'stark:',
  'ipcRenderer',
  'Electron',
  '\n    at ',
  'ENOENT',
  'EACCES',
  'EPERM',
  'C:\\',
  '/tmp/',
  '.stark-tmp-',
  'UNIQUE constraint',
  'FOREIGN KEY',
  'sqlite'
]

function assertDisplaySafe(message: string): void {
  for (const fragment of FORBIDDEN_FRAGMENTS) {
    assert.ok(!message.includes(fragment), `display copy must not contain ${JSON.stringify(fragment)}: ${message}`)
  }
}

describe('change transaction error boundary', () => {
  it('maps each transported outcome to its canonical kind and message', () => {
    const cases = [
      {
        main: 'This file changed on disk. Reload it before saving your changes.',
        kind: 'conflict',
        message: CHANGE_CONFLICT_MESSAGE
      },
      {
        main: 'This file changed on disk. Reload it before rolling back this change.',
        kind: 'rollback-conflict',
        message: CHANGE_ROLLBACK_CONFLICT_MESSAGE
      },
      {
        main: 'This file is too large to save with the current editor.',
        kind: 'too-large',
        message: CHANGE_TOO_LARGE_MESSAGE
      },
      {
        main: 'This file isn’t a supported text file.',
        kind: 'unsupported-text',
        message: CHANGE_UNSUPPORTED_MESSAGE
      },
      {
        main: 'That change can’t be updated in its current state.',
        kind: 'invalid-state',
        message: CHANGE_STATE_MESSAGE
      },
      {
        main: 'There are no changes to review.',
        kind: 'no-changes',
        message: CHANGE_NO_CHANGES_MESSAGE
      },
      {
        main: 'That change’s stored data can’t be used.',
        kind: 'corrupt',
        message: CHANGE_CORRUPT_MESSAGE
      },
      {
        main: 'That change is no longer available.',
        kind: 'not-found',
        message: CHANGE_NOT_FOUND_MESSAGE
      },
      {
        main: 'That project folder is no longer available.',
        kind: 'workspace-gone',
        message: CHANGE_WORKSPACE_GONE_MESSAGE
      },
      { main: 'We couldn’t update this change.', kind: 'generic', message: CHANGE_GENERIC_MESSAGE }
    ] as const
    for (const expected of cases) {
      const normalized = normalizeChangeTransactionError(transported(CREATE, expected.main))
      assert.equal(normalized.kind, expected.kind)
      assert.equal(normalized.message, expected.message)
      assertDisplaySafe(normalized.message)
    }
  })

  it('prefers rollback-conflict over plain conflict classification', () => {
    const normalized = normalizeChangeTransactionError(
      transported('stark:changes:rollback', 'This file changed on disk. Reload it before rolling back this change.')
    )
    assert.equal(normalized.kind, 'rollback-conflict')
  })

  it('collapses unknown errors, strings, and missing values to generic copy', () => {
    const samples = [
      new Error('SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed'),
      new Error('secret internal detail'),
      new Error(''),
      'a thrown string',
      null,
      undefined,
      42,
      { message: 'That change is no longer available.' }
    ]
    for (const sample of samples) {
      const normalized = normalizeChangeTransactionError(sample)
      assert.equal(normalized.kind, 'generic')
      assert.equal(normalized.message, CHANGE_GENERIC_MESSAGE)
      assertDisplaySafe(normalized.message)
    }
  })
})
