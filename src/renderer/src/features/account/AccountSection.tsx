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
        <p>Account sign-in is not configured.</p>
        <p>Your projects and local STARK data remain on this device.</p>
      </section>
    )
  }

  if (status.state === 'signed_out') {
    return (
      <section aria-label="STARK Account">
        <h2>STARK Account</h2>
        <p>Sign in to sync your STARK account and manage subscriptions.</p>
        <p>Optional. Your projects and local STARK data remain on this device.</p>
        {state.actionError !== null ? <p role="alert">{state.actionError}</p> : null}
        <button className="stark-btn stark-btn--primary" type="button" disabled={state.acting} onClick={() => void handleStart('google')}>
          <GoogleMark />
          Continue with Google
        </button>
        <button className="stark-btn stark-btn--secondary" type="button" disabled={state.acting} onClick={() => void handleStart('github')}>
          <GitHubMark />
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
      <p>Current plan: STARK Free</p>
      <p>Your Workspace files and coding history remain local. Stage 29 does not sync project data to the cloud.</p>
      {state.notice !== null ? <p role="status">{state.notice}</p> : null}
      {state.actionError !== null ? <p role="alert">{state.actionError}</p> : null}
      <button className="stark-btn stark-btn--secondary" type="button" disabled={state.acting} onClick={() => void handleSignOut()}>
        Sign out
      </button>
    </section>
  )
}

/** Restrained inline Google mark (local SVG, no remote loading). */
function GoogleMark(): ReactElement {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  )
}

/** Restrained inline GitHub mark (local SVG, no remote loading). */
function GitHubMark(): ReactElement {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}
