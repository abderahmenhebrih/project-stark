import { IPC_CHANNELS } from '../../shared/constants'
import type { AiGenerateResult } from '../../shared/ai/types'
import type { AiCompletionService } from '../ai/ai-completion-service'
import { toPublicProviderError } from '../ai/errors'
import type { IpcBinding } from './binding'

/**
 * AI generation IPC binding (Stage 14): exactly one invoke channel.
 * The renderer submits workspace/session references only — provider,
 * credential, model, history, and instruction all resolve from trusted
 * local state in main. No assistant writes, no tool use, no agent runner.
 * Registration through handleSecureIpc happens in ./index.ts.
 */
export function createAiBindings(service: AiCompletionService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.aiGenerateResponse,
      invoke: (payload): Promise<AiGenerateResult> =>
        service.generateResponse(payload).catch((error: unknown) => {
          throw toPublicProviderError('generate', error)
        })
    }
  ]
}
