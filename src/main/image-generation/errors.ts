/**
 * Image generation domain errors (Step 5).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain provider payloads, stack traces,
 * API keys, image bytes, URLs, or IPC channel names.
 */

export class ImageGenerationError extends Error {
  override readonly name: string = 'ImageGenerationError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Generation request payload failed runtime validation. */
export class InvalidImageGenerationRequestError extends ImageGenerationError {
  override readonly name = 'InvalidImageGenerationRequestError'

  constructor() {
    super('That image request is not valid.')
  }
}

/** No image-generation provider is configured. */
export class ImageProviderUnavailableError extends ImageGenerationError {
  override readonly name = 'ImageProviderUnavailableError'

  constructor() {
    super('No image-generation provider is configured.')
  }
}

/** The selected provider cannot generate images. */
export class ImageCapabilityUnsupportedError extends ImageGenerationError {
  override readonly name = 'ImageCapabilityUnsupportedError'

  constructor() {
    super('The selected provider cannot generate images.')
  }
}

/** The generation request timed out (single attempt, no retry). */
export class ImageGenerationTimeoutError extends ImageGenerationError {
  override readonly name = 'ImageGenerationTimeoutError'

  constructor(options?: { cause?: unknown }) {
    super('Image generation timed out.', options)
  }
}

/** The generation request failed without a more specific cause. */
export class ImageGenerationFailedError extends ImageGenerationError {
  override readonly name = 'ImageGenerationFailedError'

  constructor(options?: { cause?: unknown }) {
    super('Image generation failed.', options)
  }
}

/** Provider output was not a valid bounded image. */
export class InvalidGeneratedImageError extends ImageGenerationError {
  override readonly name = 'InvalidGeneratedImageError'

  constructor() {
    super('The generated image was invalid.')
  }
}

/** A generated image exceeded STARK's size limit. */
export class GeneratedImageTooLargeError extends ImageGenerationError {
  override readonly name = 'GeneratedImageTooLargeError'

  constructor() {
    super('The generated image exceeded STARK’s size limit.')
  }
}

/**
 * Maps any image-generation failure to a renderer-safe Error carrying
 * displayable copy only. Unknown failures collapse to the generic
 * copy — never raw provider payloads or stacks.
 */
export function toPublicImageGenerationError(error: unknown): Error {
  if (
    error instanceof InvalidImageGenerationRequestError ||
    error instanceof ImageProviderUnavailableError ||
    error instanceof ImageCapabilityUnsupportedError ||
    error instanceof ImageGenerationTimeoutError ||
    error instanceof ImageGenerationFailedError ||
    error instanceof InvalidGeneratedImageError ||
    error instanceof GeneratedImageTooLargeError
  ) {
    return new Error(error.message)
  }
  if (error instanceof ImageGenerationError) {
    return new Error('Image generation failed.')
  }
  return new Error('Image generation failed.')
}
