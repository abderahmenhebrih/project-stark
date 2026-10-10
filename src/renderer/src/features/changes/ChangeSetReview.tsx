import type { ReactElement } from 'react'
import type { ChangeSet } from '../../../../shared/change-sets/types'
import { statusLabel } from './changes-state'
import { changeSetDerivedStatus, changeSetStatusLabel } from './change-set-state'

interface ChangeSetReviewProps {
  readonly changeSet: ChangeSet
  readonly onReviewFile: (transactionId: number) => void
  readonly onClose: () => void
}

/**
 * Grouped proposal review: global summary, derived group status, and
 * one row per file with its own status and Review button. Reviewing
 * a file reuses the existing transaction review plus its diff viewer —
 * this surface never renders code itself and offers no batch decision
 * control.
 */
export function ChangeSetReview({ changeSet, onReviewFile, onClose }: ChangeSetReviewProps): ReactElement {
  const status = changeSetDerivedStatus(changeSet)
  return (
    <div className="workbench__editor-body" aria-label="Change set review">
      <p className="explorer__status">Change set · {changeSet.items.length} files</p>
      <p className="explorer__status">{changeSet.summary}</p>
      <p className="explorer__status" role="status">
        {changeSetStatusLabel(status)} · A change set groups reviewable proposals. It is not a single atomic
        filesystem commit — each file is accepted independently.
      </p>
      <ul className="changes__list">
        {[...changeSet.items]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((item) => {
            const file = item.transaction.files[0]
            const path =
              file === undefined
                ? `Change #${item.transaction.id}`
                : file.binaryImport === undefined
                  ? file.relativePath
                  : `ADD ${file.relativePath}`
            return (
              <li key={item.transaction.id} className="changes__item">
                <span className="explorer__row explorer__row--static">
                  <span className="explorer__name">{path}</span>
                  <span className="changes__badge">{statusLabel(item.transaction.status)}</span>
                </span>
                <p className="explorer__status">{item.fileSummary}</p>
                <button className="explorer__secondary" type="button" onClick={() => onReviewFile(item.transaction.id)}>
                  Review
                </button>
              </li>
            )
          })}
      </ul>
      <button className="explorer__secondary" type="button" onClick={onClose}>
        Close
      </button>
    </div>
  )
}
