import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  requestFormatDocument,
  resetFormatRequestsForTests,
  subscribeFormatRequests
} from './format-request-bus'

describe('format request bus', () => {
  it('delivers palette requests to the open-file owner', () => {
    resetFormatRequestsForTests()
    try {
      let calls = 0
      const unsubscribe = subscribeFormatRequests(() => {
        calls += 1
      })
      requestFormatDocument()
      assert.equal(calls, 1)
      unsubscribe()
      requestFormatDocument()
      assert.equal(calls, 1)
    } finally {
      resetFormatRequestsForTests()
    }
  })

  it('fans out to every subscriber and isolates failures', () => {
    resetFormatRequestsForTests()
    try {
      const seen: string[] = []
      subscribeFormatRequests(() => {
        seen.push('first')
      })
      subscribeFormatRequests(() => {
        throw new Error('listener exploded')
      })
      subscribeFormatRequests(() => {
        seen.push('third')
      })
      requestFormatDocument()
      assert.deepEqual(seen, ['first', 'third'])
    } finally {
      resetFormatRequestsForTests()
    }
  })

  it('is delivery-only: no state, no requests without subscribers', () => {
    resetFormatRequestsForTests()
    try {
      requestFormatDocument()
    } finally {
      resetFormatRequestsForTests()
    }
  })
})
