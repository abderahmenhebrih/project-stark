import { TextEncoder } from 'node:util'
import { InvalidSessionMessageError, SessionMessageTooLargeError } from './errors'
import { MAX_MESSAGE_BYTES } from './limits'

const encoder = new TextEncoder()

/** C0 controls except \t \n \r, plus DEL — never valid in a message. */
function isRejectedControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) {
    return false
  }
  if (code < 0x20 || code === 0x7f) {
    return true
  }
  // C1 controls are never legitimate user-typed text.
  return code >= 0x80 && code <= 0x9f
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

/**
 * Validates renderer-supplied user message content. Returns the exact
 * input unchanged — never trimmed, never normalized — or throws.
 *
 * Rejects non-strings, empty/whitespace-only input, NUL bytes,
 * unpaired UTF-16 surrogates, C0/C1 controls outside \t \n \r and
 * DEL, and content over MAX_MESSAGE_BYTES of UTF-8.
 */
export function validateUserMessageContent(content: unknown): string {
  if (typeof content !== 'string') {
    throw new InvalidSessionMessageError()
  }
  if (content.trim().length === 0) {
    throw new InvalidSessionMessageError()
  }
  return validateUserMessageContentAllowEmpty(content)
}

/**
 * Validates message content that may be empty because attachments
 * carry the message. All byte/control/surrogate rules still apply —
 * only the empty rejection is lifted.
 */
export function validateUserMessageContentAllowEmpty(content: unknown): string {
  if (typeof content !== 'string') {
    throw new InvalidSessionMessageError()
  }
  // NUL byte written as an escape on purpose: no raw control bytes in source.
  if (content.includes('\0')) {
    throw new InvalidSessionMessageError()
  }
  if (hasUnpairedSurrogate(content)) {
    throw new InvalidSessionMessageError()
  }
  for (let index = 0; index < content.length; index += 1) {
    if (isRejectedControl(content.charCodeAt(index))) {
      throw new InvalidSessionMessageError()
    }
  }
  if (encoder.encode(content).byteLength > MAX_MESSAGE_BYTES) {
    throw new SessionMessageTooLargeError()
  }
  return content
}
