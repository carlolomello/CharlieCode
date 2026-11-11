import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError, streamText, type ModelMessage } from 'ai'
import { findModel } from './catalog'
import { resolveApiKey } from './config'
import type { Platform } from './platform'
import type {
  CharlieConfig,
  EffortLevel,
  EngineEvent,
  ModelEntry,
  ProviderConfig,
  StreamRequest,
  TokenUsage
} from './types'

type CompatibleProvider = ReturnType<typeof createOpenAICompatible>

const providerCache = new Map<string, CompatibleProvider>()

export function resetProviderCache(): void {
  providerCache.clear()
}

export async function providerFor(
  platform: Platform,
  provider: ProviderConfig
): Promise<CompatibleProvider> {
  const { apiKey } = await resolveApiKey(platform, provider)
  const cacheKey = `${provider.id}|${provider.baseUrl}|${apiKey ?? ''}`
  const cached = providerCache.get(cacheKey)
  if (cached) return cached

  const instance = createOpenAICompatible({
    name: provider.id,
    baseURL: provider.baseUrl,
    ...(apiKey ? { apiKey } : {})
  })
  providerCache.set(cacheKey, instance)
  return instance
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.name === 'ResponseAbortedError'
}

interface ErrorInfo {
  message: string
  retryable: boolean
  aborted?: boolean
}

function friendlyError(
  error: unknown,
  provider: ProviderConfig,
  modelId: string
): ErrorInfo {
  if (isAbortError(error)) {
    return { message: 'Generazione interrotta', retryable: false, aborted: true }
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode
    const base = `${provider.label} · ${modelId}`
    if (status === 401 || status === 403) {
      return { message: `${base}: API key non valida (HTTP ${status}). Controlla la key di ${provider.label}.`, retryable: false }
    }
    if (status === 402) {
      return { message: `${base}: quota esaurita (HTTP 402).`, retryable: true }
    }
    if (status === 404) {
      return { message: `${base}: modello non trovato (HTTP 404).`, retryable: true }
    }
    if (status === 429) {
      return { message: `${base}: rate limit (HTTP 429).`, retryable: true }
    }
    if (status && status >= 500) {
      return { message: `${base}: errore del provider (HTTP ${status}).`, retryable: true }
    }
    return { message: `${base}: ${error.message}`, retryable: true }
  }

  const raw = error instanceof Error ? error.message : String(error)
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|timeout|timed out/i.test(raw)) {
    return {
      message: `${provider.label} non raggiungibile su ${provider.baseUrl}. Avvia il router e riprova.`,
      retryable: true
    }
  }

  return { message: `${provider.label} · ${modelId}: ${raw}`, retryable: true }
}

function toUsage(usage: {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  totalTokens?: number | undefined
}): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens
  }
}

function toModelMessages(messages: StreamRequest['messages']): ModelMessage[] {
  return messages.map((message) => ({ role: message.role, content: message.content }))
}

export interface ChatDeps {
  platform: Platform
  config: CharlieConfig
  models: ModelEntry[]
}

interface Candidate {
  provider: ProviderConfig
  model: ModelEntry
}

export function resolveCandidates(
  request: StreamRequest,
  deps: ChatDeps
): { candidates: Candidate[]; error?: string } {
  const requested = findModel(deps.models, request.modelKey)
  if (!requested) {
    return { candidates: [], error: `Modello "${request.modelKey}" non presente nel catalog.` }
  }

  const ordered: ModelEntry[] = [requested]
  for (const key of deps.config.fallbackModels) {
    const model = findModel(deps.models, key)
    if (model && !ordered.some((entry) => entry.key === model.key)) ordered.push(model)
  }

  const candidates: Candidate[] = []
  for (const model of ordered) {
    const provider = deps.config.providers.find((p) => p.id === model.providerId)
    if (provider) candidates.push({ provider, model })
  }

  return { candidates }
}

function resolveEffort(request: StreamRequest, model: ModelEntry, config: CharlieConfig): EffortLevel {
  return request.effort ?? model.effort ?? config.effort
}

