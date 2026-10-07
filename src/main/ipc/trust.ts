import { isTrustedRendererUrl, type RendererTrustPolicy } from './sender'

/**
 * Sender trust decision for IPC handlers.
 *
 * Pure function of its inputs (no Electron imports) so the enforcement
 * logic itself is unit-testable with fake senders. handleSecureIpc in
 * ./index.ts supplies the real event values; the production rule compares
 * against STARK's exact renderer entry document.
 */
export function isTrustedIpcSender(
  senderDestroyed: boolean,
  senderUrl: string | undefined,
  policy: RendererTrustPolicy
): boolean {
  if (senderDestroyed) {
    return false
  }
  return isTrustedRendererUrl(senderUrl, policy)
}
