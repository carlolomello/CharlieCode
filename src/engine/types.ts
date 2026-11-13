/**
 * Shared engine types.
 *
 * IMPORTANT: this module must never import `electron`. The engine is designed to
 * run headless (CLI, tests, CI on Windows/macOS) and to be handed to a
 * utilityProcess later without changes.
 */

export type EffortLevel = 'none' | 'low' | 'high' | 'max'

export type ProviderKind = 'router' | 'direct'

export interface ProviderConfig {
  /** Stable id, also used as the provider name for `providerOptions`. */
  id: string
  label: string
  /** OpenAI-compatible base URL, e.g. http://localhost:3001/v1 */
  baseUrl: string
  kind: ProviderKind
  enabled: boolean
  /** Env var checked before the credentials file. */
  apiKeyEnv?: string
}

export interface ModelCaps {
  tools: boolean
  vision: boolean
  contextWindow: number
}

export type CapsConfidence = 'guess' | 'probed' | 'manual'

export interface ModelOverride {
  label?: string
  effort?: EffortLevel
  caps?: Partial<ModelCaps>
}

export interface CharlieCodeConfig {
  version: 1
  providers: ProviderConfig[]
  /** Keyed by `providerId::modelId` (or bare `modelId`). */
  modelOverrides: Record<string, ModelOverride>
  defaultModel?: string
  /** Ordered candidates used when the requested model fails. */
  fallbackModels: string[]
  effort: EffortLevel
  /** Project directory currently open in the app. */
  workspace?: string
  /** Most recently opened project directories, newest first. */
  recentWorkspaces: string[]
}

export interface ModelEntry {
  /** `providerId::modelId` — unique across providers. */
  key: string
  providerId: string
  providerLabel: string
  id: string
  label: string
  caps: ModelCaps
  capsConfidence: CapsConfidence
  effort: EffortLevel
}

export interface CatalogError {
  providerId: string
  providerLabel: string
  message: string
}

export interface CatalogResult {
  models: ModelEntry[]
  errors: CatalogError[]
}

export interface AttachmentRef {
  id: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'text'
  /** Path on disk, relative to the config dir, so sessions stay portable. */
  path?: string
}

export interface IncomingAttachment {
  name: string
  mime: string
  kind: 'image' | 'text'
  size: number
  /** data URL for images, raw text for documents. */
  data: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** Images already encoded as base64 (no data: prefix). */
  images?: { mediaType: string; data: string }[]
  /** Attachments that produced `content`/`images`; metadata only. */
  attachments?: AttachmentRef[]
}

export interface StreamRequest {
  modelKey: string
  messages: ChatMessage[]
  system?: string
  effort?: EffortLevel
  maxOutputTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type EngineEvent =
  | { type: 'start'; modelKey: string; label: string; fallbackFrom?: string }
  | { type: 'delta'; text: string }
  | {
      type: 'done'
      modelKey: string
      ms: number
      ttftMs: number
      usage?: TokenUsage
      aborted?: boolean
    }
  | { type: 'error'; message: string; modelKey?: string }

export interface ProbeResult {
  modelKey: string
  label: string
  providerId: string
  modelId: string
  ok: boolean
  tools: boolean | null
  latencyMs: number | null
  ttftMs: number | null
  error?: string
  probedAt: string
}
