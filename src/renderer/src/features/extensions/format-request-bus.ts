/**
 * Renderer-side Format Document request bus.
 *
 * The Command Palette (Ctrl+Shift+P, mounted at the app root) lists a
 * built-in "Format Document" entry, but only the Explorer owns the
 * open file, the dirty guard, the trust flow, and the review
 * pipeline. Publishers fire here; the Explorer subscribes and runs
 * its existing format handler — the same one the editor right-click
 * menu uses. No IPC, no state, no filesystem: delivery only.
 * Listener failures never break delivery to others.
 */

type FormatRequestListener = () => void

const listeners = new Set<FormatRequestListener>()

/** Requests a Format Document run from whoever owns the open file. */
export function requestFormatDocument(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // Listener failures never break delivery.
    }
  }
}

/** Subscribes a format handler (returns unsubscribe). */
export function subscribeFormatRequests(listener: FormatRequestListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: clears subscribers. */
export function resetFormatRequestsForTests(): void {
  listeners.clear()
}
