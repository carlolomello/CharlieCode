import { resolveApiKey } from './config'
import {
  detectRouterBaseUrl,
  getDetectedBaseUrl,
  rememberDetectedBaseUrl
} from './discovery'
import { describeNetworkError } from './errors'
import type { Platform } from './platform'
import type {
  CatalogError,
  EffortLevel,
  CatalogResult,
  CharlieCodeConfig,
  ModelCaps,
  ModelEntry,
  ProviderConfig
} from './types'

const NON_CHAT_MODEL =
  /(embed|embedding|whisper|tts|speech|transcri|image|imagen|flux|sdxl|dall-e|stable-diffusion|rerank|moderation|audio|video|guard|safety)/i

const VISION_MODEL =
  /(vision|llava|pixtral|gemini|gpt-4o|gpt-4\.1|gpt-5|claude|qwen[\w.-]*vl|internvl|molmo|phi[\w.-]*vision|llama[\w.-]*vision)/i

const DEFAULT_CONTEXT = 32_768

/**
 * Effort is a provider-side knob (`reasoning_effort`), so it only makes sense
 * for models that actually reason. Offering "max" on a small chat model is how
 * you get confusing 400s, so the picker only lists what the model supports.
 */
const REASONING_MODEL =
  /(reasoning|thinking|think|deepseek-r|deepseek-v4|gpt-5|gpt-6|o1|o3|o4|glm-5|qwen3|gemini-3|gemini-4|claude-(opus|sonnet)-[5-9]|grok-4|kimi-k2|minimax|nemotron|ling-|ernie|seed-oss|step-3|magistral)/i

const LIGHT_MODEL = /(nano|mini|lite|small|flash-free|:free$|-free$|1b|1\.7b|3b|4b|7b|8b|9b|12b)/i

export function guessEfforts(id: string): EffortLevel[] {
  if (REASONING_MODEL.test(id)) return ['none', 'low', 'high', 'max']
  if (/^(gpt-4o-mini|claude-3-5-haiku|gemini-1\.5-flash|deepseek-chat)$/i.test(id)) return ['none']
  return ['none', 'low', 'high', 'max']
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  }
  return undefined
}

export function isChatModel(id: string): boolean {
  return id.length > 0 && !NON_CHAT_MODEL.test(id)
}

export function guessCaps(id: string): ModelCaps {
  return {
    tools: true,
    vision: VISION_MODEL.test(id),
    contextWindow: DEFAULT_CONTEXT
  }
}

function normalizeModelId(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  const record = asRecord(entry)
  if (!record) return undefined
  const id = record.id ?? record.name ?? record.model
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

function contextFromEntry(entry: unknown, fallback: number): number {
  const record = asRecord(entry)
  if (!record) return fallback
  const topProvider = asRecord(record.top_provider)
  const limits = asRecord(record.limits)
  return (
    firstNumber(
      record.context_length,
      record.context_window,
      record.contextWindow,
      record.max_context_length,
      record.max_context_tokens,
      record.max_input_tokens,
      limits?.context,
      topProvider?.context_length
    ) ?? fallback
  )
}

function declaredCaps(entry: unknown): Partial<ModelCaps> | undefined {
  const record = asRecord(entry)
  if (!record) return undefined
  const caps = asRecord(record.capabilities) ?? asRecord(record.features)
  if (!caps) return undefined
  const tools = caps.tools ?? caps.function_calling ?? caps.tool_calling
  const vision = caps.vision
  return {
    tools: typeof tools === 'boolean' ? tools : undefined,
    vision: typeof vision === 'boolean' ? vision : undefined
  }
}

async function requestModels(baseUrl: string, apiKey?: string): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: AbortSignal.timeout(10_000)
  })
}

export interface ProviderModelsResult {
  models: ModelEntry[]
  /** Human-readable note about models the router reported as unusable. */
  notice?: string
}

const UNAVAILABLE_REASONS: Record<string, string> = {
  no_key: 'nessuna key del provider',
  no_models: 'nessun modello abilitato',
  rate_limited: 'rate limit',
  disabled: 'provider disabilitato'
}

function describeReason(reason: unknown): string {
  if (typeof reason !== 'string') return 'motivo sconosciuto'
  return UNAVAILABLE_REASONS[reason] ?? reason.replace(/_/g, ' ')
}

