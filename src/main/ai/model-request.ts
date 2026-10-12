import { InvalidProviderRequestError } from './errors'

/**
 * Reads the optional stable model selector from a request payload.
 *
 * Absent (or null) means the legacy persisted BYOK selection. A
 * present value must be a bounded stable id (`builtin:*` for STARK
 * Free, `openai:*` for connected BYOK labels); overlong or
 * NUL-containing values are rejected. Only `builtin:*` changes
 * routing — anything else keeps legacy behavior at the call site.
 */
export function readRequestedModel(payload: Record<string, unknown>): string | null {
  if (!('model' in payload) || payload['model'] === undefined || payload['model'] === null) {
    return null
  }
  const model = payload['model']
  if (typeof model !== 'string' || model === '' || model.length > 128 || model.includes('\0')) {
    throw new InvalidProviderRequestError('model reference is invalid')
  }
  return model
}
