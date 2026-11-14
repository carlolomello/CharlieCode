import { contextBridge, ipcRenderer } from 'electron'
import type {
  AddProviderPayload,
  AppInfo,
  CharlieCodeApi,
  ChatEventEnvelope,
  ChatSessionEnvelope,
  ChatStartPayload,
  ChatStartResult,
  ModelsResponse,
  PermissionEnvelope,
  ProviderStatus,
  RoutersStatus
} from '../shared/ipc'
import type { Session, SessionSummary } from '../engine/sessions'
import type { PermissionDecision } from '../engine/types'

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

  openConfigDir: () => ipcRenderer.invoke('charliecode:open-config') as Promise<void>
}

contextBridge.exposeInMainWorld('charliecode', api)
