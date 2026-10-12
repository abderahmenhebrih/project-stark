import { useEffect, useRef, useState, type ReactElement } from 'react'
import { UiIcon } from '../../../../components/icons/UiIcon'
import type { StarkModelIdentity } from './model-library'
import { canEnterChain, findLibraryModel } from './model-library'
import { MAX_CHAIN_MODELS, deriveModelRoster, enableModel } from './model-chain'
import { MODEL_FALLBACK_ICON, modelIconFor } from './model-icons'

interface ModelChainProps {
  readonly kind: 'brain' | 'heart'
  readonly title: string
  readonly copy: string
  /** Ordered ENABLED model ids — the single source of truth. */
  readonly chain: readonly string[]
  readonly library: readonly StarkModelIdentity[]
  /** Entitlement cap for this LoopLink (Free default 5). */
  readonly maxModels?: number
  /** Plan display name for limit copy (e.g. "STARK Free"). */
  readonly planLabel?: string
  readonly onToggle: (stableId: string, enable: boolean) => void
  readonly onSwap: (outgoingId: string, incomingId: string) => void
  readonly onReorder: (stableId: string, toIndex: number) => void
  readonly onNavigateBilling: () => void
}

interface LimitDialogState {
  readonly requestedId: string
  readonly stage: 'choose' | 'switch'
  readonly selectedId: string | null
}

function chainLabel(kind: 'brain' | 'heart'): string {
  return kind === 'brain' ? 'Brain LoopLink' : 'Heart LoopLink'
}

function displayNameFor(chainId: string, library: readonly StarkModelIdentity[]): string {
  const found = findLibraryModel(library, chainId)
  if (found !== undefined) {
    return found.displayName
  }
  const sep = chainId.indexOf(':')
  return sep === -1 ? chainId : chainId.slice(sep + 1)
}

/**
 * Shared LoopLink roster: the FULL eligible plan catalog as one
 * vertical table — enabled rows first in active order, then disabled
 * rows in catalog order. Toggles enable/disable, the drag handle
 * reorders enabled rows, and enabling past the entitlement cap opens
 * the limit dialog (switch-with or upgrade) instead of mutating.
 * Brain and Heart share this component; only the accent class differs.
 */
