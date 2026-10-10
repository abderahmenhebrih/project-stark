import { getStarkApi } from './stark-api'

function unavailable(): Promise<never> {
  return Promise.reject(new Error('Voice input is unavailable.'))
}

/**
 * Typed voice transcription caller (Step 4).
 *
 * The renderer supplies ONLY encoded audio bytes plus the probed MIME
 * type through one narrow channel — never provider URLs, models,
 * credentials, or filesystem paths. Audio exists only long enough to
 * transcribe; STARK never persists recordings.
 */
export function transcribeVoiceAudio(audioBase64: string, mimeType: string): Promise<string> {
  const api = getStarkApi()?.voice.transcribe
  if (api === undefined) {
    return unavailable()
  }
  return api({ audioBase64, mimeType }).then((result) => result.text)
}
