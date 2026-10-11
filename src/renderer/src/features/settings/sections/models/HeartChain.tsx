import type { ReactElement } from 'react'
import { ModelChain } from './ModelChain'
import type { StarkModelIdentity } from './model-library'

interface ChainSectionProps {
  readonly chain: readonly string[]
  readonly library: readonly StarkModelIdentity[]
  /** Entitlement cap for this chain (Free default 5). */
  readonly maxModels?: number
  readonly onAdd: (stableId: string) => void
  readonly onRemove: (stableId: string) => void
  readonly onMove: (stableId: string, direction: 'left' | 'right') => void
}

/**
 * Heart Chain: independent ordered LoopLink configuration (1–cap
 * models, Free default 5). May hold the same models as the Brain
 * Chain; same-chain duplicates are rejected by chain state.
 */
export function HeartChain(props: ChainSectionProps): ReactElement {
  return (
    <ModelChain
      kind="heart"
      title="Heart Chain"
      copy="Order the models the Heart loop may use. Independent of the Brain Chain."
      chain={props.chain}
      library={props.library}
      maxModels={props.maxModels}
      onAdd={props.onAdd}
      onRemove={props.onRemove}
      onMove={props.onMove}
    />
  )
}
