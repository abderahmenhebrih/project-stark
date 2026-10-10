import type { ReactElement } from 'react'
import type { ChangeTransaction } from '../../../../shared/change-transactions/types'
import { statusLabel } from './changes-state'
import './changes.css'

interface ChangesPanelProps {
  readonly history: readonly ChangeTransaction[]
  readonly loading: boolean
  readonly error: string | null
  readonly selectedId: number | null
  readonly onSelect: (transactionId: number) => void
}

function entryTitle(transaction: ChangeTransaction): string {
  const file = transaction.files[0]
  if (file === undefined) {
    return `Change #${transaction.id}`
  }
  // Binary attachment imports add a new file — label the operation.
  return file.binaryImport === undefined ? file.relativePath : `ADD ${file.relativePath}`
}

/**
 * Minimal per-workspace change history: up to 20 recent transactions,
 * newest first. Selecting an entry opens its review; entries render as
 * plain text. No audit product, no auto-application.
 */
export function ChangesPanel({ history, loading, error, selectedId, onSelect }: ChangesPanelProps): ReactElement {
  return (
    <section className="changes" aria-label="Changes">
      {loading && (
        <p className="changes__status" role="status">
          Loading changes…
        </p>
      )}
      {error !== null && (
        <p className="changes__error" role="alert">
          {error}
        </p>
      )}
      {!loading && error === null && history.length === 0 && (
        <p className="changes__status">No changes yet</p>
      )}
      {history.length > 0 && (
        <ul className="changes__list">
          {history.map((transaction) => (
            <li key={transaction.id} className="changes__item">
              <button
                className={
                  transaction.id === selectedId ? 'changes__row changes__row--active' : 'changes__row'
                }
                type="button"
                aria-current={transaction.id === selectedId}
                onClick={() => onSelect(transaction.id)}
              >
                <span className="changes__name">{entryTitle(transaction)}</span>
                <span className="changes__badge">{statusLabel(transaction.status)}</span>
                <span className="changes__time">{new Date(transaction.createdAt).toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
