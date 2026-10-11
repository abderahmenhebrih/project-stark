import { useState, type ReactElement } from 'react'
import { StarkIcon } from '../../../../components/icons/StarkIcon'
import type { StarkModelIdentity } from './model-library'
import { canEnterChain, findLibraryModel } from './model-library'
import { MAX_CHAIN_MODELS, isChainFull } from './model-chain'

interface ModelChainProps {
  readonly kind: 'brain' | 'heart'
  readonly title: string
  readonly copy: string
  readonly chain: readonly string[]
  readonly library: readonly StarkModelIdentity[]
  /** Entitlement cap for this chain (Free default 5). */
  readonly maxModels?: number
  readonly onAdd: (stableId: string) => void
  readonly onRemove: (stableId: string) => void
  readonly onMove: (stableId: string, direction: 'left' | 'right') => void
}

function chainLabel(kind: 'brain' | 'heart'): string {
  return kind === 'brain' ? 'Brain Chain' : 'Heart Chain'
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
 * Shared ordered LoopLink chain renderer. Brain and Heart share this
 * component; only labels and accent classes differ. Nodes read as an
 * ordered chain (numbered, arrow connectors, LoopLink loop-back), the
 * Add slot offers only usable library models — locked plan entries
 * and unavailable entries render disabled with their reason and can
 * never be inserted — and every control is a real button with an
 * accessible label.
 */
export function ModelChain(props: ModelChainProps): ReactElement {
  const { kind, chain, library, maxModels = MAX_CHAIN_MODELS } = props
  const label = chainLabel(kind)
  const libraryIds = new Set(library.map((entry) => entry.stableId))
  const [pickerOpen, setPickerOpen] = useState(false)
  const full = isChainFull(chain, maxModels)

  return (
    <section className={`models-chain models-chain--${kind}`} aria-label={label}>
      <p className="settings-section__title">{props.title}</p>
      <p className="settings-section__copy">{props.copy}</p>
      {chain.length === 0 ? (
        <p className="session__hint" role="note">
          Add a model to configure the {label}.
        </p>
      ) : (
        <div className="models-chain__loopwrap">
          <ol className="models-chain__nodes" aria-label={`${label} models in order`}>
            {chain.map((stableId, index) => {
              const available = libraryIds.has(stableId)
              const name = displayNameFor(stableId, library)
              const position = index + 1
              return (
                <li key={stableId} className="models-chain__node" aria-label={`Position ${String(position)}: ${name}`}>
                  <span className="models-chain__position" aria-hidden="true">
                    {position}
                  </span>
                  <span className="models-chain__icon" aria-hidden="true">
                    <StarkIcon name="extensions" size={16} />
                  </span>
                  <span className="models-chain__name">{name}</span>
                  {available ? null : (
                    <span className="models-chain__status" role="status">
                      Unavailable
                    </span>
                  )}
                  <span className="models-chain__actions">
                    <button
                      className="models-chain__mini"
                      type="button"
                      onClick={() => props.onMove(stableId, 'left')}
                      disabled={index === 0}
                      aria-label={`Move ${name} earlier in ${label}`}
                    >
                      ←
                    </button>
                    <button
                      className="models-chain__mini"
                      type="button"
                      onClick={() => props.onMove(stableId, 'right')}
                      disabled={index === chain.length - 1}
                      aria-label={`Move ${name} later in ${label}`}
                    >
                      →
                    </button>
                    <button
                      className="models-chain__mini"
                      type="button"
                      onClick={() => props.onRemove(stableId)}
                      aria-label={`Remove ${name} from ${label}`}
                    >
                      <StarkIcon name="close" size={12} />
                    </button>
                  </span>
                </li>
              )
            })}
          </ol>
          <p className="models-chain__loop" aria-hidden="true">
            <span className="models-chain__loop-line" />
            <span className="models-chain__loop-tag">LoopLink</span>
          </p>
        </div>
      )}
      {!full && (
        <div className="models-chain__add">
          {pickerOpen ? (
            <div className="models-chain__picker" role="group" aria-label={`Add a model to ${label}`}>
              {library.length === 0 ? (
                <p className="session__hint" role="note">
                  No models available. Use the Add model card above first.
                </p>
              ) : (
                <ul className="models-chain__options">
                  {library.map((entry) => {
                    const duplicate = chain.includes(entry.stableId)
                    const usable = canEnterChain(entry)
                    const disabled = duplicate || !usable
                    const reason = duplicate
                      ? 'is already in'
                      : entry.locked
                        ? 'is locked. Upgrade your plan'
                        : 'is unavailable'
                    return (
                      <li key={entry.stableId}>
                        <button
                          className="explorer__secondary"
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            props.onAdd(entry.stableId)
                            setPickerOpen(false)
                          }}
                          aria-label={
                            disabled ? `${entry.displayName} ${reason} ${label}` : `Add ${entry.displayName} to ${label}`
                          }
                        >
                          {entry.displayName}
                          {duplicate ? ' · in chain' : entry.locked ? ' · locked' : !usable ? ' · unavailable' : ''}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
              <button
                className="explorer__secondary"
                type="button"
                onClick={() => setPickerOpen(false)}
                aria-label={`Close ${label} model picker`}
              >
                Close
              </button>
            </div>
          ) : (
            <button
              className="models-chain__addslot"
              type="button"
              onClick={() => setPickerOpen(true)}
              aria-label={`Add a model to ${label}`}
            >
              <StarkIcon name="plus" size={14} />
              <span>Add</span>
            </button>
          )}
        </div>
      )}
      <p className="session__hint" role="note">
        {chain.length} of {maxModels} models
        {full ? ' · chain is full' : ''}
      </p>
    </section>
  )
}
