import { contextBridge, ipcRenderer } from 'electron'
import type {
  AddProviderPayload,
  AppInfo,
  CharlieCodeApi,
  ChatEventEnvelope,
  ChatSessionEnvelope,
  ChatStartPayload,
  ChatStartResult,
  CliPreview,
  CliPreviewPayload,
  CliProfilesStatus,
  CliTestResult,
  ModelsResponse,
  OnboardingAnswers,
  OnboardingApplyPayload,
  OnboardingFacts,
  OnboardingPlan,
  OnboardingResult,
  PermissionEnvelope,
  PluginStatus,
  ProviderStatus,
  RoutersStatus,
  SkillInfo,
  WorkspaceChange,
  WorkspaceChanges
} from '../shared/ipc'
import type { Session, SessionSummary } from '../engine/sessions'
import type { ContextStats, ExternalWorkerConfig, FileDiff, PermissionDecision } from '../engine/types'

const api: CharlieCodeApi = {
  info: () => ipcRenderer.invoke('charliecode:info') as Promise<AppInfo>,
  models: () => ipcRenderer.invoke('charliecode:models') as Promise<ModelsResponse>,

  pickWorkspace: () => ipcRenderer.invoke('charliecode:workspace:pick') as Promise<{ path?: string }>,
  useWorkspace: (path: string) =>
    ipcRenderer.invoke('charliecode:workspace:use', path) as Promise<{ path?: string }>,
  openWorkspace: () => ipcRenderer.invoke('charliecode:workspace:open') as Promise<void>,

  providers: () => ipcRenderer.invoke('charliecode:providers:list') as Promise<ProviderStatus[]>,
  setProviderKey: (providerId: string, apiKey: string) =>
    ipcRenderer.invoke('charliecode:providers:set-key', providerId, apiKey) as Promise<
      ProviderStatus[]
    >,
  toggleProvider: (providerId: string, enabled: boolean) =>
    ipcRenderer.invoke('charliecode:providers:toggle', providerId, enabled) as Promise<
      ProviderStatus[]
    >,
  setProviderShowAllModels: (providerId: string, showAll: boolean) =>
    ipcRenderer.invoke('charliecode:providers:show-all-models', providerId, showAll) as Promise<
      ProviderStatus[]
    >,
  addProvider: (payload: AddProviderPayload) =>
    ipcRenderer.invoke('charliecode:providers:add', payload) as Promise<ProviderStatus[]>,
  openGlobalAgents: () =>
    ipcRenderer.invoke('charliecode:agents:open-global') as Promise<void>,

  routers: () => ipcRenderer.invoke('charliecode:routers:status') as Promise<RoutersStatus>,
  launchRuntime: (id: 'freellmapi' | 'ollama') =>
    ipcRenderer.invoke('charliecode:routers:launch', id) as Promise<boolean>,
  openExternal: (url: string) =>
    ipcRenderer.invoke('charliecode:open-external', url) as Promise<void>,

  listSessions: () => ipcRenderer.invoke('charliecode:sessions:list') as Promise<SessionSummary[]>,
  loadSession: (id: string) =>
    ipcRenderer.invoke('charliecode:sessions:load', id) as Promise<Session | null>,
  deleteSession: (id: string) =>
    ipcRenderer.invoke('charliecode:sessions:delete', id) as Promise<boolean>,
  renameSession: (id: string, title: string) =>
    ipcRenderer.invoke('charliecode:sessions:rename', id, title) as Promise<Session | null>,
  contextStats: (sessionId: string, modelKey?: string) =>
    ipcRenderer.invoke('charliecode:context:stats', sessionId, modelKey) as Promise<ContextStats>,
  compactContext: (sessionId: string, modelKey?: string) =>
    ipcRenderer.invoke('charliecode:context:compact', sessionId, modelKey) as Promise<ContextStats>,

  startChat: (payload: ChatStartPayload) =>
    ipcRenderer.invoke('charliecode:chat:start', payload) as Promise<ChatStartResult>,
  stopChat: (requestId: string) =>
    ipcRenderer.invoke('charliecode:chat:stop', requestId) as Promise<void>,

  onChatEvent: (callback: (envelope: ChatEventEnvelope) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: ChatEventEnvelope): void => {
      callback(envelope)
    }
    ipcRenderer.on('charliecode:chat:event', listener)
    return () => {
      ipcRenderer.removeListener('charliecode:chat:event', listener)
    }
  },

  onChatSession: (callback: (envelope: ChatSessionEnvelope) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: ChatSessionEnvelope): void => {
      callback(envelope)
    }
    ipcRenderer.on('charliecode:chat:session', listener)
    return () => {
      ipcRenderer.removeListener('charliecode:chat:session', listener)
    }
  },

  onPermission: (callback: (envelope: PermissionEnvelope) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: PermissionEnvelope): void => {
      callback(envelope)
    }
    ipcRenderer.on('charliecode:chat:permission', listener)
    return () => {
      ipcRenderer.removeListener('charliecode:chat:permission', listener)
    }
  },

  respondPermission: (permissionId: string, decision: PermissionDecision) =>
    ipcRenderer.invoke('charliecode:chat:permission-response', permissionId, decision) as Promise<void>,

  openConfigDir: () => ipcRenderer.invoke('charliecode:open-config') as Promise<void>,

  autoApprove: () =>
    ipcRenderer.invoke('charliecode:agents:auto-approve') as Promise<{
      tools: string[]
      commands: string[]
    }>,
  setAutoApprove: (payload: { tool?: string; command?: string; remove?: boolean }) =>
    ipcRenderer.invoke('charliecode:agents:auto-approve:set', payload) as Promise<{
      tools: string[]
      commands: string[]
    }>,

  plugins: () => ipcRenderer.invoke('charliecode:plugins:list') as Promise<PluginStatus[]>,
  setPluginEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('charliecode:plugins:set', id, enabled) as Promise<PluginStatus[]>,
  suggestSetup: () => ipcRenderer.invoke('charliecode:plugins:suggest-setup') as Promise<string>,
  openProjectMemory: () =>
    ipcRenderer.invoke('charliecode:plugins:open-memory') as Promise<string | null>,

  onboardingFacts: (workspace: string) =>
    ipcRenderer.invoke('charliecode:onboarding:facts', workspace) as Promise<OnboardingFacts>,
  onboardingPreview: (payload: { workspace: string; answers: OnboardingAnswers }) =>
    ipcRenderer.invoke('charliecode:onboarding:preview', payload) as Promise<OnboardingPlan>,
  onboardingApply: (payload: { workspace: string; apply: OnboardingApplyPayload }) =>
    ipcRenderer.invoke('charliecode:onboarding:apply', payload) as Promise<OnboardingResult>,
  onboardingSkip: (workspace: string) =>
    ipcRenderer.invoke('charliecode:onboarding:skip', workspace) as Promise<void>,

  changes: (workspace: string) =>
    ipcRenderer.invoke('charliecode:changes:list', workspace) as Promise<WorkspaceChanges>,
  changeDiff: (payload: { workspace: string; path: string }) =>
    ipcRenderer.invoke('charliecode:changes:diff', payload) as Promise<FileDiff>,
  revertChange: (payload: { workspace: string; change: WorkspaceChange }) =>
    ipcRenderer.invoke('charliecode:changes:revert', payload) as Promise<WorkspaceChanges>,
  openFile: (payload: { workspace: string; path: string }) =>
    ipcRenderer.invoke('charliecode:file:open', payload) as Promise<void>,

  skills: () => ipcRenderer.invoke('charliecode:skills:list') as Promise<SkillInfo[]>,
  installSkill: (payload: { url: string; target: 'global' | 'project' }) =>
    ipcRenderer.invoke('charliecode:skills:install', payload) as Promise<SkillInfo[]>,
  removeSkill: (payload: { dir: string; source: 'global' | 'project' }) =>
    ipcRenderer.invoke('charliecode:skills:remove', payload) as Promise<SkillInfo[]>,
  openSkillsDir: (target: 'global' | 'project') =>
    ipcRenderer.invoke('charliecode:skills:open-dir', target) as Promise<void>,

  cliProfiles: () => ipcRenderer.invoke('charliecode:clis:list') as Promise<CliProfilesStatus>,
  saveCliProfile: (profile: unknown) =>
    ipcRenderer.invoke('charliecode:clis:save', profile) as Promise<CliProfilesStatus>,
  deleteCliProfile: (id: string) =>
    ipcRenderer.invoke('charliecode:clis:delete', id) as Promise<CliProfilesStatus>,
  previewCliProfile: (payload: CliPreviewPayload) =>
    ipcRenderer.invoke('charliecode:clis:preview', payload) as Promise<CliPreview>,
  testCliProfile: (payload: { id: string; model?: string }) =>
    ipcRenderer.invoke('charliecode:clis:test', payload) as Promise<CliTestResult>,
  cliProfileModels: (id: string) =>
    ipcRenderer.invoke('charliecode:clis:models', id) as Promise<string[]>,
  setCliWorker: (worker: ExternalWorkerConfig | null) =>
    ipcRenderer.invoke('charliecode:clis:set-worker', worker) as Promise<CliProfilesStatus>
}

contextBridge.exposeInMainWorld('charliecode', api)
