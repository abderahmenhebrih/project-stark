/**
 * Safe Monaco document identity plus a tiny model registry.
 *
 * Model URIs are synthetic (`inmemory://stark-workspace/…`) and carry
 * only the workspace id plus the encoded relative path — absolute host
 * paths never become model identity. The registry itself is Monaco
 * agnostic: callers inject a backend, so lifecycle policy is testable
 * without a Monaco implementation.
 */

export type EditorEol = 'LF' | 'CRLF'

/** Monaco operations behind the registry; implemented once in the UI layer. */
export interface DocumentBackend<THandle> {
  createModel: (uri: string, content: string, language: string, eol: EditorEol) => THandle
  disposeModel: (handle: THandle) => void
}

/** Synthetic, deterministic model URI for one workspace file. */
export function buildDocumentUri(workspaceId: number, relativePath: string): string {
  return `inmemory://stark-workspace/${workspaceId}/${encodeURIComponent(relativePath)}`
}

/** Synthetic model URI for one side of a transaction diff. */
export function buildDiffUri(transactionId: number, relativePath: string, side: 'before' | 'after'): string {
  return `inmemory://stark-change/${transactionId}/${encodeURIComponent(relativePath)}#${side}`
}

/**
 * Holds at most the models a caller opens. `openExclusive` disposes
 * every other entry so only the active document (plus, on a second
 * instance, the active diff pair) normally exists. Callers must still
 * confirm volatile-draft navigation BEFORE opening, so disposal never
 * destroys unconfirmed work.
 */
export class DocumentStore<THandle> {
  private readonly entries = new Map<string, { handle: THandle }>()

  /** Number of live registry entries. */
  get size(): number {
    return this.entries.size
  }

  /** Live registry keys, insertion order. */
  keys(): readonly string[] {
    return [...this.entries.keys()]
  }

  /**
   * Opens the model for one URI, replacing any same-URI entry without
   * touching others. Callers build URIs with buildDocumentUri /
   * buildDiffUri so identity stays synthetic and deterministic.
   */
  open(
    uri: string,
    content: string,
    language: string,
    eol: EditorEol,
    backend: DocumentBackend<THandle>
  ): THandle {
    this.close(uri, backend)
    const handle = backend.createModel(uri, content, language, eol)
    this.entries.set(uri, { handle })
    return handle
  }

  /**
   * Opens one entry and disposes every other live entry: the single
   * active document (or active diff pair on its own store) policy.
   */
  openExclusive(
    uri: string,
    content: string,
    language: string,
    eol: EditorEol,
    backend: DocumentBackend<THandle>
  ): THandle {
    for (const [existing, entry] of this.entries) {
      if (existing !== uri) {
        backend.disposeModel(entry.handle)
        this.entries.delete(existing)
      }
    }
    return this.open(uri, content, language, eol, backend)
  }

  /** Disposes one entry. Returns true when an entry existed. */
  close(uri: string, backend: DocumentBackend<THandle>): boolean {
    const entry = this.entries.get(uri)
    if (entry === undefined) {
      return false
    }
    backend.disposeModel(entry.handle)
    this.entries.delete(uri)
    return true
  }

  /** Disposes everything (unmount / workspace change). */
  clear(backend: DocumentBackend<THandle>): void {
    for (const entry of this.entries.values()) {
      backend.disposeModel(entry.handle)
    }
    this.entries.clear()
  }
}
