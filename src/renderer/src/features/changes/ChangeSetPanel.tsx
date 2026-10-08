import type { ReactElement } from 'react'
import type { ChangeSet } from '../../../../shared/change-sets/types'
import { changeSetDerivedStatus, changeSetStatusLabel } from './change-set-state'
import './changes.css'

interface ChangeSetPanelProps {
  readonly sets: readonly ChangeSet[]
  readonly loading: boolean
  readonly error: string | null
  readonly selectedId: number | null
  readonly onSelect: (changeSetId: number) => void
}

/**
 * Persistent grouped history: up to 20 recent Change Sets, newest
 * first, above the ungrouped transaction list. Selecting an entry
 * opens its grouped review; entries render as plain text. Per-file
 * decisions only — no batch controls of any kind.
 */
export function ChangeSetPanel({ sets, loading, error, selectedId, onSelect }: ChangeSetPanelProps): ReactElement {
  return (
    <section className="changes" aria-label="Change sets">
      {loading && (
        <p className="changes__status" role="status">
          Loading change sets…
        </p>
      )}
      {error !== null && (
        <p className="changes__error" role="alert">
          {error}
        </p>
      )}
      {!loading && error === null && sets.length === 0 && (
        <p className="changes__status">No change sets yet</p>
      )}
      {sets.length > 0 && (
        <ul className="changes__list">
          {sets.map((set) => {
            const status = changeSetDerivedStatus(set)
            return (
              <li key={set.id} className="changes__item">
                <button
                  className={set.id === selectedId ? 'changes__row changes__row--active' : 'changes__row'}
                  type="button"
                  aria-current={set.id === selectedId}
                  onClick={() => onSelect(set.id)}
                >
                  <span className="changes__name">
                    Change set · {set.items.length} files
                  </span>
                  <span className="changes__badge">{changeSetStatusLabel(status)}</span>
                  <span className="changes__time">{new Date(set.createdAt).toLocaleString()}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
