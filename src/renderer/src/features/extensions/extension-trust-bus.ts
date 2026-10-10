/**
 * Renderer-side extension trust-request bus (Step 8+9).
 *
 * Demand-driven activation of an untrusted extension never runs it
 * silently: the runtime reports `needsTrust`, callers enqueue a
 * request here, and the global overlays render the generic trust
 * dialog ("STARK is about to run <name>. VS Code extensions can
 * execute code on your computer." + Cancel / Run + Trust checkbox).
 * One entry per extension id (dedupe); explicit user action resolves.
 */

export interface TrustRequest {
  readonly key: string
  readonly namespace: string
  readonly name: string
  readonly version: string
  readonly displayName: string
}

type TrustListener = (requests: readonly TrustRequest[]) => void

const listeners = new Set<TrustListener>()
let queue: TrustRequest[] = []

function emit(): void {
  const snapshot = [...queue]
  for (const listener of [...listeners]) {
    try {
      listener(snapshot)
    } catch {
      // Listener failures never break the queue.
    }
  }
}

/** Enqueues one trust request (dedupe by exact version). */
export function requestExtensionTrust(request: Omit<TrustRequest, 'key'>): void {
  const key = `${request.namespace}.${request.name}@${request.version}`
  if (queue.some((entry) => entry.key === key)) {
    return
  }
  queue = [...queue, { ...request, key }].slice(-8)
  emit()
}

/** Removes one request (dialog dismissed or resolved). */
export function removeTrustRequest(key: string): void {
  if (!queue.some((entry) => entry.key === key)) {
    return
  }
  queue = queue.filter((entry) => entry.key !== key)
  emit()
}

/** Subscribes to the pending-trust queue (returns unsubscribe). */
export function subscribeTrustQueue(listener: TrustListener): () => void {
  listeners.add(listener)
  listener([...queue])
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: clears the queue. */
export function resetTrustQueueForTests(): void {
  queue = []
  emit()
}

/** Document-change sync debounce (ms) for host snapshots. */
export const EXTENSION_DOC_SYNC_DEBOUNCE_MS = 600

/** Builds the host document uri for a workspace-relative path. */
export function extensionDocUri(relativePath: string): string {
  return `file:${relativePath.replace(/\\/g, '/')}`
}
