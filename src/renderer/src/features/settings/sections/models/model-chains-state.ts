import { createDefaultFreeBrainChain, createDefaultFreeHeartChain } from './model-library'
import { addToChain, moveInChain, removeFromChain, type ChainMoveDirection } from './model-chain'

/**
 * Renderer-local Brain/Heart chain configuration state (no React
 * imports) so add/remove/reorder/workspace-isolation are unit-testable
 * with the Node runner. Mirrors the panel-state pattern: workspace
 * switches reset both chains; stale/cross-workspace actions are
 * rejected.
 *
 * Fresh state starts with the product Free defaults (best-5 Brain +
 * best-5 Heart from the locked catalog) — never empty on first sight.
 * Defaults apply ONLY at initialization: every later user action
 * (add/remove/move) operates on live state and never re-applies them,
 * so reorders, removals, and even an intentionally emptied chain are
 * preserved for the life of the workspace session.
 *
 * Persistence is intentionally session-local: there is no chain
 * storage in schema v19 and this pass adds no migration and no IPC.
 * Configuration survives while the workspace session lives and resets
 * (to defaults) on workspace switch — reported as the known limitation
 * until the AI integration pass owns chain persistence. No secrets ever
 * enter this state (stable model ids only).
 */

export interface ModelChainsPanelState {
  readonly workspaceId: number | null
  readonly brain: readonly string[]
  readonly heart: readonly string[]
}

export function initialModelChainsPanelState(): ModelChainsPanelState {
  return { workspaceId: null, brain: createDefaultFreeBrainChain(), heart: createDefaultFreeHeartChain() }
}

export type ModelChainsPanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | {
      readonly type: 'chain-add'
      readonly workspaceId: number
      readonly chain: 'brain' | 'heart'
      readonly stableId: string
      /** Entitlement cap (Free default 5). Absent means Free. */
      readonly maxModels?: number
    }
  | { readonly type: 'chain-remove'; readonly workspaceId: number; readonly chain: 'brain' | 'heart'; readonly stableId: string }
  | {
      readonly type: 'chain-move'
      readonly workspaceId: number
      readonly chain: 'brain' | 'heart'
      readonly stableId: string
      readonly direction: ChainMoveDirection
    }

export function modelChainsPanelReducer(
  state: ModelChainsPanelState,
  action: ModelChainsPanelAction
): ModelChainsPanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialModelChainsPanelState(), workspaceId: action.workspaceId }
    case 'chain-add': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      const current = action.chain === 'brain' ? state.brain : state.heart
      const outcome = addToChain(current, action.stableId, action.maxModels)
      if (!outcome.applied) {
        return state
      }
      return action.chain === 'brain' ? { ...state, brain: outcome.chain } : { ...state, heart: outcome.chain }
    }
    case 'chain-remove': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return action.chain === 'brain'
        ? { ...state, brain: removeFromChain(state.brain, action.stableId) }
        : { ...state, heart: removeFromChain(state.heart, action.stableId) }
    }
    case 'chain-move': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return action.chain === 'brain'
        ? { ...state, brain: moveInChain(state.brain, action.stableId, action.direction) }
        : { ...state, heart: moveInChain(state.heart, action.stableId, action.direction) }
    }
  }
}
