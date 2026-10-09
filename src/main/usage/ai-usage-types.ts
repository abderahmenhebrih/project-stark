/**
 * Provider-neutral local usage shape (Stage 28).
 *
 * Token fields carry provider-REPORTED values only. Null means the
 * provider did not report that value — STARK never estimates,
 * tokenizes, or invents missing token usage.
 */
export interface ProviderUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
}

/** Empty (unavailable) usage: provider reported nothing usable. */
export const EMPTY_PROVIDER_USAGE: ProviderUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null
}

function isUsableTokenCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}

/**
 * Normalizes a provider-reported usage payload into ProviderUsage.
 * Accepts Responses-API-style `{input_tokens, output_tokens,
 * total_tokens}` records (numbers only). Anything missing, negative,
 * non-integer, unsafe, NaN/Infinity, or string-typed sanitizes to
 * null rather than inventing values. Inconsistent payloads (e.g. a
 * total smaller than the parts) sanitize the total to null.
 */
export function normalizeProviderUsage(value: unknown): ProviderUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return EMPTY_PROVIDER_USAGE
  }
  const record = value as Record<string, unknown>
  const inputTokens = isUsableTokenCount(record['input_tokens']) ? (record['input_tokens'] as number) : null
  const outputTokens = isUsableTokenCount(record['output_tokens']) ? (record['output_tokens'] as number) : null
  let totalTokens = isUsableTokenCount(record['total_tokens']) ? (record['total_tokens'] as number) : null
  // Also accept the normalized camelCase aliases some SDK surfaces use.
  const inputAlias = isUsableTokenCount(record['inputTokens']) ? (record['inputTokens'] as number) : null
  const outputAlias = isUsableTokenCount(record['outputTokens']) ? (record['outputTokens'] as number) : null
  const totalAlias = isUsableTokenCount(record['totalTokens']) ? (record['totalTokens'] as number) : null
  const input = inputTokens ?? inputAlias
  const output = outputTokens ?? outputAlias
  const total = totalTokens ?? totalAlias
  totalTokens = total
  if (
    totalTokens !== null &&
    input !== null &&
    output !== null &&
    totalTokens < input + output &&
    input + output <= Number.MAX_SAFE_INTEGER
  ) {
    totalTokens = null
  }
  if (input === null && output === null && totalTokens === null) {
    return EMPTY_PROVIDER_USAGE
  }
  return { inputTokens: input, outputTokens: output, totalTokens }
}

/** Main-owned bounded provider-call operation labels. Renderers never supply these. */
export const USAGE_OPERATIONS: readonly string[] = [
  'ask',
  'brain_plan',
  'worker',
  'worker_followup',
  'brain_synthesis',
  'single_proposal',
  'multi_proposal',
  'recovery_ask',
  'recovery_brain_plan',
  'recovery_worker',
  'recovery_brain_synthesis'
]

/** True for exactly the known main-owned operation labels. */
export function isUsageOperation(value: string): boolean {
  return (USAGE_OPERATIONS as readonly string[]).includes(value)
}

/** Roles recorded on usage events (renderer display only). */
export type UsageEventRole = 'ask' | 'brain' | 'worker' | 'proposal' | 'recovery'
