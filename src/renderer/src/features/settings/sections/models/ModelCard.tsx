import type { ReactElement } from 'react'
import type { StarkModelIdentity } from './model-library'
import { MODEL_FALLBACK_ICON, modelIconFor } from './model-icons'

interface ModelCardProps {
  readonly model: StarkModelIdentity
  /** Locked plan entries route to Billing through this action. */
  readonly onUpgrade?: () => void
  /** Available entries offer selection through this action when provided. */
  readonly onSelect?: () => void
  /** True when this entry is the current composer selection. */
  readonly selected?: boolean
}

/**
 * One model in the library grid. Rectangular, substantial,
 * near-black: distinct bundled local icon per model (no remote
 * images, no downloads; decorative — the name text carries meaning),
 * small origin badge when meaningful, strong model name, and
 * availability state.
 *
 * Entries without a selection action are display-only (article) —
 * chain actions live on the rosters, and built-in entries never carry
 * a destructive remove control. Available entries with an onSelect
 * action render as a toggle button with pressed state. Locked plan
 * entries render as one button: the card explains the lock and routes
 * to the Upgrade surface (local Billing navigation, no checkout, no
 * pricing).
 */
export function ModelCard({ model, onUpgrade, onSelect, selected = false }: ModelCardProps): ReactElement {
  if (model.locked) {
    return (
      <button
        className="models-card models-card--locked"
        type="button"
        onClick={onUpgrade}
        aria-label={`${model.displayName}, locked. Upgrade your plan`}
      >
        <span className="models-card__icon" aria-hidden="true">
          <img
            className="models-card__img"
            src={modelIconFor(model.stableId)}
            alt=""
            draggable={false}
            onError={(event) => {
              event.currentTarget.src = MODEL_FALLBACK_ICON
            }}
          />
        </span>
        <span className="models-card__badgerow" aria-hidden="true">
          {model.badge !== null ? <span className="models-card__badge">{model.badge}</span> : null}
        </span>
        <span className="models-card__provider">{model.providerLabel}</span>
        <span className="models-card__name">{model.displayName}</span>
        <span className="models-card__lock">Upgrade your plan</span>
      </button>
    )
  }
  if (onSelect !== undefined && model.available) {
    return (
      <button
        className={'models-card' + (selected ? ' models-card--selected' : '')}
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`${model.displayName}, select model`}
      >
        <span className="models-card__icon" aria-hidden="true">
          <img
            className="models-card__img"
            src={modelIconFor(model.stableId)}
            alt=""
            draggable={false}
            onError={(event) => {
              event.currentTarget.src = MODEL_FALLBACK_ICON
            }}
          />
        </span>
        {model.badge !== null ? (
          <span className="models-card__badgerow" aria-hidden="true">
            <span className="models-card__badge">{model.badge}</span>
          </span>
        ) : null}
        <span className="models-card__provider">{model.providerLabel}</span>
        <span className="models-card__name">{model.displayName}</span>
        {selected ? (
          <span className="models-card__status" role="status">
            Selected
          </span>
        ) : null}
      </button>
    )
  }
  return (
    <article className="models-card" aria-label={`Model ${model.displayName}`}>
      <span className="models-card__icon" aria-hidden="true">
        <img
          className="models-card__img"
          src={modelIconFor(model.stableId)}
          alt=""
          draggable={false}
          onError={(event) => {
            event.currentTarget.src = MODEL_FALLBACK_ICON
          }}
        />
      </span>
      {model.badge !== null ? (
        <span className="models-card__badgerow" aria-hidden="true">
          <span className="models-card__badge">{model.badge}</span>
        </span>
      ) : null}
      <p className="models-card__provider">{model.providerLabel}</p>
      <p className="models-card__name">{model.displayName}</p>
      {model.available ? null : (
        <p className="models-card__status" role="status">
          Unavailable
        </p>
      )}
    </article>
  )
}
