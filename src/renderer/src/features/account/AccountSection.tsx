import { useEffect, useReducer, type ReactElement } from 'react'
import type { StarkAuthProvider } from '../../../../shared/cloud-account/types'
import {
  cancelAccountSignIn,
  getAccountStatus,
  signOutAccount,
  startAccountSignIn,
  subscribeAccountUpdates
} from '../../lib/account-api'
import { ACCOUNT_GENERIC_MESSAGE, normalizeAccountError } from '../../lib/account-error'
import { accountPanelReducer, accountProviderLabel, initialAccountPanelState } from './account-state'

/**
 * Optional STARK Account section (Stage 29).
 *
 * Local-first copy throughout: signing in never uploads projects and
 * signing out never deletes local work. Tokens are never displayed;
 * only provider, display name, email, and a safe HTTPS avatar shape
 * (rendered as initials by default to avoid widening img-src CSP).
 */
export function AccountSection(): ReactElement {
  const [state, dispatch] = useReducer(accountPanelReducer, undefined, initialAccountPanelState)

  useEffect(() => {
    let cancelled = false
    dispatch({ type: 'status-loading' })
    getAccountStatus().then(
      (status) => {
        if (!cancelled) {
          dispatch({ type: 'status-loaded', status })
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          dispatch({ type: 'status-failed', message: normalizeAccountError(error).message })
        }
      }
    )
    const unsubscribe = subscribeAccountUpdates((status) => {
      if (!cancelled) {
        dispatch({ type: 'pushed', status })
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  async function handleStart(provider: StarkAuthProvider): Promise<void> {
    if (state.acting) {
      return
    }
    dispatch({ type: 'action-started' })
    try {
      await startAccountSignIn(provider)
      const status = await getAccountStatus()
      dispatch({ type: 'action-succeeded', status, notice: null })
    } catch (error: unknown) {
      dispatch({
        type: 'action-failed',
        message: normalizeAccountError(error, ACCOUNT_GENERIC_MESSAGE).message
      })
    }
  }

  async function handleCancel(): Promise<void> {
    if (state.acting) {
      return
    }
    dispatch({ type: 'action-started' })
    try {
      const status = await cancelAccountSignIn()
      dispatch({ type: 'action-succeeded', status, notice: null })
    } catch (error: unknown) {
      dispatch({
        type: 'action-failed',
        message: normalizeAccountError(error, ACCOUNT_GENERIC_MESSAGE).message
      })
    }
  }

  async function handleSignOut(): Promise<void> {
    if (state.acting) {
      return
    }
    dispatch({ type: 'action-started' })
    try {
      const status = await signOutAccount()
      dispatch({ type: 'action-succeeded', status, notice: 'Signed out. Your local projects remain on this device.' })
    } catch (error: unknown) {
      dispatch({
        type: 'action-failed',
        message: normalizeAccountError(error, ACCOUNT_GENERIC_MESSAGE).message
      })
    }
  }

  if (state.loading && state.status === null) {
    return (
      <section aria-label="STARK Account">
        <h2>STARK Account</h2>
        <p role="status">Loading account…</p>
      </section>
    )
  }

  if (state.loadError !== null && state.status === null) {
    return (
      <section aria-label="STARK Account">
        <h2>STARK Account</h2>
        <p role="alert">{state.loadError}</p>
      </section>
    )
  }

  const status = state.status
  if (status === null) {
    return (
      <section aria-label="STARK Account">
        <h2>STARK Account</h2>
        <p role="status">Loading account…</p>
      </section>
    )
  }

  if (status.state === 'unavailable') {
    return (
      <section aria-label="STARK Account">
        <h2>STARK Account</h2>
        <p>Cloud account features are unavailable in this build.</p>
        <p>Your projects and local STARK data remain on this device.</p>
      </section>
    )
  }

  if (status.state === 'signed_out') {
    return (
      <section aria-label="STARK Account">
        <h2>STARK Account</h2>
        <p>Optional. Your projects and local STARK data remain on this device.</p>
        {state.actionError !== null ? <p role="alert">{state.actionError}</p> : null}
        <button className="stark-btn stark-btn--primary" type="button" disabled={state.acting} onClick={() => void handleStart('google')}>
          Continue with Google
        </button>
        <button className="stark-btn stark-btn--secondary" type="button" disabled={state.acting} onClick={() => void handleStart('github')}>
          Continue with GitHub
        </button>
      </section>
    )
  }

  if (status.state === 'signing_in') {
    return (
      <section aria-label="STARK Account">
        <h2>STARK Account</h2>
        <p role="status">Finish signing in in your browser.</p>
        <p>Provider: {accountProviderLabel(status.provider)}</p>
        {state.actionError !== null ? <p role="alert">{state.actionError}</p> : null}
        <button className="stark-btn stark-btn--ghost" type="button" disabled={state.acting} onClick={() => void handleCancel()}>
          Cancel
        </button>
      </section>
    )
  }

  if (status.state === 'session_attention') {
    return (
      <section aria-label="STARK Account">
        <h2>STARK Account</h2>
        <p role="alert">
          {status.reason === 'expired' ? 'Account session expired.' : 'Account verification unavailable.'}
        </p>
        <p>
          Signed in with {accountProviderLabel(status.account.provider)}
          {status.account.email !== null ? ` · ${status.account.email}` : ''}
        </p>
        <p>Your Workspace files and coding history remain local. Stage 29 does not sync project data to the cloud.</p>
        {state.actionError !== null ? <p role="alert">{state.actionError}</p> : null}
        <button className="stark-btn stark-btn--secondary" type="button" disabled={state.acting} onClick={() => void handleSignOut()}>
          Sign out
        </button>
      </section>
    )
  }

  return (
    <section aria-label="STARK Account">
      <h2>STARK Account</h2>
      <p>
        Signed in with {accountProviderLabel(status.account.provider)}
      </p>
      {status.account.displayName !== null ? <p>{status.account.displayName}</p> : null}
      {status.account.email !== null ? <p>{status.account.email}</p> : null}
      <p>Your Workspace files and coding history remain local. Stage 29 does not sync project data to the cloud.</p>
      {state.notice !== null ? <p role="status">{state.notice}</p> : null}
      {state.actionError !== null ? <p role="alert">{state.actionError}</p> : null}
      <button className="stark-btn stark-btn--secondary" type="button" disabled={state.acting} onClick={() => void handleSignOut()}>
        Sign out
      </button>
    </section>
  )
}
