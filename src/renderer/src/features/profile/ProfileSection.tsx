import { useReducer, type ReactElement } from 'react'
import type { LocalProfile } from '../../../../shared/profile/types'
import { updateLocalDisplayName } from '../../lib/profile-api'
import {
  initialProfileEditorState,
  isProfileDraftSubmittable,
  profileEditorReducer
} from './profile-state'

interface ProfileSectionProps {
  readonly current: LocalProfile | null
  readonly onChanged: (profile: LocalProfile) => void
}

/**
 * Small local Profile setting (Stage 30): "STARK calls you".
 *
 * Edits the LOCAL display preference bounded by the existing Stage 4
 * rules (main validates authoritatively). This is NOT cloud profile
 * editing and is never synchronized to Supabase. Double submits are
 * ignored while a save is in flight.
 */
export function ProfileSection({ current, onChanged }: ProfileSectionProps): ReactElement {
  const [state, dispatch] = useReducer(profileEditorReducer, current, initialProfileEditorState)

  async function handleSave(): Promise<void> {
    if (state.saving || !isProfileDraftSubmittable(state.draft)) {
      return
    }
    dispatch({ type: 'save-started' })
    try {
      const saved = await updateLocalDisplayName(state.draft.trim())
      onChanged(saved)
      dispatch({ type: 'save-succeeded', profile: saved })
    } catch (error: unknown) {
      dispatch({
        type: 'save-failed',
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t save your name.'
      })
    }
  }

  if (!state.editing) {
    return (
      <section className="profile-section" aria-label="Local profile">
        <p className="profile-section__line">
          STARK calls you <strong>{state.current?.displayName ?? '…'}</strong>
        </p>
        {state.notice !== null ? <p role="status">{state.notice}</p> : null}
        <button className="stark-btn stark-btn--secondary" type="button" onClick={() => dispatch({ type: 'edit-started' })}>
          Edit name
        </button>
      </section>
    )
  }

  return (
    <section className="profile-section" aria-label="Local profile">
      <label className="profile-section__label" htmlFor="stark-local-name">
        STARK calls you
      </label>
      <input
        id="stark-local-name"
        type="text"
        value={state.draft}
        maxLength={40}
        disabled={state.saving}
        onChange={(event) => dispatch({ type: 'draft-changed', draft: event.target.value })}
      />
      {state.saveError !== null ? <p role="alert">{state.saveError}</p> : null}
      <button className="stark-btn stark-btn--primary" type="button" disabled={state.saving} onClick={() => void handleSave()}>
        {state.saving ? 'Saving…' : 'Save name'}
      </button>
      <button className="stark-btn stark-btn--ghost" type="button" disabled={state.saving} onClick={() => dispatch({ type: 'edit-cancelled' })}>
        Cancel
      </button>
    </section>
  )
}