/**
 * Streams a completion, walking the configured fallback chain when an attempt
 * fails before producing any text (429, 5xx, dead router, ...).
 *
 * Once text has been emitted we do NOT silently switch model: the renderer gets
 * an explicit error instead of a mixed-up answer.
 */
export async function* streamChat(
  request: StreamRequest,
  deps: ChatDeps
): AsyncGenerator<EngineEvent> {
  const { candidates, error } = resolveCandidates(request, deps)
  if (error || candidates.length === 0) {
    yield { type: 'error', message: error ?? 'Nessun modello disponibile.' }
    return
  }

  if (request.messages.length === 0) {
    yield { type: 'error', message: 'Nessun messaggio da inviare.' }
    return
  }

  let previousFailed: string | undefined

  for (const candidate of candidates) {
    const { provider, model } = candidate
    const effort = resolveEffort(request, model, deps.config)
    const startedAt = Date.now()
    let firstTokenAt: number | undefined
    let emitted = false

    for (let attempt = 0; attempt < 2; attempt++) {
      // The provider error that caused a stream to fail is only visible through
      // `onError`; the thrown error is a generic NoOutputGeneratedError.
      let streamError: unknown
      try {
        const compat = await providerFor(deps.platform, provider)
        const providerOptions =
          effort !== 'none' ? { [provider.id]: { reasoningEffort: effort } } : undefined

        const result = streamText({
          model: compat.chatModel(model.id),
          system: request.system,
          messages: toModelMessages(request.messages),
          maxOutputTokens: request.maxOutputTokens ?? 2048,
          temperature: request.temperature,
          abortSignal: request.signal,
          maxRetries: 0,
          onError: ({ error }) => {
            streamError = error
          },
          ...(providerOptions ? { providerOptions } : {})
        })

        for await (const chunk of result.textStream) {
          if (request.signal?.aborted) {
            yield {
              type: 'done',
              modelKey: model.key,
              ms: Date.now() - startedAt,
              ttftMs: firstTokenAt ? firstTokenAt - startedAt : 0,
              aborted: true
            }
            return
          }
          if (!chunk) continue
          if (!emitted) {
            emitted = true
            firstTokenAt = Date.now()
            yield {
              type: 'start',
              modelKey: model.key,
              label: model.label,
              ...(previousFailed ? { fallbackFrom: previousFailed } : {})
            }
          }
          yield { type: 'delta', text: chunk }
        }

        const usage = await result.usage
        yield {
          type: 'done',
          modelKey: model.key,
          ms: Date.now() - startedAt,
          ttftMs: firstTokenAt ? firstTokenAt - startedAt : Date.now() - startedAt,
          usage: toUsage(usage)
        }
        return
      } catch (caught) {
        const info = friendlyError(streamError ?? caught, provider, model.id)

        if (info.aborted) {
          yield { type: 'done', modelKey: model.key, ms: Date.now() - startedAt, ttftMs: 0, aborted: true }
          return
        }

        // Text already on screen: never retry, the user must decide.
        if (emitted) {
          yield { type: 'error', message: info.message, modelKey: model.key }
          return
        }

        if (attempt === 0 && info.retryable) {
          await sleep(600)
          continue
        }

        previousFailed = `${model.key} (${info.message})`
        break
      }
    }
  }

  yield {
    type: 'error',
    message: previousFailed
      ? `Tutti i modelli hanno fallito. Ultimo errore: ${previousFailed}`
      : 'Nessun modello ha prodotto una risposta.'
  }
}

/** Non-streaming helper used by the CLI and, later, by subagents. */
export async function complete(
  request: Omit<StreamRequest, 'signal'>,
  deps: ChatDeps
): Promise<{ text: string; modelKey: string; events: EngineEvent[] }> {
  const events: EngineEvent[] = []
  let text = ''
  let modelKey = request.modelKey

  for await (const event of streamChat(request, deps)) {
    events.push(event)
    if (event.type === 'start') modelKey = event.modelKey
    if (event.type === 'delta') text += event.text
    if (event.type === 'error') throw new Error(event.message)
  }

  return { text, modelKey, events }
}
