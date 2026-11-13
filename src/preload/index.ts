import { contextBridge, ipcRenderer } from 'electron'
import type { AppInfo, ChatEventEnvelope, ChatStartPayload, CharlieCodeApi, ModelsResponse } from '../shared/ipc'

const api: CharlieCodeApi = {
  info: () => ipcRenderer.invoke('charliecode:info') as Promise<AppInfo>,
  models: () => ipcRenderer.invoke('charliecode:models') as Promise<ModelsResponse>,
  startChat: (payload: ChatStartPayload) =>
    ipcRenderer.invoke('charliecode:chat:start', payload) as Promise<{ ok: boolean; error?: string }>,
  stopChat: (requestId: string) => ipcRenderer.invoke('charliecode:chat:stop', requestId) as Promise<void>,
  openConfigDir: () => ipcRenderer.invoke('charliecode:open-config') as Promise<void>,
  onChatEvent: (callback: (envelope: ChatEventEnvelope) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: ChatEventEnvelope): void => {
      callback(envelope)
    }
    ipcRenderer.on('charliecode:chat:event', listener)
    return () => {
      ipcRenderer.removeListener('charliecode:chat:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('charliecode', api)
