import type { ReactElement } from 'react'
import type { StarkModelIdentity } from './model-library'
import { MODEL_FALLBACK_ICON, modelIconFor } from './model-icons'
import { tokenSessionLabel } from './model-library'

interface ModelCardProps {
  readonly model: StarkModelIdentity
  /** Locked plan entries route to Billing through this action. */
  readonly onUpgrade?: () => void
}

/**
 * One model in the library grid. Rectangular, substantial,
 * near-black: distinct bundled local icon per model (no remote
 * images, no downloads; decorative — the name text carries meaning),
 * small origin badge when meaningful, strong model name, dim honest
 * token metadata, availability state.
 *
 * Selectable entries are display-only (article) — actions live on the
 * Add flow and chains, and built-in entries never carry a destructive
 * remove control. Entries without a proven inference route render as
 * catalog preview ("Preview — unavailable in this build") and offer
 * no run action. Locked plan entries render as one button: the card
 * explains the lock and routes to the Upgrade surface (local Billing
 * navigation, no checkout, no pricing).
 */
export function ModelCard({ model, onUpgrade }: ModelCardProps): ReactElement {
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
        <span className="models-card__tokens">{tokenSessionLabel()}</span>
        <span className="models-card__lock">Upgrade your plan</span>
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
      <p className="models-card__tokens">{tokenSessionLabel()}</p>
      {model.available ? null : (
        <p className="models-card__status" role="status">
          {model.origin === 'built-in' ? 'Preview — unavailable in this build' : 'Unavailable'}
        </p>
      )}
    </article>
  )
}
