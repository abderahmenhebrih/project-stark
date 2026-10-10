/**
 * Pure Monaco JSON-schema mapping for `contributes.jsonValidation`
 * (no Monaco/DOM imports so it stays unit-testable in Node).
 *
 * Main owns resolution (local containment reads + bounded remote
 * fetch); the renderer receives inline schemas only. This module
 * validates those entries renderer-side and maps them to
 * `jsonDefaults.setDiagnosticsOptions` shapes:
 * - owner-scoped URIs (`stark-extension-schema://<owner>/<index>`)
 *   so disable/uninstall drops the entry on the next refresh
 * - bounded fileMatch patterns and schema bytes
 * - oversized/malformed entries skipped (never throw into the editor)
 */

export interface IncomingJsonSchema {
  readonly owner: unknown
  readonly fileMatch: unknown
  readonly url: unknown
  readonly schema: unknown
}

export interface MappedJsonSchema {
  readonly uri: string
  readonly fileMatch: string[]
  readonly schema: Record<string, unknown>
}

/** Maximum schemas mapped per refresh (bounded). */
export const JSON_SCHEMA_MAP_MAX = 64

/** Maximum inline schema bytes accepted renderer-side (bounded). */
export const JSON_SCHEMA_MAP_MAX_BYTES = 256 * 1024

/**
 * Maps main-resolved schema entries to Monaco shapes (pure,
 * deterministic). Skips anything malformed, oversized, or
 * owner-less — the editor renders without it.
 */
export function mapJsonSchemasForMonaco(entries: readonly unknown[]): MappedJsonSchema[] {
  const mapped: MappedJsonSchema[] = []
  const seen = new Set<string>()
  entries.slice(0, JSON_SCHEMA_MAP_MAX).forEach((entry, index) => {
    if (mapped.length >= JSON_SCHEMA_MAP_MAX) {
      return
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return
    }
    const record = entry as IncomingJsonSchema
    const owner = typeof record.owner === 'string' && record.owner !== '' ? record.owner.slice(0, 200) : null
    const fileMatch = Array.isArray(record.fileMatch)
      ? record.fileMatch
          .filter((pattern): pattern is string => typeof pattern === 'string' && pattern !== '' && pattern.length <= 256)
          .slice(0, 16)
      : []
    const schema =
      record.schema !== null && typeof record.schema === 'object' && !Array.isArray(record.schema)
        ? (record.schema as Record<string, unknown>)
        : null
    if (owner === null || fileMatch.length === 0 || schema === null) {
      return
    }
    let serialized: string
    try {
      serialized = JSON.stringify(schema) ?? ''
    } catch {
      return
    }
    if (serialized.length === 0 || serialized.length > JSON_SCHEMA_MAP_MAX_BYTES) {
      return
    }
    const uri = `stark-extension-schema://${owner}/${index}`
    if (seen.has(uri)) {
      return
    }
    seen.add(uri)
    mapped.push({ uri, fileMatch: [...fileMatch], schema })
  })
  return mapped
}
