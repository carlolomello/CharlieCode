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
  /** Where to get a key. Shown in the drawer next to the field. */
  docs?: string
  /** Ships with a free tier: worth offering to someone with no budget. */
  free?: boolean
}

export interface ModelCaps {
  tools: boolean
  vision: boolean
  contextWindow: number
}

/**
 * What the context badge shows: how many tokens the next turn sends, how big
 * the stored conversation is, and the soft limit of the current model.
 */
export interface ContextStats {
  /** Tokens the next turn will actually send to the model. */
  tokens: number
  /** Tokens of the full stored context, before compaction. */
  totalTokens: number
  /** Soft limit for this model. */
  budget: number
  messages: number
  droppedMessages: number
  /** The stored context does not fit and is compacted on read. */
  compacted: boolean
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
  /**
   * Subagents that may run at once. The rest wait in a queue, and two of them
   * never work on the same file at the same time. Default 3.
   */
  maxParallelSubagents?: number
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
  /** Built-in plugin switches; a missing entry means "shipped default". */
  plugins?: Record<string, { enabled: boolean }>
  /**
   * A CLI the user already has, used to run `task` subagents. When set, the
   * model calls stay inside that CLI: CharlieCode never sees its keys, quota
   * or logs.
   */
  external?: ExternalWorkerConfig
}

export interface ExternalWorkerConfig {
  /** Id of a profile in `<config>/clis/<id>.json`. */
  id: string
  /** Model passed to the CLI; empty means the CLI's own default. */
  model?: string
  /**
   * Let the CLI write and run commands without asking. Off by default: an
   * orchestrator that silently turns off another tool's approvals is a bad
   * surprise.
   */
  auto?: boolean
}

/**
 * How a CLI prints a turn.
 *
 * - `text`: every stdout line is answer text;
 * - `json-lines`: one JSON object per line, text extracted from common shapes;
 * - `run-result`: JSON progress lines plus one final `run_result`/`result` line;
 * - `stream-json`: assistant messages and tool_use events, streamed;
 * - `auto`: try all of the above, per line.
 */
export type CliOutputFormat = 'auto' | 'text' | 'json-lines' | 'run-result' | 'stream-json'

/**
 * A user-defined CLI integration, stored as JSON in `<config>/clis/<id>.json`.
 *
 * There are no product presets on purpose: a corporate CLI is just a command
 * with arguments, and hardcoding names would leak products the app should not
 * know about. `args` is an argv array, never a shell string; placeholders are
 * `{prompt}`, `{workspace}`, `{model}` and `{effort}`.
 */
export interface CliProfile {
  /** Slug, also the file name. */
  id: string
  label: string
  /** Executable: a name resolved through PATH or an absolute path. */
  command: string
  /** Fixed argv, with optional placeholders. */
  args: string[]
  /** Prompt as the last argument (default) or on stdin. */
  promptMode?: 'arg' | 'stdin'
  /** Output shape; defaults to `auto`. */
  output?: CliOutputFormat
  /**
   * Extra argv that asks the CLI for the `output` shape (`--format json`).
   * Without it a CLI prints for humans and the transcript can only show prose:
   * no tool rows, no commands, no files.
   */
  outputArgs?: string[]
  /** Extra argv when a model is selected. */
  modelArgs?: string[]
  /** Extra argv when an effort level is selected; `{effort}` is replaced. */
  effortArgs?: string[]
  /** Effort values the CLI accepts, lowest to highest. Empty means the level name. */
  effortValues?: string[]
  /** Extra argv for read-only exploration. */
  planArgs?: string[]
  /** Extra argv that lets the CLI write without asking. */
  autoArgs?: string[]
  /**
   * Extra argv that continues the CLI's own previous session in this workspace
   * (`--continue`). When set, the next turn sends only the new request instead
   * of the whole conversation, which is the largest token saving on a long
   * chat. A CLI that lost its session is retried with the full briefing.
   */
  continueArgs?: string[]
  /**
   * CLI processes a team turn may run at once. Only disjoint file scopes are
   * parallelised; default 3.
   */
  maxWorkers?: number
  /** Command that prints the models this CLI can use. */
  modelsArgs?: string[]
  /** How to read `modelsArgs` output. */
  modelsFormat?: 'lines' | 'json'
  /** Advanced: dot path of the text inside a JSON line. */
  textPath?: string
  /** Advanced: dot path of a tool/activity name inside a JSON line. */
  activityPath?: string
  /** Advanced: dot path of the reasoning/thinking text inside a JSON line. */
  thinkingPath?: string
  /** Advanced: dot path of the model array inside JSON output. */
  modelsPath?: string
  /**
   * The models the CLI printed last time, with the argv that produced them.
   * A models command can take half a minute; the picker reuses the answer for
   * a few minutes instead of spawning the CLI on every selection.
   */
  modelsCache?: { args: string[]; at: string; models: string[] }
  /** Shown in the panel. */
  notes?: string
  /** One run timeout, in seconds. */
  timeoutSeconds?: number
}

/** One useful flag found in a CLI's own help. */
export interface CliFinding {
  field: 'args' | 'model' | 'effort' | 'plan' | 'auto' | 'output' | 'models' | 'prompt' | 'continue'
  /** Short Italian label shown in the panel. */
  label: string
  /** The flag(s) that produced the proposal. */
  evidence: string
}

/** What `--help` revealed about a CLI, and the profile it suggests. */
export interface CliIntrospection {
  command: string
  /** Resolved executable, when the name exists on this machine. */
  path?: string
  /** First line of `--version`, when the CLI answered quickly. */
  version?: string
  /** False when the binary did not print any help. */
  helpRead: boolean
  /** First few thousand characters of help, for the panel. */
  helpExcerpt?: string
  proposal: Partial<CliProfile>
  findings: CliFinding[]
  warnings: string[]
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
  /**
   * Ask for a team turn: the agent must split the work across `task` subagents
   * instead of doing everything itself. The UI shows the workshop while they run.
   */
  team?: boolean
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
  /**
   * Subagent that asked, when it is not the main agent. With several workers
   * running, "Scrivere app.tsx" alone does not say whose write it is.
   */
  agentName?: string
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
  /**
   * Reasoning a CLI streamed before its answer. Shown while the turn runs and
   * never stored: it is the model's monologue, not part of the conversation.
   */
  | { type: 'thinking'; text: string; agentId?: string }
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
      /** Tokens the worker spent, when its backend reports them. */
      usage?: TokenUsage
      /** Steps of its own loop, when its backend reports them. */
      steps?: number
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
