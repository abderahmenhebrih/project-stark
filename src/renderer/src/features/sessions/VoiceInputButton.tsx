import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_DURATION_MS
} from '../../../../shared/voice/types'
import { StarkIcon } from '../../components/icons/StarkIcon'
import { normalizeVoiceError, VOICE_FAILED_MESSAGE, VOICE_TOO_LONG_MESSAGE } from '../../lib/voice-error'
import { transcribeVoiceAudio } from '../../lib/voice-api'
import {
  encodeAudioBase64,
  formatVoiceElapsed,
  mapMicrophoneErrorName,
  probeVoiceMimeType,
  voiceRecordingExhausted,
  type VoiceRecorderPhase
} from './voice-recorder'

interface VoiceInputButtonProps {
  /** Disabled while sending/preparing (mirrors the attach button). */
  readonly disabled: boolean
  /** Remount/cleanup key: parent passes the active session id. */
  readonly sessionKey: string
  /** Inserts normalized text into the composer (never auto-sends). */
  readonly onTranscribed: (text: string) => void
}

/**
 * Chat-composer microphone control (Step 4).
 *
 * Explicit user click only — STARK never starts recording
 * automatically, never listens in the background, and never requests
 * microphone permission at startup. Chunks stay in renderer memory
 * only during the active recording; Cancel discards them with no
 * transcription request. Every owned MediaStreamTrack stops on Stop,
 * Cancel, unmount, and session switch (via `sessionKey` remount).
 */
