/**
 * Single shared discard guard for unsaved editor drafts.
 *
 * File selection, Stage 7 search-result selection, and workspace
 * switching all consult this same helper before destroying a dirty
 * draft. The flag lives in module scope (not the global AppProvider):
 * the Explorer editor sets it, and every navigation trigger reads it.
 */

export const DISCARD_CONFIRM_MESSAGE = 'You have unsaved changes. Discard them?'

let unsavedDraft = false

/** Called by the Explorer editor whenever its derived dirty flag changes. */
export function setUnsavedDraft(value: boolean): void {
  unsavedDraft = value
}

/** True while an editor holds content differing from the last save. */
export function hasUnsavedDraft(): boolean {
  return unsavedDraft
}

/**
 * Returns true when navigation may proceed: no dirty draft, or the
 * user confirmed discarding it. Returns false when the user declines
 * (caller must stay on the current file/workspace) or when no
 * confirmation UI is available in a dirty state.
 */
export function confirmDiscardUnsavedDraft(confirm?: () => boolean): boolean {
  if (!unsavedDraft) {
    return true
  }
  if (confirm !== undefined) {
    return confirm()
  }
  // globalThis avoids a DOM lib dependency so this helper stays
  // unit-testable under the Node test build; browsers expose confirm.
  const candidate = (globalThis as { confirm?: unknown }).confirm
  if (typeof candidate === 'function') {
    return (candidate as (message: string) => boolean)(DISCARD_CONFIRM_MESSAGE)
  }
  return false
}
