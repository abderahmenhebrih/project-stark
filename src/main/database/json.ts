import { DatabaseError } from './errors'
import type { JsonValue } from './types'

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Asserts that a value round-trips through JSON without silent corruption.
 * Rejects undefined, functions, symbols, bigints, non-finite numbers, and
 * class instances — including nested ones — because JSON.stringify would
 * drop, coerce, or throw on them unpredictably.
 */
export function assertJsonValue(value: unknown, context: string): asserts value is JsonValue {
  if (value === null) {
    return
  }
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') {
    return
  }
  if (kind === 'number') {
    if (!Number.isFinite(value)) {
      throw new DatabaseError(`${context} must be a finite number`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertJsonValue(entry, `${context}[${index}]`)
    })
    return
  }
  if (typeof value === 'object' && value !== null) {
    if (!isPlainObject(value)) {
      throw new DatabaseError(`${context} must be a plain JSON object`)
    }
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${context}.${key}`)
    }
    return
  }
  throw new DatabaseError(`${context} is not JSON-serializable`)
}
