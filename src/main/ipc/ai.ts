import { IPC_CHANNELS } from '../../shared/constants'
import type { AiChangeSetProposalResult, AiFileChangeProposalResult, AskRecoveryResult } from '../../shared/ai/types'
import type { AiCodeProposalService } from '../ai/ai-code-proposal-service'
import type { AiCompletionService } from '../ai/ai-completion-service'
import type { AiMultiFileProposalService } from '../ai/ai-multi-file-proposal-service'
import type { AiRecoveryCoordinator } from '../recovery/recovery-coordinator'
import { toPublicChangeSetProposalError } from '../ai/ai-change-set-errors'
import { toPublicProposalError } from '../ai/ai-proposal-errors'
import { toPublicProviderError } from '../ai/errors'
import type { IpcBinding } from './binding'

/**
 * AI IPC bindings (Stage 14 + Stage 16 + Stage 17 + Stage 21): exactly
 * three invoke channels — assistant generation (with single-hop
 * recovery when a coordinator is present), single-file code
 * proposals, and grouped multi-file proposals. The renderer submits
 * workspace/session references only. Recovery returns a discriminated
 * result (completed / recovery_handoff / recovered) — never parsed
 * error strings. Proposals never recover.
 */
export function createAiBindings(
  completion: AiCompletionService,
  proposals?: AiCodeProposalService,
  changeSets?: AiMultiFileProposalService,
  recovery?: AiRecoveryCoordinator
): readonly IpcBinding[] {
  const bindings: IpcBinding[] = [
    {
      channel: IPC_CHANNELS.aiGenerateResponse,
      invoke: (payload): Promise<AskRecoveryResult> => {
        if (recovery !== undefined) {
          return recovery.ask(payload).catch((error: unknown) => {
            throw toPublicProviderError('generate', error)
          })
        }
        return completion
          .generateResponse(payload)
          .then((result) => ({ kind: 'completed', result }) as AskRecoveryResult)
          .catch((error: unknown) => {
            throw toPublicProviderError('generate', error)
          })
      }
    }
  ]
  if (proposals !== undefined) {
    bindings.push({
      channel: IPC_CHANNELS.aiProposeFileChange,
      invoke: (payload): Promise<AiFileChangeProposalResult> =>
        proposals.proposeFileChange(payload).catch((error: unknown) => {
          throw toPublicProposalError('propose', error)
        })
    })
  }
  if (changeSets !== undefined) {
    bindings.push({
      channel: IPC_CHANNELS.aiProposeChangeSet,
      invoke: (payload): Promise<AiChangeSetProposalResult> =>
        changeSets.proposeChangeSet(payload).catch((error: unknown) => {
          throw toPublicChangeSetProposalError('propose-set', error)
        })
    })
  }
  return bindings
}
