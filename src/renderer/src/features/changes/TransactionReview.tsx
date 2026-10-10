import type { ReactElement } from 'react'
import type { ChangeTransaction, ChangeTransactionBinaryImport } from '../../../../shared/change-transactions/types'
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

/** Display-only byte size for asset cards (matches the session attachment cards). */
function formatAssetSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) {
    return '0 B'
  }
  if (size < 1024) {
    return `${String(size)} B`
  }
  if (size < 1024 * 1024) {
    return `${String(Math.round(size / 1024))} KB`
  }
  return `${String(Math.round((size / (1024 * 1024)) * 10) / 10)} MB`
}

/** Content URL for one stored attachment (opaque ID only, main-resolved). */
function attachmentContentUrl(id: string): string {
  return `stark-attachment://${id}`
}

/**
 * Review card for one binary chat-attachment import (Step 3): asset
 * ADD with thumbnail (images only, via the opaque attachment ID),
 * destination, type/size, and the reviewed SHA-256. Never a code
 * diff — the stored bytes are a review manifest, not file content.
 * Content travels as inert text only; Accept copies the exact
 * reviewed bytes and never overwrites an existing file.
 */
function BinaryImportCard({ asset }: { readonly asset: ChangeTransactionBinaryImport }): ReactElement {
  const shortHash = asset.sha256.length > 12 ? `${asset.sha256.slice(0, 12)}…` : asset.sha256
  return (
    <div className="review__asset" aria-label={`Binary addition ${asset.destination}`}>
      {asset.kind === 'image' && (
        <img
          className="review__asset-thumb"
          src={attachmentContentUrl(asset.attachmentId)}
          alt={asset.fileName}
        />
      )}
      <p className="changes__meta review__meta">
        {asset.kind === 'image' ? 'ADD IMAGE' : 'ADD FILE'} {asset.destination}
      </p>
      <p className="changes__meta review__meta">
        Source: chat attachment {asset.fileName}
      </p>
      <p className="changes__meta review__meta">
        {asset.mimeType} · {formatAssetSize(asset.sizeBytes)}
      </p>
      <p className="changes__meta review__meta" title={asset.sha256}>
        SHA-256 {shortHash}
      </p>
      <p className="changes__meta review__meta">
        This proposal adds a new file. Accept copies the exact reviewed bytes; an existing file is never
        overwritten.
      </p>
    </div>
  )
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
      {file !== null && file.binaryImport !== undefined && <BinaryImportCard asset={file.binaryImport} />}
      {file !== null && file.binaryImport === undefined && (
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