export function VoiceInputButton({ disabled, sessionKey, onTranscribed }: VoiceInputButtonProps): ReactElement {
  const [phase, setPhase] = useState<VoiceRecorderPhase>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const bytesRef = useRef(0)
  const mimeRef = useRef('')
  const cancelledRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const mountedRef = useRef(true)

  const stopTracks = useCallback((): void => {
    const stream = streamRef.current
    streamRef.current = null
    if (stream !== null) {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Best effort: release every owned track regardless.
        }
      }
    }
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    recorderRef.current = null
  }, [])

  // Unmount and session switch: stop every owned track, discard
  // buffered audio, make no transcription request.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancelledRef.current = true
      chunksRef.current = []
      bytesRef.current = 0
      stopTracks()
    }
  }, [sessionKey, stopTracks])

  const finishRecording = useCallback(
    (cancelled: boolean): void => {
      const recorder = recorderRef.current
      if (recorder === null || recorder.state === 'inactive') {
        chunksRef.current = []
        bytesRef.current = 0
        stopTracks()
        if (mountedRef.current) {
          setPhase('idle')
          setElapsedMs(0)
        }
        return
      }
      cancelledRef.current = cancelled
      if (cancelled) {
        chunksRef.current = []
        bytesRef.current = 0
      }
      try {
        recorder.stop()
      } catch {
        chunksRef.current = []
        bytesRef.current = 0
        stopTracks()
        if (mountedRef.current) {
          setPhase('idle')
          setElapsedMs(0)
        }
      }
    },
    [stopTracks]
  )

  const handleRecorderStop = useCallback((): void => {
    const chunks = chunksRef.current
    const mimeType = mimeRef.current
    const cancelled = cancelledRef.current
    chunksRef.current = []
    bytesRef.current = 0
    stopTracks()
    if (!mountedRef.current) {
      return
    }
    if (cancelled) {
      setPhase('idle')
      setElapsedMs(0)
      return
    }
    if (chunks.length === 0) {
      setPhase('idle')
      setElapsedMs(0)
      setError(VOICE_FAILED_MESSAGE)
      return
    }
    setPhase('transcribing')
    const blob = new Blob(chunks, { type: mimeType })
    if (blob.size > VOICE_MAX_AUDIO_BYTES) {
      setPhase('idle')
      setElapsedMs(0)
      setError('Recording is too large.')
      return
    }
    void blob
      .arrayBuffer()
      .then((buffer) => {
        if (cancelledRef.current || !mountedRef.current) {
          return
        }
        const bytes = new Uint8Array(buffer)
        if (bytes.length === 0) {
          setPhase('idle')
          setElapsedMs(0)
          setError(VOICE_FAILED_MESSAGE)
          return
        }
        return transcribeVoiceAudio(encodeAudioBase64(bytes), mimeType).then(
          (text) => {
            if (!mountedRef.current) {
              return
            }
            onTranscribed(text)
            setPhase('idle')
            setElapsedMs(0)
          },
          (error: unknown) => {
            if (!mountedRef.current) {
              return
            }
            setPhase('idle')
            setElapsedMs(0)
            setError(normalizeVoiceError(error).message)
          }
        )
      })
      .catch(() => {
        if (!mountedRef.current) {
          return
        }
        setPhase('idle')
        setElapsedMs(0)
        setError(VOICE_FAILED_MESSAGE)
      })
  }, [onTranscribed, stopTracks])

  const startRecording = useCallback((): void => {
    if (phase !== 'idle' || disabled) {
      return
    }
    setError(null)
    const mediaDevices = navigator.mediaDevices
    if (mediaDevices === undefined || typeof mediaDevices.getUserMedia !== 'function') {
      setError('No microphone was found.')
      return
    }
    let supported: string | null
    try {
      supported =
        typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function'
          ? null
          : probeVoiceMimeType((mimeType) => MediaRecorder.isTypeSupported(mimeType))
    } catch {
      supported = null
    }
    if (supported === null) {
      setError('That recording format can’t be transcribed.')
      return
    }
    const mimeType = supported
    mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then(
        (stream) => {
          if (!mountedRef.current) {
            for (const track of stream.getTracks()) {
              try {
                track.stop()
              } catch {
                // Best effort.
              }
            }
            return
          }
          streamRef.current = stream
          chunksRef.current = []
          bytesRef.current = 0
          mimeRef.current = mimeType
          cancelledRef.current = false
          let recorder: MediaRecorder
          try {
            recorder = new MediaRecorder(stream, { mimeType })
          } catch {
            stopTracks()
            setError('That recording format can’t be transcribed.')
            return
          }
          recorderRef.current = recorder
          startedAtRef.current = Date.now()
          setPhase('recording')
          setElapsedMs(0)
          timerRef.current = window.setInterval(() => {
            if (!mountedRef.current) {
              return
            }
            const elapsed = Date.now() - startedAtRef.current
            setElapsedMs(elapsed)
            if (voiceRecordingExhausted(elapsed, bytesRef.current)) {
              if (elapsed >= VOICE_MAX_DURATION_MS) {
                setError(VOICE_TOO_LONG_MESSAGE)
              }
              finishRecording(false)
            }
          }, 500)
          recorder.ondataavailable = (event: BlobEvent): void => {
            const chunk: Blob = event.data
            if (chunk.size === 0) {
              return
            }
            bytesRef.current += chunk.size
            if (bytesRef.current > VOICE_MAX_AUDIO_BYTES) {
              setError('Recording is too large.')
              finishRecording(false)
              return
            }
            chunksRef.current.push(chunk)
          }
          recorder.onstop = (): void => {
            handleRecorderStop()
          }
          try {
            recorder.start(250)
          } catch {
            stopTracks()
            setPhase('idle')
            setError('No microphone was found.')
          }
        },
        (error: unknown) => {
          if (!mountedRef.current) {
            return
          }
          const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : ''
          setError(mapMicrophoneErrorName(name))
        }
      )
      .catch(() => {
        if (mountedRef.current) {
          setError(VOICE_FAILED_MESSAGE)
        }
      })
  }, [disabled, finishRecording, handleRecorderStop, phase, stopTracks])

  if (phase === 'recording') {
    return (
      <span className="session__voice" role="status" aria-label={`Recording voice input, ${formatVoiceElapsed(elapsedMs)} elapsed`}>
        <button
          className="explorer__secondary session__attach"
          type="button"
          onClick={() => finishRecording(false)}
          aria-label="Stop recording"
          title="Stop recording"
        >
          <StarkIcon name="mic" size={15} />
        </button>
        <span className="session__voice-elapsed" aria-hidden="true">
          {formatVoiceElapsed(elapsedMs)}
        </span>
        <button
          className="explorer__secondary session__attach"
          type="button"
          onClick={() => finishRecording(true)}
          aria-label="Cancel recording"
          title="Cancel recording"
        >
          <StarkIcon name="close" size={12} />
        </button>
      </span>
    )
  }

  return (
    <span className="session__voice">
      <button
        className="explorer__secondary session__attach"
        type="button"
        onClick={startRecording}
        disabled={disabled || phase === 'transcribing'}
        aria-label="Start voice input"
        title="Start voice input"
      >
        <StarkIcon name="mic" size={15} />
      </button>
      {phase === 'transcribing' && (
        <span className="session__hint" role="status">
          Transcribing…
        </span>
      )}
      {error !== null && phase === 'idle' && (
        <span className="session__hint" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}
