import { useState, type ReactElement } from 'react'
import { useApp } from '../../../app/app-context'
import { styleAssetUrls } from '../../styles/style-assets'
import { STARK_STYLES, type StarkStyleDefinition } from '../../styles/style-registry'
import './StylesSettings.css'

function requirementFor(style: StarkStyleDefinition): string {
  switch (style.id) {
    case 'free':
      return 'Included with STARK Free'
    case 'magma':
      return 'Requires an active Magma subscription'
    case 'frost':
      return 'Requires an active Frost subscription'
    case 'void':
      return 'Unlocks permanently on your first Void reload'
  }
}

/**
 * Settings → Styles: global STARK brand presentation.
 *
 * Four style cards (Free always unlocked; paid styles unlock with
 * their subscription; Void unlocks all styles permanently on first
 * reload). Applying an unlocked style updates the whole app
 * immediately — no reload, no state loss. Locked styles show their
 * requirement and offer no apply control.
 */
export function StylesSettings(): ReactElement {
  const { brandStyle } = useApp()
  const [applying, setApplying] = useState(false)

  // Single source of truth from the app shell (production entitlements
  // plus the explicit dev-only unlock flag — never a UI plan control).
  function isUnlocked(style: StarkStyleDefinition): boolean {
    return brandStyle.unlocked.includes(style.id)
  }

  async function handleApply(style: StarkStyleDefinition): Promise<void> {
    if (applying || brandStyle.style === style.id || !isUnlocked(style)) {
      return
    }
    setApplying(true)
    try {
      await brandStyle.setStyle(style.id)
    } finally {
      setApplying(false)
    }
  }

  return (
    <section aria-label="Styles">
      <p className="settings-section__title">Styles</p>
      <p className="settings-section__copy">
        STARK&apos;s brand presentation across the whole app. Magenta stays the secondary accent in every style.
      </p>
      <div className="styles-grid" aria-label="Brand styles">
        {STARK_STYLES.map((style) => {
          const unlocked = isUnlocked(style)
          const active = brandStyle.style === style.id
          return (
            <article
              key={style.id}
              className={active ? 'styles-card styles-card--active' : 'styles-card'}
              aria-label={`Style ${style.label}${active ? ', current' : ''}${unlocked ? '' : ', locked'}`}
            >
              <img className="styles-card__logo" src={styleAssetUrls(style.id).fullLogoUrl} alt="" aria-hidden="true" draggable={false} />
              <p className="styles-card__name">{style.label}</p>
              <p className="styles-card__colors">{style.colorDescription}</p>
              <p className="styles-card__state" role="status">
                {active ? 'Current style' : unlocked ? 'Unlocked' : 'Locked'}
              </p>
              {unlocked ? null : <p className="styles-card__requirement">{requirementFor(style)}</p>}
              {active ? null : (
                <button
                  className="explorer__secondary"
                  type="button"
                  disabled={!unlocked || applying}
                  onClick={() => void handleApply(style)}
                  aria-label={unlocked ? `Apply ${style.label} style` : `${style.label} style locked`}
                >
                  {applying ? 'Applying…' : 'Apply style'}
                </button>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
