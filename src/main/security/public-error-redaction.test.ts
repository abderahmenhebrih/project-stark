import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { toPublicBrainError } from '../ai/ai-brain-errors'
import { toPublicChangeSetProposalError } from '../ai/ai-change-set-errors'
import { toPublicProposalError } from '../ai/ai-proposal-errors'
import { toPublicProviderError } from '../ai/errors'
import { toPublicCapabilityError } from '../capabilities/capability-errors'
import { toPublicChangeSetError } from '../change-sets/errors'
import { toPublicChangeError } from '../change-transactions/errors'
import { toPublicAccountError } from '../cloud-account/cloud-account-errors'
import { toPublicGitError } from '../git/errors'
import { toPublicHeartError } from '../heart/heart-errors'
import { toPublicLooplinkError } from '../looplink/looplink-errors'
import { toPublicError as toPublicProfileError } from '../profile/errors'
import { toPublicProjectRuntimeError } from '../project-runtime/project-runtime-errors'
import { toPublicRecoveryError } from '../recovery/recovery-errors'
import { toPublicContextError } from '../session-context/errors'
import { toPublicSessionError } from '../sessions/errors'
import { toPublicError as toPublicSettingsError } from '../settings/errors'
import { toPublicTerminalError } from '../terminal/errors'
import { toPublicUsageError } from '../usage/ai-usage-errors'
import { toPublicWorkerToolError } from '../worker-tools/worker-tool-errors'
import { toPublicError as toPublicWorkspaceError } from '../workspace/errors'

/**
 * Release redaction sweep (Stage 30): every renderer-visible error
 * mapper must collapse a hostile failure (key, tokens, code, raw
 * body, absolute path, env dump) to safe copy. Behavioral — real
 * mappers, real hostile inputs.
 */
const HOSTILE = new Error(
  'boom sk-SECRETKEY12345678 ACCESS_SECRET_123 REFRESH_SECRET_456 CODE_SECRET_789 ' +
    'C:\\Users\\victim\\proj\\secret.txt {"raw":"body"} ENV=whatever STACK at foo (bar.js:1:2)'
)

const SECRETS = [
  'SECRETKEY',
  'ACCESS_SECRET_123',
  'REFRESH_SECRET_456',
  'CODE_SECRET_789',
  'victim',
  'secret.txt',
  '"raw"',
  'ENV=whatever',
  'at foo'
]

function assertRedacted(message: string, where: string): void {
  for (const secret of SECRETS) {
    assert.ok(!message.includes(secret), `${where} leaks ${secret}: ${message}`)
  }
}

describe('public error redaction sweep', () => {
  it('maps every domain hostile failure to secret-free copy', () => {
    const outputs: Array<[string, string]> = [
      ['brain', toPublicBrainError('run', HOSTILE).message],
      ['change-set-proposal', toPublicChangeSetProposalError('propose-set', HOSTILE).message],
      ['proposal', toPublicProposalError('propose', HOSTILE).message],
      ['provider', toPublicProviderError('generate', HOSTILE).message],
      ['capability', toPublicCapabilityError('update', HOSTILE).message],
      ['change-set', toPublicChangeSetError('get', HOSTILE).message],
      ['change-transaction', toPublicChangeError(HOSTILE).message],
      ['account', toPublicAccountError('callback', HOSTILE).message],
      ['git', toPublicGitError('diff', HOSTILE).message],
      ['heart', toPublicHeartError('route', HOSTILE).message],
      ['looplink', toPublicLooplinkError('create', HOSTILE).message],
      ['profile', toPublicProfileError('get', HOSTILE).message],
      ['runtime', toPublicProjectRuntimeError('preview', HOSTILE).message],
      ['recovery', toPublicRecoveryError('recover', HOSTILE).message],
      ['context', toPublicContextError('send', HOSTILE).message],
      ['session', toPublicSessionError('send', HOSTILE).message],
      ['settings', toPublicSettingsError('update', HOSTILE).message],
      ['terminal', toPublicTerminalError('create', HOSTILE).message],
      ['usage', toPublicUsageError('summary', HOSTILE).message],
      ['worker-tools', toPublicWorkerToolError('run', HOSTILE).message],
      ['workspace', toPublicWorkspaceError('read-text-file', HOSTILE).message]
    ]
    assert.equal(outputs.length, 21)
    for (const [domain, message] of outputs) {
      assert.ok(message !== '', `${domain} must produce copy`)
      assertRedacted(message, domain)
    }
  })
})