export function ModelChain(props: ModelChainProps): ReactElement {
  const { kind, chain, library, maxModels = MAX_CHAIN_MODELS, planLabel = 'STARK Free' } = props
  const label = chainLabel(kind)
  const roster = deriveModelRoster(library, chain)
  const enabledRows = roster.rows.filter((row) => row.enabled)
  const disabledRows = roster.rows.filter((row) => !row.enabled)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [dialog, setDialog] = useState<LimitDialogState | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (dialog !== null) {
      dialogRef.current?.focus()
    }
  }, [dialog])

  function handleToggle(stableId: string, enable: boolean): void {
    if (!enable) {
      props.onToggle(stableId, false)
      return
    }
    const outcome = enableModel(chain, stableId, maxModels)
    if (outcome.limitReached) {
      setDialog({ requestedId: stableId, stage: 'choose', selectedId: null })
      return
    }
    if (outcome.applied) {
      props.onToggle(stableId, true)
    }
  }

  function handleDrop(targetIndex: number): void {
    if (dragId === null) {
      return
    }
    const from = chain.indexOf(dragId)
    if (from === -1) {
      setDragId(null)
      setDropIndex(null)
      return
    }
    const adjusted = from < targetIndex ? targetIndex - 1 : targetIndex
    props.onReorder(dragId, adjusted)
    setDragId(null)
    setDropIndex(null)
  }

  function handleGripKeyDown(stableId: string, position: number, event: React.KeyboardEvent): void {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
      return
    }
    event.preventDefault()
    props.onReorder(stableId, event.key === 'ArrowUp' ? position - 2 : position)
  }

  function closeDialog(): void {
    setDialog(null)
  }

  function confirmSwitch(): void {
    if (dialog === null || dialog.selectedId === null) {
      return
    }
    props.onSwap(dialog.selectedId, dialog.requestedId)
    setDialog(null)
  }

  const requestedName = dialog === null ? '' : displayNameFor(dialog.requestedId, library)

  return (
    <section className={`models-chain models-chain--${kind}`} aria-label={label}>
      <div className="models-chain__head">
        <p className="settings-section__title">{props.title}</p>
        <span className="models-chain__count" role="status">
          {roster.enabledCount} active / {roster.totalCount} models · {planLabel} limit: {maxModels}
        </span>
      </div>
      <p className="settings-section__copy">{props.copy}</p>
      <table className="models-chain__table" aria-label={`${label} models in order`}>
        <thead className="models-chain__thead">
          <tr>
            <th scope="col" className="models-chain__th models-chain__th--drag">
              <span className="models-chain__sr">Reorder</span>
            </th>
            <th scope="col" className="models-chain__th models-chain__th--model">
              Model
            </th>
            <th scope="col" className="models-chain__th models-chain__th--access">
              Access
            </th>
            <th scope="col" className="models-chain__th models-chain__th--enabled">
              Enabled
            </th>
          </tr>
        </thead>
        <tbody
          onDragLeave={() => {
            setDropIndex(null)
          }}
        >
          {enabledRows.length > 0 ? (
            <tr className="models-chain__sectionrow" aria-hidden="true">
              <td colSpan={4} className="models-chain__section">
                Active · {enabledRows.length}
              </td>
            </tr>
          ) : null}
          {enabledRows.map((row) => {
            const name = displayNameFor(row.stableId, library)
            const position = row.position ?? 0
            const available = row.entry !== undefined
            return (
              <tr
                key={row.stableId}
                className={
                  'models-chain__row models-chain__row--on' +
                  (dragId === row.stableId ? ' models-chain__row--dragging' : '') +
                  (dropIndex === position ? ' models-chain__row--dropafter' : '')
                }
                aria-label={`Position ${String(position)}: ${name}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/plain', row.stableId)
                  event.dataTransfer.effectAllowed = 'move'
                  setDragId(row.stableId)
                }}
                onDragEnd={() => {
                  setDragId(null)
                  setDropIndex(null)
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  const rect = event.currentTarget.getBoundingClientRect()
                  const after = event.clientY >= rect.top + rect.height / 2
                  setDropIndex(after ? position : position - 1)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const rect = event.currentTarget.getBoundingClientRect()
                  const after = event.clientY >= rect.top + rect.height / 2
                  handleDrop(after ? position : position - 1)
                }}
              >
                <td className="models-chain__td models-chain__drag">
                  <button
                    className="models-chain__grip"
                    type="button"
                    draggable={false}
                    onClick={(event) => event.preventDefault()}
                    onKeyDown={(event) => handleGripKeyDown(row.stableId, position, event)}
                    aria-label={`Reorder ${name}`}
                    title={`Reorder ${name} (Alt + Up/Down)`}
                  >
                    <UiIcon name="menu" size={14} />
                  </button>
                  <span className="models-chain__position" aria-hidden="true">
                    {position}
                  </span>
                </td>
                <td className="models-chain__td models-chain__model">
                  <span className="models-chain__icon" aria-hidden="true">
                    <img
                      className="models-chain__img"
                      src={modelIconFor(row.stableId)}
                      alt=""
                      draggable={false}
                      onError={(event) => {
                        event.currentTarget.src = MODEL_FALLBACK_ICON
                      }}
                    />
                  </span>
                  <span className="models-chain__name">{name}</span>
                  {available ? null : (
                    <span className="models-chain__status" role="status">
                      Unavailable
                    </span>
                  )}
                </td>
                <td className="models-chain__td models-chain__access">{row.entry?.badge ?? '–'}</td>
                <td className="models-chain__td models-chain__enabled">
                  <button
                    className="models-chain__switch models-chain__switch--on"
                    type="button"
                    role="switch"
                    aria-checked={true}
                    aria-label={`Disable ${name} in ${label}`}
                    onClick={() => handleToggle(row.stableId, false)}
                  >
                    <span className="models-chain__knob" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            )
          })}
          {disabledRows.length > 0 ? (
            <tr className="models-chain__sectionrow" aria-hidden="true">
              <td colSpan={4} className="models-chain__section">
                Available · {disabledRows.length}
              </td>
            </tr>
          ) : null}
          {disabledRows.map((row) => {
            const name = displayNameFor(row.stableId, library)
            const usable = row.entry !== undefined && canEnterChain(row.entry)
            const reason = row.entry === undefined ? 'is unavailable' : 'is locked. Upgrade your plan'
            return (
              <tr key={row.stableId} className="models-chain__row models-chain__row--off">
                <td className="models-chain__td models-chain__drag" aria-hidden="true" />
                <td className="models-chain__td models-chain__model">
                  <span className="models-chain__icon" aria-hidden="true">
                    <img
                      className="models-chain__img"
                      src={modelIconFor(row.stableId)}
                      alt=""
                      draggable={false}
                      onError={(event) => {
                        event.currentTarget.src = MODEL_FALLBACK_ICON
                      }}
                    />
                  </span>
                  <span className="models-chain__name">{name}</span>
                </td>
                <td className="models-chain__td models-chain__access">{row.entry?.badge ?? '–'}</td>
                <td className="models-chain__td models-chain__enabled">
                  <button
                    className="models-chain__switch"
                    type="button"
                    role="switch"
                    aria-checked={false}
                    aria-label={usable ? `Enable ${name} in ${label}` : `${name} ${reason} in ${label}`}
                    title={usable ? `Enable ${name} in ${label}` : `${name} ${reason}`}
                    disabled={!usable}
                    onClick={() => handleToggle(row.stableId, true)}
                  >
                    <span className="models-chain__knob" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {dialog === null ? null : (
        <div className="models-chain__backdrop" onClick={closeDialog}>
          <div
            ref={dialogRef}
            className="models-chain__dialog"
            role="dialog"
            aria-modal="true"
            aria-label="LoopLink limit reached"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                closeDialog()
              }
            }}
          >
            <p className="models-chain__dialog-title">LoopLink limit reached</p>
            <p className="models-chain__dialog-copy">
              {planLabel} allows up to {maxModels} active models in each LoopLink. To enable {requestedName}, switch
              it with one of your active models or upgrade your plan.
            </p>
            {dialog.stage === 'choose' ? (
              <div className="models-chain__dialog-actions">
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => setDialog({ requestedId: dialog.requestedId, stage: 'switch', selectedId: null })}
                >
                  Switch model
                </button>
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => {
                    closeDialog()
                    props.onNavigateBilling()
                  }}
                >
                  Upgrade plan
                </button>
                <button className="explorer__secondary" type="button" onClick={closeDialog}>
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <p className="models-chain__dialog-copy">Switch {requestedName} with:</p>
                <div className="models-chain__dialog-options" role="radiogroup" aria-label={`Replace an active ${label} model`}>
                  {enabledRows.map((row) => {
                    const name = displayNameFor(row.stableId, library)
                    const selected = dialog.selectedId === row.stableId
                    return (
                      <button
                        key={row.stableId}
                        className={'models-chain__option' + (selected ? ' models-chain__option--selected' : '')}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setDialog({ requestedId: dialog.requestedId, stage: 'switch', selectedId: row.stableId })}
                      >
                        {name}
                      </button>
                    )
                  })}
                </div>
                <div className="models-chain__dialog-actions">
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => setDialog({ requestedId: dialog.requestedId, stage: 'choose', selectedId: null })}
                  >
                    Back
                  </button>
                  <button className="explorer__secondary" type="button" onClick={closeDialog}>
                    Cancel
                  </button>
                  <button
                    className="explorer__primary"
                    type="button"
                    disabled={dialog.selectedId === null}
                    onClick={confirmSwitch}
                  >
                    Switch
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
