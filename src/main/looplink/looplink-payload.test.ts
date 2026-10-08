import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LooplinkPayloadV1 } from '../../shared/looplink/types'
import {
  byteLengthOf,
  hashLooplinkPayload,
  serializeLooplinkPayload,
  verifyLooplinkPayload
} from './looplink-payload'
import { LooplinkIntegrityError } from './looplink-errors'

function basePayload(): LooplinkPayloadV1 {
  return {
    version: 1,
    source: { sessionId: 3, title: 'Build it' },
    messages: [
      { role: 'user', content: 'Hi.', createdAt: 1000 },
      { role: 'assistant', content: 'Hello.', createdAt: 2000 }
    ],
    explicitContext: [
      { kind: 'manual-note', label: 'Manual note', relativePath: null, lineStart: null, lineEnd: null, content: 'note' }
    ],
    orchestration: {
      status: 'completed',
      action: 'answer',
      planSummary: 'Direct.',
      workerResult: null,
      workerResultOmitted: false
    },
    changes: [
      {
        kind: 'transaction',
        transactionId: 9,
        changeSetId: null,
        relativePath: 'a.ts',
        summary: 'a.ts',
        status: 'pending',
        groupStatus: null
      }
    ],
    omissions: { messageCount: 1, contextCount: 0, workerResultOmitted: false, changeCount: 0 }
  }
}

describe('looplink payload', () => {
  it('serializes deterministically with exact bytes and valid hash', () => {
    const payload = basePayload()
    const first = serializeLooplinkPayload(payload)
    const second = serializeLooplinkPayload(JSON.parse(first) as LooplinkPayloadV1)
    assert.equal(first, second)
    assert.equal(byteLengthOf(first), Buffer.from(first, 'utf8').byteLength)
    const hash = hashLooplinkPayload(first)
    assert.match(hash, /^[0-9a-f]{64}$/)
    assert.deepEqual(verifyLooplinkPayload(first, hash), JSON.parse(first))
  })

  it('same source state yields the same semantic payload', () => {
    const a = serializeLooplinkPayload(basePayload())
    const b = serializeLooplinkPayload(basePayload())
    assert.equal(a, b)
    assert.equal(hashLooplinkPayload(a), hashLooplinkPayload(b))
  })

  it('tampering fails integrity with no provider call', () => {
    const serialized = serializeLooplinkPayload(basePayload())
    const hash = hashLooplinkPayload(serialized)
    const tampered = serialized.replace('Hello.', 'PWNED.')
    assert.throws(() => verifyLooplinkPayload(tampered, hash), LooplinkIntegrityError)
    assert.throws(() => verifyLooplinkPayload(serialized, '0'.repeat(64)), LooplinkIntegrityError)
    assert.throws(() => verifyLooplinkPayload(serialized, 'not-a-hash'), LooplinkIntegrityError)
    assert.throws(() => verifyLooplinkPayload('{bad json', hash), LooplinkIntegrityError)
  })

  it('omission metadata round-trips through serialization', () => {
    const payload: LooplinkPayloadV1 = {
      ...basePayload(),
      omissions: { messageCount: 4, contextCount: 2, workerResultOmitted: true, changeCount: 3 }
    }
    const verified = verifyLooplinkPayload(serializeLooplinkPayload(payload), hashLooplinkPayload(serializeLooplinkPayload(payload)))
    assert.deepEqual(verified.omissions, { messageCount: 4, contextCount: 2, workerResultOmitted: true, changeCount: 3 })
  })
})
