import type { ReactElement, ReactNode } from 'react'

interface EditorToolbarProps {
  /** File or change path shown left-aligned; never a host path. */
  readonly path: string
  /** Short state label (e.g. Read-only, Unsaved changes, Pending review). */
  readonly status: string | null
  readonly actions: ReactNode
  readonly statusLabel?: string
}

/**
 * Single editor toolbar for the workbench main pane. Every editor
 * state (read-only, editing, transaction review) renders through
 * this component so the file path is always visible and the primary
 * action (Edit / Review change / Accept) is never below the fold.
 */
export function EditorToolbar({ path, status, actions, statusLabel = 'Editor status' }: EditorToolbarProps): ReactElement {
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Editor toolbar">
      <div className="editor-toolbar__identity">
        <span className="editor-toolbar__path" title={path}>
          {path}
        </span>
        {status !== null && (
          <span className="editor-toolbar__status" role="status" aria-label={statusLabel}>
            {status}
          </span>
        )}
      </div>
      <div className="editor-toolbar__actions">{actions}</div>
    </div>
  )
}
