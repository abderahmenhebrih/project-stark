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
 * Brain Chain: ordered LoopLink configuration (1–cap models, Free
 * default 5). Stores order only — no routing or execution lives here.
 */
export function BrainChain(props: ChainSectionProps): ReactElement {
  return (
    <ModelChain
      kind="brain"
      title="Brain Chain"
      copy="Order the models the Brain loop may use. Order matters."
      chain={props.chain}
      library={props.library}
      maxModels={props.maxModels}
      onAdd={props.onAdd}
      onRemove={props.onRemove}
      onMove={props.onMove}
    />
  )
}
