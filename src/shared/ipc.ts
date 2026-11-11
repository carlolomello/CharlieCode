import type {
  CatalogError,
  ChatMessage,
  EffortLevel,
  EngineEvent,
  ModelEntry
} from '../engine/types'

export interface AppInfo {
  version: string
  platform: string
  configDir: string
  configPath: string
  credentialsPath: string
  electron: string
}

export interface ModelsResponse {
  models: ModelEntry[]
  errors: CatalogError[]
}

export interface ChatStartPayload {
  requestId: string
  modelKey: string
  messages: ChatMessage[]
  effort?: EffortLevel
  system?: string
  maxOutputTokens?: number
}

export interface ChatEventEnvelope {
  requestId: string
  event: EngineEvent
}

export interface CharlieApi {
  info(): Promise<AppInfo>
  models(): Promise<ModelsResponse>
  startChat(payload: ChatStartPayload): Promise<{ ok: boolean; error?: string }>
  stopChat(requestId: string): Promise<void>
  onChatEvent(callback: (envelope: ChatEventEnvelope) => void): () => void
  openConfigDir(): Promise<void>
}
