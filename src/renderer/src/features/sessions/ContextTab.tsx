import { useState, type Dispatch, type ReactElement } from 'react'
import type { SessionContextDraft } from '../../../../shared/context/types'
import { prepareContextNote } from '../../lib/session-context-api'
import { normalizeContextError } from '../../lib/session-context-error'
import { isComposerEmpty } from './composer-keys'
import { ContextCard } from './ContextCard'
import type { SessionContextDraftAction } from './session-context-state'

interface ContextTabProps {
  readonly workspaceId: number
  readonly drafts: readonly SessionContextDraft[]
  readonly dispatch: Dispatch<SessionContextDraftAction>
  readonly draftError: string | null
}

/**
 * Full attached-context surface for the secondary workspace pane.
 * The draft list reducer stays single-owned in HomePage; this tab is
 * presentation + note drafting only. Composer chips (in SessionPanel)
 * summarize the same drafts; Preview / Remove / Add note live here.
 */
export function ContextTab({ workspaceId, drafts, dispatch, draftError }: ContextTabProps): ReactElement {
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)

  function handleRemove(draftId: string): void {
    dispatch({ type: 'draft-removed', workspaceId, draftId })
  }

  async function handleAddNote(): Promise<void> {
    if (isComposerEmpty(noteText) || noteBusy) {
      return
    }
    setNoteBusy(true)
    try {
      const draft = await prepareContextNote({ workspaceId, content: noteText })
      dispatch({ type: 'draft-added', workspaceId, draft })
      setNoteText('')
      setNoteOpen(false)
    } catch (error: unknown) {
      dispatch({ type: 'draft-failed', workspaceId, message: normalizeContextError(error).message })
    } finally {
      setNoteBusy(false)
    }
  }

  const manualNotes = drafts.filter((draft) => draft.kind === 'manual-note').length

  return (
    <div className="context-tab" aria-label="Attached context">
      <div className="context-tab__header">
        <p className="context-tab__title">
          Context{drafts.length > 0 ? ` (${String(drafts.length)})` : ''}
        </p>
        <button
          className="explorer__secondary"
          type="button"
          onClick={() => setNoteOpen((open) => !open)}
          aria-expanded={noteOpen}
          aria-label="Add manual context note"
        >
          Add note
        </button>
      </div>
      {draftError !== null && (
        <p className="session__error" role="alert">
          {draftError}
        </p>
      )}
      {drafts.length === 0 ? (
        <p className="context-tab__empty">No context attached. Only what you attach here is sent to the AI.</p>
      ) : (
        <ul className="context-tab__list">
          {drafts.map((draft) => (
            <li key={draft.draftId}>
              <ContextCard
                label={draft.label}
                detail={draft.kind}
                content={draft.content}
                removable
                onRemove={() => handleRemove(draft.draftId)}
              />
            </li>
          ))}
        </ul>
      )}
      {manualNotes > 0 && (
        <p className="session__hint" role="note">
          {manualNotes} manual note{manualNotes === 1 ? '' : 's'} attached.
        </p>
      )}
      {noteOpen && (
        <div className="session__note-form">
          <label className="session__eyebrow" htmlFor="context-tab-note-input">
            Manual note
          </label>
          <textarea
            id="context-tab-note-input"
            className="session__input session__input--note"
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            placeholder="Type a short note or snippet…"
            aria-label="Manual context note"
            rows={3}
          />
          <div className="session__composer-row">
            <button
              className="explorer__primary"
              type="button"
              onClick={() => void handleAddNote()}
              disabled={isComposerEmpty(noteText) || noteBusy}
            >
              {noteBusy ? 'Attaching…' : 'Attach note'}
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => {
                setNoteOpen(false)
                setNoteText('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
