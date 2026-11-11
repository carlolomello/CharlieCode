import { contextBridge, ipcRenderer } from 'electron'
import type { AppInfo, ChatEventEnvelope, ChatStartPayload, CharlieApi, ModelsResponse } from '../shared/ipc'

const api: CharlieApi = {
  info: () => ipcRenderer.invoke('charlie:info') as Promise<AppInfo>,
  models: () => ipcRenderer.invoke('charlie:models') as Promise<ModelsResponse>,
  startChat: (payload: ChatStartPayload) =>
    ipcRenderer.invoke('charlie:chat:start', payload) as Promise<{ ok: boolean; error?: string }>,
  stopChat: (requestId: string) => ipcRenderer.invoke('charlie:chat:stop', requestId) as Promise<void>,
  openConfigDir: () => ipcRenderer.invoke('charlie:open-config') as Promise<void>,
  onChatEvent: (callback: (envelope: ChatEventEnvelope) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: ChatEventEnvelope): void => {
      callback(envelope)
    }
    ipcRenderer.on('charlie:chat:event', listener)
    return () => {
      ipcRenderer.removeListener('charlie:chat:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('charlie', api)
