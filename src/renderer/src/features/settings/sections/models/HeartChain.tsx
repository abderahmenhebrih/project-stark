import type { ReactElement } from 'react'
import { ModelChain } from './ModelChain'
import type { StarkModelIdentity } from './model-library'

interface ChainSectionProps {
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

/**
 * Heart LoopLink roster: full eligible catalog, enabled-first.
 * Independent of the Brain LoopLink; same-chain duplicates are
 * rejected by chain state.
 */
export function HeartChain(props: ChainSectionProps): ReactElement {
  return (
    <ModelChain
      kind="heart"
      title="Heart LoopLink"
      copy="Order the models the Heart loop may use. Independent of the Brain LoopLink."
      chain={props.chain}
      library={props.library}
      maxModels={props.maxModels}
      planLabel={props.planLabel}
      onToggle={props.onToggle}
      onSwap={props.onSwap}
      onReorder={props.onReorder}
      onNavigateBilling={props.onNavigateBilling}
    />
  )
}
