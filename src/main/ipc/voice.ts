import { IPC_CHANNELS } from '../../shared/constants'
import type { VoiceTranscribeResult } from '../../shared/voice/types'
import { toPublicVoiceError } from '../voice/errors'
import type { VoiceTranscriptionService } from '../voice/voice-transcription-service'
import type { IpcBinding } from './binding'

/**
 * Voice transcription IPC bindings (Step 4): exactly one narrow
 * invoke channel (`voiceTranscribe`). The renderer supplies ONLY
 * encoded audio bytes plus the probed MIME type — never provider
 * URLs, models, credentials, or filesystem paths. Registration
 * through handleSecureIpc happens in ./index.ts.
 */
export function createVoiceBindings(service: VoiceTranscriptionService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.voiceTranscribe,
      invoke: (payload): Promise<VoiceTranscribeResult> =>
        Promise.resolve()
          .then(() => service.transcribe(payload))
          .then((result) => ({ text: result.text }) satisfies VoiceTranscribeResult)
          .catch((error: unknown) => {
            throw toPublicVoiceError(error)
          })
    }
  ]
}
