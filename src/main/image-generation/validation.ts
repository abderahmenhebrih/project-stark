/**
 * Strict validation for the image_generate Worker tool (Step 5).
 *
 * The model supplies ONLY prompt/count/closed size — never provider
 * URLs, credentials, filesystem destinations, or attachment paths.
 * Unsupported options are rejected, never forwarded as arbitrary
 * provider JSON.
 */

import {
  MAX_GENERATED_IMAGES,
  MAX_IMAGE_PROMPT_CODEPOINTS,
  SUPPORTED_IMAGE_SIZES
} from '../../shared/ai/image-capabilities'
import { InvalidImageGenerationRequestError } from './errors'

export interface ValidatedImageGenerateArgs {
  readonly prompt: string
  readonly count: number
  readonly size: string | undefined
}

function hasStrictShape(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return false
    }
  }
  return true
}

/** Safe copy shown when the Worker requests images outside policy. */
export const WORKER_IMAGE_GENERATE_DENY_MESSAGE = 'The workspace policy denies image generation.'

/** Safe copy shown when the human denies the image approval. */
export const WORKER_IMAGE_GENERATE_USER_DENY_MESSAGE =
  'You declined image generation, so no images were created.'

/** Safe copy shown when generation cannot complete. */
export const WORKER_IMAGE_GENERATE_UNKNOWN_MESSAGE = 'The image request could not be completed.'

export function parseImageGenerateArgs(args: unknown): ValidatedImageGenerateArgs {
  if (!hasStrictShape(args, ['prompt', 'count']) && !hasStrictShape(args, ['prompt', 'count', 'size'])) {
    throw new InvalidImageGenerationRequestError()
  }
  const record = args as Record<string, unknown>
  const prompt = record['prompt']
  const count = record['count']
  const size = record['size']
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new InvalidImageGenerationRequestError()
  }
  if ([...prompt].length > MAX_IMAGE_PROMPT_CODEPOINTS) {
    throw new InvalidImageGenerationRequestError()
  }
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_GENERATED_IMAGES) {
    throw new InvalidImageGenerationRequestError()
  }
  if (size !== undefined && (typeof size !== 'string' || !SUPPORTED_IMAGE_SIZES.includes(size))) {
    throw new InvalidImageGenerationRequestError()
  }
  return { prompt: prompt.trim(), count, size: size as string | undefined }
}

/**
 * Exact approval summary for one validated generation request (inert
 * text, cost-bearing action disclosed).
 */
export function buildImageGenerateApprovalSummary(validated: ValidatedImageGenerateArgs): string {
  const what = validated.count === 1 ? 'Generate 1 image' : `Generate ${String(validated.count)} images`
  return `${what} using the configured AI provider (may use provider credits/API quota)`
}
