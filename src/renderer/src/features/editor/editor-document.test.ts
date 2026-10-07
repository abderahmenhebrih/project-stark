import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildDiffUri,
  buildDocumentUri,
  DocumentStore,
  type DocumentBackend,
  type EditorEol
} from './editor-document'

interface FakeHandle {
  readonly uri: string
}

interface Call {
  readonly kind: 'create' | 'dispose'
  readonly uri: string
  readonly content?: string
  readonly language?: string
  readonly eol?: EditorEol
}

function openBackend(calls: Call[]): DocumentBackend<FakeHandle> {
  return {
    createModel: (uri, content, language, eol) => {
      calls.push({ kind: 'create', uri, content, language, eol })
      return { uri }
    },
    disposeModel: (handle) => {
      calls.push({ kind: 'dispose', uri: handle.uri })
    }
  }
}

describe('editor document identity', () => {
  it('builds deterministic synthetic URIs without host paths', () => {
    const uri = buildDocumentUri(7, 'src/main.ts')
    assert.equal(uri, buildDocumentUri(7, 'src/main.ts'))
    assert.ok(uri.startsWith('inmemory://stark-workspace/7/'))
    assert.ok(!uri.includes('C:\\'))
    assert.ok(!uri.includes('/home/'))
    assert.ok(!uri.includes('src/main.ts') || uri.includes('src%2Fmain.ts'))
    assert.notEqual(buildDocumentUri(7, 'a.txt'), buildDocumentUri(8, 'a.txt'))
    assert.notEqual(buildDocumentUri(7, 'a.txt'), buildDocumentUri(7, 'b.txt'))
  })

  it('builds distinct diff URIs per transaction side', () => {
    const before = buildDiffUri(3, 'src/a.ts', 'before')
    const after = buildDiffUri(3, 'src/a.ts', 'after')
    assert.notEqual(before, after)
    assert.equal(buildDiffUri(3, 'src/a.ts', 'before'), before)
    assert.notEqual(before, buildDiffUri(4, 'src/a.ts', 'before'))
    assert.ok(!before.includes('src/a.ts') || before.includes('src%2Fa.ts'))
  })
})

describe('document store lifecycle', () => {
  it('opening B disposes obsolete A through exclusive open', () => {
    const calls: Call[] = []
    const backend = openBackend(calls)
    const store = new DocumentStore<FakeHandle>()
    store.openExclusive(buildDocumentUri(1, 'a.txt'), 'aaa', 'plaintext', 'LF', backend)
    store.openExclusive(buildDocumentUri(1, 'b.txt'), 'bbb', 'plaintext', 'LF', backend)
    assert.equal(store.size, 1)
    assert.deepEqual(store.keys(), [buildDocumentUri(1, 'b.txt')])
    assert.deepEqual(
      calls.map((call) => call.kind),
      ['create', 'dispose', 'create']
    )
    assert.equal(calls[1]?.uri, buildDocumentUri(1, 'a.txt'))
  })

  it('reopening the same URI replaces without growth', () => {
    const calls: Call[] = []
    const backend = openBackend(calls)
    const store = new DocumentStore<FakeHandle>()
    const uri = buildDocumentUri(1, 'a.txt')
    store.open(uri, 'one', 'plaintext', 'LF', backend)
    store.open(uri, 'two', 'plaintext', 'LF', backend)
    assert.equal(store.size, 1)
    assert.deepEqual(
      calls.map((call) => call.kind),
      ['create', 'dispose', 'create']
    )
  })

  it('workspace change clears every model', () => {
    const calls: Call[] = []
    const backend = openBackend(calls)
    const store = new DocumentStore<FakeHandle>()
    store.open(buildDocumentUri(1, 'a.txt'), 'aaa', 'plaintext', 'LF', backend)
    store.open(buildDiffUri(5, 'a.txt', 'before'), 'aaa', 'plaintext', 'LF', backend)
    store.open(buildDiffUri(5, 'a.txt', 'after'), 'bbb', 'plaintext', 'LF', backend)
    assert.equal(store.size, 3)
    store.clear(backend)
    assert.equal(store.size, 0)
    assert.equal(
      calls.filter((call) => call.kind === 'dispose').length,
      3
    )
  })

  it('closing a missing entry disposes nothing', () => {
    const calls: Call[] = []
    const backend = openBackend(calls)
    const store = new DocumentStore<FakeHandle>()
    assert.equal(store.close(buildDocumentUri(1, 'missing.txt'), backend), false)
    assert.deepEqual(calls, [])
  })

  it('transaction change disposes the old diff pair on its own store', () => {
    const calls: Call[] = []
    const backend = openBackend(calls)
    const diffs = new DocumentStore<FakeHandle>()
    diffs.open(buildDiffUri(5, 'a.txt', 'before'), 'aaa', 'typescript', 'LF', backend)
    diffs.open(buildDiffUri(5, 'a.txt', 'after'), 'bbb', 'typescript', 'LF', backend)
    assert.equal(diffs.size, 2)
    diffs.openExclusive(buildDiffUri(6, 'b.txt', 'before'), 'ccc', 'typescript', 'LF', backend)
    diffs.open(buildDiffUri(6, 'b.txt', 'after'), 'ddd', 'typescript', 'LF', backend)
    assert.equal(diffs.size, 2)
    const disposed = calls.filter((call) => call.kind === 'dispose').map((call) => call.uri)
    assert.ok(disposed.includes(buildDiffUri(5, 'a.txt', 'before')))
    assert.ok(disposed.includes(buildDiffUri(5, 'a.txt', 'after')))
  })

  it('records content, language, and EOL at creation', () => {
    const calls: Call[] = []
    const backend = openBackend(calls)
    const store = new DocumentStore<FakeHandle>()
    store.open(buildDocumentUri(2, 'src/x.ts'), 'a\r\nb', 'typescript', 'CRLF', backend)
    assert.equal(calls[0]?.content, 'a\r\nb')
    assert.equal(calls[0]?.language, 'typescript')
    assert.equal(calls[0]?.eol, 'CRLF')
  })
})
