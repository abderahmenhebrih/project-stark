import OpenAI from 'openai'
import { AI_GENERATE_TIMEOUT_MS, MAX_PROVIDER_MODELS, PROVIDER_REQUEST_TIMEOUT_MS } from './limits'
import {
  classifyProviderError,
  type AiProviderAdapter,
  type ProviderGenerateRequest
} from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { ProviderEmptyResponseError } from './errors'

/**
 * Minimal structural surface of the official OpenAI SDK used by the
 * adapter. The production factory returns the real client; tests
 * inject mocks of this shape — no network in unit tests.
 */
export interface OpenAiModelsClient {
  list(options?: { timeout?: number; maxRetries?: number }): Promise<{ data: readonly { id: string }[] } | AsyncIterable<{ id: string }>>
}

export interface OpenAiResponsesClient {
  create(
    params: {
      model: string
      instructions: string
      input: readonly { role: 'user' | 'assistant' | 'system' | 'developer'; content: string }[]
      max_output_tokens: number
      store: boolean
    },
    options?: { timeout?: number; maxRetries?: number }
  ): Promise<{ output_text?: string; output?: readonly unknown[] }>
}

export interface OpenAiClientLike {
  readonly models: OpenAiModelsClient
  readonly responses: OpenAiResponsesClient
}

export type OpenAiClientFactory = (apiKey: string) => OpenAiClientLike

/** Production factory: official endpoint, no retries, bounded timeout. */
export function createOpenAiClient(apiKey: string): OpenAiClientLike {
  return new OpenAI({ apiKey, maxRetries: 0, timeout: PROVIDER_REQUEST_TIMEOUT_MS }) as unknown as OpenAiClientLike
}

function extractOutputText(response: { output_text?: string; output?: readonly unknown[] }): string | null {
  if (typeof response.output_text === 'string' && response.output_text !== '') {
    return response.output_text
  }
  // Fallback: walk output items for message/output_text blocks without
  // ever persisting provider-internal structures.
  const chunks: string[] = []
  for (const item of response.output ?? []) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const record = item as Record<string, unknown>
    const content = record['content']
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      if (typeof block !== 'object' || block === null) {
        continue
      }
      const part = block as Record<string, unknown>
      if (part['type'] === 'output_text' && typeof part['text'] === 'string') {
        chunks.push(part['text'])
      }
    }
  }
  return chunks.length > 0 ? chunks.join('') : null
}

/**
 * Stage 14's only network adapter: OpenAI. Main process only, fixed
 * official endpoint (renderer can never supply a base URL), zero
 * SDK retries, bounded per-request timeouts, Responses API with
 * `store: false`, no tools, no conversations, no
 * `previous_response_id`. Secrets stay main-only: the key arrives per
 * call and is never retained, logged, or returned.
 */
export class OpenAiProviderAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'

  constructor(private readonly clients: OpenAiClientFactory = createOpenAiClient) {}

  async listModels(apiKey: string): Promise<readonly ProviderModel[]> {
    try {
      const page = await this.clients(apiKey).models.list({ timeout: PROVIDER_REQUEST_TIMEOUT_MS, maxRetries: 0 })
      const items = Symbol.asyncIterator in Object(page) ? await collectAsync(page as AsyncIterable<{ id: string }>) : [...(page as { data: readonly { id: string }[] }).data]
      return items
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
        .sort()
        .slice(0, MAX_PROVIDER_MODELS)
        .map((id) => ({ id }))
    } catch (error) {
      throw classifyProviderError(error)
    }
  }

  async generateText(request: ProviderGenerateRequest & { readonly apiKey: string }): Promise<{ text: string }> {
    try {
      const response = await this.clients(request.apiKey).responses.create(
        {
          model: request.model,
          instructions: request.instructions,
          input: request.messages.map((entry) => ({ role: entry.role, content: entry.content })),
          max_output_tokens: request.maxOutputTokens,
          store: false
        },
        { timeout: AI_GENERATE_TIMEOUT_MS, maxRetries: 0 }
      )
      const text = extractOutputText(response)
      if (text === null || text === '') {
        throw new ProviderEmptyResponseError()
      }
      return { text }
    } catch (error) {
      if (error instanceof ProviderEmptyResponseError) {
        throw error
      }
      throw classifyProviderError(error)
    }
  }
}

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const entry of iterable) {
    items.push(entry)
  }
  return items
}
