import { useState, type ReactElement } from 'react'

interface ContextCardProps {
  /** Display label (path + lines, or note label). Never a host path. */
  readonly label: string
  /** Secondary detail line, e.g. kind. Null hides the detail. */
  readonly detail: string | null
  /** Exact item content, rendered as inert plain text. */
  readonly content: string
  /** Removable drafts show a Remove button; history items do not. */
  readonly removable: boolean
  readonly onRemove?: () => void
  readonly removeLabel?: string
}

/**
 * One visible context attachment: label, kind detail, preview toggle,
 * and optional remove. Content renders as plain pre-wrapped text —
 * never HTML. Preview defaults collapsed so long files stay compact;
 * the toggle is a real button (keyboard/touch accessible, never
 * hover-only).
 */
export function ContextCard({ label, detail, content, removable, onRemove, removeLabel = 'Remove' }: ContextCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="context-card">
      <div className="context-card__row">
        <span className="context-card__label" title={label}>
          {label}
        </span>
        <button
          className="explorer__secondary"
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} context preview for ${label}`}
        >
          {expanded ? 'Hide' : 'Preview'}
        </button>
        {removable && onRemove !== undefined && (
          <button
            className="explorer__secondary"
            type="button"
            onClick={onRemove}
            aria-label={`${removeLabel} ${label}`}
          >
            {removeLabel}
          </button>
        )}
      </div>
      {detail !== null && <p className="context-card__detail">{detail}</p>}
      {expanded && <pre className="context-card__preview">{content}</pre>}
    </div>
  )
}
