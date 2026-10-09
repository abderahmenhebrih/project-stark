import { useId, useState, type ChangeEvent, type FormEvent, type ReactElement } from 'react'
import { useApp } from '../../app/app-context'
import { STARK_FULL_LOGO_URL } from '../../components/brandAssets'
import './OnboardingPage.css'

/**
 * First-launch identity screen. Collects the local display name STARK
 * uses when addressing the user, persists it through the profile domain,
 * and hands off to the main shell in-process. Local preference only —
 * not an account, not authentication.
 */
export function OnboardingPage(): ReactElement {
  const { completeOnboarding } = useApp()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputId = useId()
  const errorId = `${inputId}-error`

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    setName(event.target.value)
    if (error !== null) {
      setError(null)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (submitting) {
      return
    }
    if (name.trim() === '') {
      setError('Please enter a name.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await completeOnboarding(name.trim())
    } catch {
      setError('We couldn’t save your name. Try again.')
      setSubmitting(false)
    }
  }

  return (
    <main className="onboarding">
      <div className="onboarding__card">
        <img className="onboarding__logo" src={STARK_FULL_LOGO_URL} alt="STARK" />
        <h1 className="onboarding__question">How should I call you?</h1>
        <form className="onboarding__form" onSubmit={handleSubmit} noValidate>
          <label className="onboarding__label" htmlFor={inputId}>
            Display name
          </label>
          <input
            id={inputId}
            className="onboarding__input"
            type="text"
            value={name}
            onChange={handleChange}
            placeholder="Abdou"
            autoComplete="nickname"
            maxLength={40}
            autoFocus
            disabled={submitting}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : errorId}
          />
          {error !== null && (
            <p id={errorId} className="onboarding__error" role="alert">
              {error}
            </p>
          )}
          <button className="onboarding__continue" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Continue'}
          </button>
        </form>
      </div>
    </main>
  )
}
