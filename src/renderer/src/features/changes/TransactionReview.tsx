import type { ReactElement } from 'react'
import type { ChangeTransaction } from '../../../../shared/change-transactions/types'
import { EditorToolbar } from '../editor/EditorToolbar'
import { TransactionDiffEditor } from '../editor/TransactionDiffEditor'
import { buildDiffUri } from '../editor/editor-document'
import { classifyEol } from '../editor/editor-eol'
import { detectEditorLanguage } from '../editor/editor-language'
import { statusLabel, type ChangesBusy } from './changes-state'
import './changes.css'

interface TransactionReviewProps {
  readonly transaction: ChangeTransaction
  readonly busy: ChangesBusy
  readonly actionError: string | null
  readonly notice: string | null
  readonly onAccept: () => void
  readonly onReject: () => void
  readonly onRollback: () => void
  readonly onClose: () => void
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString()
}

/**
 * Review for one persisted change transaction backed by a read-only
 * Monaco DiffEditor: original is the exact checkpoint, modified is
 * the proposal. Content travels as strings only — never HTML. Disk
 * changes only through explicit Accept (Stage 8 writer) or Rollback;
 * Reject never writes. The diff remounts per transaction so models
 * never leak across history browsing. The toolbar stays pinned at
 * the top of the main editor area; the diff fills the remaining
 * space.
 */
export function TransactionReview({
  transaction,
  busy,
  actionError,
  notice,
  onAccept,
  onReject,
  onRollback,
  onClose
}: TransactionReviewProps): ReactElement {
  const file = transaction.files[0] ?? null
  const working = busy !== 'idle'
  const pending = transaction.status === 'pending'
  const applied = transaction.status === 'applied'
  const pathLabel = file?.relativePath ?? `Change #${transaction.id}`

  function handleRollback(): void {
    if (window.confirm('Roll back this change and restore the original file?')) {
      onRollback()
    }
  }

  return (
    <div className="review">
      <EditorToolbar
        path={pathLabel}
        status={statusLabel(transaction.status)}
        actions={
          <>
            {pending && (
              <>
                <button className="changes__primary" type="button" disabled={working} onClick={onReject}>
                  {busy === 'rejecting' ? 'Rejecting…' : 'Reject'}
                </button>
                <button className="changes__primary" type="button" disabled={working} onClick={onAccept}>
                  {busy === 'accepting' ? 'Accepting…' : 'Accept'}
                </button>
              </>
            )}
            {applied && (
              <button className="changes__secondary" type="button" disabled={working} onClick={handleRollback}>
                {busy === 'rolling-back' ? 'Rolling back…' : 'Rollback'}
              </button>
            )}
            <button className="changes__secondary" type="button" onClick={onClose}>
              Close
            </button>
          </>
        }
      />
      <p className="changes__meta review__meta">Proposed {formatTime(transaction.createdAt)}</p>
      {notice !== null && (
        <p className="changes__notice review__meta" role="status">
          {notice}
        </p>
      )}
      {actionError !== null && (
        <p className="changes__error review__meta" role="alert">
          {actionError}
        </p>
      )}
      {file !== null && (
        <div className="review__diff">
          <TransactionDiffEditor
            key={`diff:${transaction.id}:${transaction.status}:${file.proposedRevision}`}
            beforeUri={buildDiffUri(transaction.id, file.relativePath, 'before')}
            afterUri={buildDiffUri(transaction.id, file.relativePath, 'after')}
            beforeContent={file.beforeContent}
            afterContent={file.proposedContent}
            language={detectEditorLanguage(file.relativePath)}
            eol={classifyEol(file.beforeContent) === 'crlf' ? 'CRLF' : 'LF'}
            ariaLabel={`Change comparison for ${file.relativePath}`}
          />
        </div>
      )}
    </div>
  )
}