export async function fetchProviderModels(
  platform: Platform,
  provider: ProviderConfig
): Promise<ProviderModelsResult> {
  const { apiKey } = await resolveApiKey(platform, provider)

  let baseUrl = getDetectedBaseUrl(provider.id) ?? provider.baseUrl
  let response: Response

  try {
    response = await requestModels(baseUrl, apiKey)
  } catch (error) {
    // A dead router is the single most common setup problem (wrong port).
    // Before failing, look for the router on the usual ports.
    if (provider.kind !== 'router') {
      throw new Error(`${provider.label}: ${describeNetworkError(error)}`)
    }

    const detected = await detectRouterBaseUrl(provider)
    if (!detected) {
      throw new Error(
        `${provider.label}: ${describeNetworkError(error)} (porte provate: ${provider.baseUrl})`
      )
    }

    rememberDetectedBaseUrl(provider.id, detected)
    baseUrl = detected
    response = await requestModels(detected, apiKey).catch((retryError: unknown) => {
      throw new Error(`${provider.label}: ${describeNetworkError(retryError)}`)
    })
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/models`

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 200)
    throw new Error(`${url} → ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`)
  }

  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    const snippet = text.replace(/<[^>]+>/g, '').trim().slice(0, 160)
    throw new Error(
      `${provider.label} ha risposto con HTML anziché JSON (${response.status})${snippet ? `: ${snippet}` : ''}. Verifica che il router sia in ascolto sulla porta corretta.`
    )
  }
  const bodyRecord = asRecord(body)
  const rawList = bodyRecord?.data ?? bodyRecord?.models ?? (Array.isArray(body) ? body : [])

  const entries = Array.isArray(rawList) ? rawList : []
  const models: ModelEntry[] = []
  const unavailable: string[] = []

  for (const raw of entries) {
    const id = normalizeModelId(raw)
    if (!id || !isChatModel(id)) continue

    const record = asRecord(raw)
    // Routers like FreeLLMAPI tell us which models are actually usable right
    // now. Showing the rest would produce 503s on the first message.
    if (record?.available === false) {
      unavailable.push(describeReason(record.unavailable_reason))
      continue
    }

    const guessed = guessCaps(id)
    const declared = declaredCaps(raw) ?? {}
    const label =
      (typeof record?.name === 'string' && record.name) ||
      (typeof record?.display_name === 'string' && record.display_name) ||
      id

    models.push({
      key: `${provider.id}::${id}`,
      providerId: provider.id,
      providerLabel: provider.label,
      id,
      label,
      caps: {
        tools: declared.tools ?? guessed.tools,
        vision: declared.vision ?? guessed.vision,
        contextWindow: contextFromEntry(raw, guessed.contextWindow)
      },
      capsConfidence: declared.tools !== undefined ? 'probed' : 'guess',
      effort: 'none',
      efforts: guessEfforts(id)
    })
  }

  let notice: string | undefined
  if (unavailable.length > 0) {
    const counts = new Map<string, number>()
    for (const reason of unavailable) counts.set(reason, (counts.get(reason) ?? 0) + 1)
    const detail = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason} (${count})`)
      .join(', ')
    notice = `${unavailable.length} modelli nascosti: ${detail}. Aggiungi le provider key nella dashboard del router.`
  }

  return { models, notice }
}

export async function loadCatalog(
  platform: Platform,
  config: CharlieCodeConfig
): Promise<CatalogResult> {
  const enabled = config.providers.filter((p) => p.enabled)
  const errors: CatalogError[] = []
  const settled = await Promise.allSettled(
    enabled.map(async (provider) => ({ provider, models: await fetchProviderModels(platform, provider) }))
  )

  const models: ModelEntry[] = []
  settled.forEach((result, index) => {
    const provider = enabled[index]
    if (!provider) return
    if (result.status === 'fulfilled') {
      const { models: providerModels, notice } = result.value.models
      if (notice) {
        errors.push({ providerId: provider.id, providerLabel: provider.label, message: notice })
      }
      models.push(...applyOverrides(providerModels, config))
    } else {
      errors.push({
        providerId: provider.id,
        providerLabel: provider.label,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason)
      })
    }
  })

  models.sort((a, b) => {
    if (a.providerId !== b.providerId) return a.providerId.localeCompare(b.providerId)
    return a.label.localeCompare(b.label)
  })

  return { models, errors }
}

export function applyOverrides(models: ModelEntry[], config: CharlieCodeConfig): ModelEntry[] {
  return models.map((model) => {
    const override = config.modelOverrides[model.key] ?? config.modelOverrides[model.id]
    if (!override) {
      return { ...model, effort: config.effort }
    }
    return {
      ...model,
      label: override.label ?? model.label,
      caps: { ...model.caps, ...override.caps },
      capsConfidence: override.caps ? 'manual' : model.capsConfidence,
      effort: override.effort ?? config.effort,
      efforts: override.efforts ?? model.efforts
    }
  })
}

export function findModel(models: ModelEntry[], keyOrId: string): ModelEntry | undefined {
  return (
    models.find((model) => model.key === keyOrId) ??
    models.find((model) => model.id === keyOrId) ??
    models.find((model) => model.key.endsWith(`::${keyOrId}`))
  )
}
