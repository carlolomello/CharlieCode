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
  /**
   * Router providers expose dozens of models. By default the picker shows one
   * "automatico" entry; set this to list them all.
   */
  showAllModels?: boolean
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
  /** Levels the picker may offer; defaults to what the model supports. */
  efforts?: EffortLevel[]
  caps?: Partial<ModelCaps>
}

export interface AgentSettings {
  /** Tool-calling steps the main agent may take in a single turn. */
  maxSteps: number
  /** Model used by subagents; defaults to the current model. */
  subagentModel?: string
  subagentMaxSteps: number
  /** Tools auto-approved without asking (read-only ones by default). */
  autoApprove: string[]
  /** Bash prefixes auto-approved, e.g. "git status". */
  autoApproveCommands: string[]
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
  /** Tool loop + multi-agent settings. */
  agents: AgentSettings
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
  /** Levels the picker offers for this model. */
  efforts: EffortLevel[]
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
  /**
   * `plan` explores and proposes without touching the project; `build` lets the
   * agent write. Defaults to `build`.
   */
  mode?: AgentMode
}

/** Plan mode is read-only; build mode can modify the project. */
export type AgentMode = 'plan' | 'build'

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/** A change a tool wants to make, rendered by the UI and the permission prompt. */
export interface FileDiff {
  path: string
  /** Path relative to the workspace when possible. */
  displayPath: string
  added: number
  removed: number
  created?: boolean
  deleted?: boolean
  unified: string
}

export interface PermissionRequest {
  id: string
  tool: string
  title: string
  detail: string
  risk: 'low' | 'medium' | 'high'
  diff?: FileDiff
  /** Command shown verbatim to the user (bash). */
  command?: string
}

export type PermissionDecision = 'allow' | 'allow-always' | 'deny'

export interface ToolLog {
  id: string
  name: string
  title: string
  input?: unknown
  status: 'running' | 'ok' | 'error' | 'denied'
  summary?: string
  output?: string
  diff?: FileDiff
  ms?: number
  agentId?: string
  agentName?: string
}

export type EngineEvent =
  | { type: 'start'; modelKey: string; label: string; fallbackFrom?: string }
  | { type: 'delta'; text: string; agentId?: string }
  | { type: 'step'; index: number; agentId?: string }
  | {
      type: 'tool-call'
      id: string
      name: string
      title: string
      input?: unknown
      agentId?: string
      agentName?: string
    }
  | {
      type: 'tool-result'
      id: string
      name: string
      ok: boolean
      denied?: boolean
      summary: string
      output?: string
      diff?: FileDiff
      ms: number
      agentId?: string
      agentName?: string
    }
  | {
      type: 'subagent-start'
      agentId: string
      name: string
      description: string
      modelKey: string
    }
  | {
      type: 'subagent-end'
      agentId: string
      name: string
      ok: boolean
      summary: string
      ms: number
    }
  | {
      type: 'done'
      modelKey: string
      ms: number
      ttftMs: number
      usage?: TokenUsage
      aborted?: boolean
      steps?: number
      toolCalls?: number
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
