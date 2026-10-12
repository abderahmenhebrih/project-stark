import { useEffect, useState } from 'react'
import type { CloudAccountStatus } from '../../../../shared/cloud-account/types'
import { getAccountStatus, subscribeAccountUpdates } from '../../lib/account-api'

/**
 * Canonical renderer account state (Stage 29).
 *
 * ONE shared source for every surface that needs the sign-in truth:
 * SessionPanel (Free hosted gate + Usage), BillingSettings, and any
 * future consumer. Mount-time `getAccountStatus()` captures the
 * restored session (no Settings visit needed); the live
 * `accountUpdated` subscription applies restore broadcasts, OAuth
 * sign-in completions, and sign-outs immediately with no
 * remount/restart. Main owns the truth (CloudAccountService);
 * preload validates every pushed payload; the renderer only ever
 * sees status/displayName/email/provider — never tokens.
 */
export function useAccountStatus(): CloudAccountStatus | null {
  const [status, setStatus] = useState<CloudAccountStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    getAccountStatus().then(
      (next) => {
        if (!cancelled) {
          setStatus(next)
        }
      },
      () => {
        if (!cancelled) {
          setStatus(null)
        }
      }
    )
    const unsubscribe = subscribeAccountUpdates((next) => {
      if (!cancelled) {
        setStatus(next)
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return status
}
