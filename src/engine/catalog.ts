import { resolveApiKey } from './config'
import { describeNetworkError } from './errors'
import type { Platform } from './platform'
import type {
  CatalogError,
  CatalogResult,
  CharlieConfig,
  ModelCaps,
  ModelEntry,
  ProviderConfig
} from './types'

const NON_CHAT_MODEL =
  /(embed|embedding|whisper|tts|speech|transcri|image|imagen|flux|sdxl|dall-e|stable-diffusion|rerank|moderation|audio|video|guard|safety)/i

const VISION_MODEL =
  /(vision|llava|pixtral|gemini|gpt-4o|gpt-4\.1|gpt-5|claude|qwen[\w.-]*vl|internvl|molmo|phi[\w.-]*vision|llama[\w.-]*vision)/i

const DEFAULT_CONTEXT = 32_768

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

export async function fetchProviderModels(
  platform: Platform,
  provider: ProviderConfig
): Promise<ModelEntry[]> {
  const { apiKey } = await resolveApiKey(platform, provider)
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`

  const response = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: AbortSignal.timeout(10_000)
  }).catch((error: unknown) => {
    throw new Error(`${provider.label}: ${describeNetworkError(error)}`)
  })

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 200)
    throw new Error(`${url} → ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`)
  }

  const body: unknown = await response.json()
  const bodyRecord = asRecord(body)
  const rawList = bodyRecord?.data ?? bodyRecord?.models ?? (Array.isArray(body) ? body : [])

  const entries = Array.isArray(rawList) ? rawList : []
  const models: ModelEntry[] = []

  for (const raw of entries) {
    const id = normalizeModelId(raw)
    if (!id || !isChatModel(id)) continue

    const guessed = guessCaps(id)
    const declared = declaredCaps(raw) ?? {}
    const record = asRecord(raw)
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
      effort: 'none'
    })
  }

  return models
}

export async function loadCatalog(
  platform: Platform,
  config: CharlieConfig
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
      models.push(...applyOverrides(result.value.models, config))
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

export function applyOverrides(models: ModelEntry[], config: CharlieConfig): ModelEntry[] {
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
      effort: override.effort ?? config.effort
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
