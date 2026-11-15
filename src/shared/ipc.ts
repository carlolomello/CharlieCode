import type { IncomingAttachment } from '../engine/types'
import type { Session, SessionSummary } from '../engine/session-types'
import type {
  CatalogError,
  EffortLevel,
  EngineEvent,
  ModelEntry,
  PermissionDecision,
  PermissionRequest
} from '../engine/types'

export interface AppInfo {
  version: string
  platform: string
  configDir: string
  configPath: string
  credentialsPath: string
  electron: string
  workspacePath?: string
  recentWorkspaces: string[]
  defaultModel?: string
  effort: EffortLevel
}

export interface ModelsResponse {
  models: ModelEntry[]
  errors: CatalogError[]
  defaultModel?: string
}

export interface ProviderStatus {
  id: string
  label: string
  baseUrl: string
  kind: 'router' | 'direct'
  enabled: boolean
  hasKey: boolean
  keyHint: string
  keySource: 'env' | 'credentials' | 'none'
  showAllModels: boolean
}

export interface ChatStartPayload {
  requestId: string
  /** Omit for a brand new conversation; the main process creates one. */
  sessionId?: string
  userMessageId: string
  assistantMessageId: string
  modelKey: string
  /** Only the new turn: history lives in the session on disk. */
  text: string
  effort?: EffortLevel
  system?: string
  maxOutputTokens?: number
  workspacePath?: string
  /** `plan` explores read-only; `build` can write. Defaults to build. */
  mode?: 'plan' | 'build'
  /** Images (data URL) and documents (raw text) attached to this turn. */
  attachments?: IncomingAttachment[]
}

export interface AddProviderPayload {
  id: string
  label: string
  baseUrl: string
  kind: 'router' | 'direct'
}

/** A local runtime CharlieCode can detect, launch and talk to. */
export interface LocalRuntime {
  id: 'freellmapi' | 'ollama'
  label: string
  running: boolean
  installed: boolean
  /** Base URL to use when it is running, e.g. http://localhost:31415/v1 */
  baseUrl: string
  hint: string
}

export interface DetectedLocal {
  id: string
  label: string
  baseUrl: string
  models?: number
  needsKey: boolean
  docs?: string
  startCommand?: string
  container?: string
}

export interface RoutersStatus {
  freellmapi: LocalRuntime
  ollama: LocalRuntime
  /** Every local OpenAI-compatible endpoint that answered right now. */
  detected: DetectedLocal[]
  docker: boolean
}

export interface ChatStartResult {
  ok: boolean
  error?: string
  sessionId?: string
}

export interface ChatEventEnvelope {
  requestId: string
  event: EngineEvent
}

export interface ChatSessionEnvelope {
  requestId: string
  sessionId: string
  title: string
  updatedAt: string
}

export interface PermissionEnvelope {
  requestId: string
  request: PermissionRequest
}

export interface CharlieCodeApi {
  info(): Promise<AppInfo>
  models(): Promise<ModelsResponse>

  pickWorkspace(): Promise<{ path?: string }>
  useWorkspace(path: string): Promise<{ path?: string }>
  openWorkspace(): Promise<void>

  providers(): Promise<ProviderStatus[]>
  setProviderKey(providerId: string, apiKey: string): Promise<ProviderStatus[]>
  toggleProvider(providerId: string, enabled: boolean): Promise<ProviderStatus[]>
  setProviderShowAllModels(providerId: string, showAll: boolean): Promise<ProviderStatus[]>
  addProvider(payload: AddProviderPayload): Promise<ProviderStatus[]>
  openGlobalAgents(): Promise<void>

  routers(): Promise<RoutersStatus>
  launchRuntime(id: 'freellmapi' | 'ollama'): Promise<boolean>
  openExternal(url: string): Promise<void>

  listSessions(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<Session | null>
  deleteSession(id: string): Promise<boolean>
  renameSession(id: string, title: string): Promise<Session | null>

  startChat(payload: ChatStartPayload): Promise<ChatStartResult>
  stopChat(requestId: string): Promise<void>
  onChatEvent(callback: (envelope: ChatEventEnvelope) => void): () => void
  onChatSession(callback: (envelope: ChatSessionEnvelope) => void): () => void
  onPermission(callback: (envelope: PermissionEnvelope) => void): () => void
  respondPermission(permissionId: string, decision: PermissionDecision): Promise<void>

  openConfigDir(): Promise<void>
  autoApprove(): Promise<{ tools: string[]; commands: string[] }>
  setAutoApprove(payload: { tool?: string; command?: string; remove?: boolean }): Promise<{
    tools: string[]
    commands: string[]
  }>
}
