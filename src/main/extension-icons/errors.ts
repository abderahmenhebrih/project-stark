/**
 * Extension-icon domain errors (icon display only).
 *
 * Failures collapse to a single safe message: the renderer falls back
 * to its local generic glyph for that one entry. No URLs, hosts,
 * statuses, content types, or stack traces ever cross IPC.
 */

export class ExtensionIconError extends Error {
  override readonly name: string = 'ExtensionIconError'

  constructor(message = 'We couldn’t load this extension icon.', options?: { cause?: unknown }) {
    super(message, options)
  }
}
