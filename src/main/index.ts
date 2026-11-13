import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { loadCatalog } from '../engine/catalog'
import { streamChat } from '../engine/client'
import { CONFIG_FILE, CREDENTIALS_FILE, loadConfig } from '../engine/config'
import { createPlatform } from '../engine/platform'
import type { AppInfo, ChatStartPayload, ModelsResponse } from '../shared/ipc'

const platform = createPlatform()
const inFlight = new Map<string, AbortController>()

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e1116',
    title: 'CharlieCode',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('did-finish-load', () => {
    console.log('[charliecode] renderer loaded')
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[charliecode] renderer crashed:', details.reason)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function registerIpc(): void {
  ipcMain.handle('charliecode:info', (): AppInfo => {
    console.log('[charliecode] renderer connected')
    const { path } = { path: platform.configPath(CONFIG_FILE) }
    return {
      version: app.getVersion(),
      platform: platform.id,
      configDir: platform.configDir,
      configPath: path,
      credentialsPath: platform.configPath(CREDENTIALS_FILE),
      electron: process.versions.electron
    }
  })

  ipcMain.handle('charliecode:models', async (): Promise<ModelsResponse> => {
    const { config } = await loadConfig(platform)
    const { models, errors } = await loadCatalog(platform, config)
    return { models, errors }
  })

  ipcMain.handle(
    'charliecode:chat:start',
    async (event, payload: ChatStartPayload): Promise<{ ok: boolean; error?: string }> => {
      if (inFlight.has(payload.requestId)) {
        return { ok: false, error: 'Richiesta già in corso' }
      }

      const controller = new AbortController()
      inFlight.set(payload.requestId, controller)
      const sender = event.sender

      // Run detached: the IPC call returns immediately and events flow on the
      // dedicated channel, so the renderer stays responsive while streaming.
      void (async () => {
        try {
          const { config } = await loadConfig(platform)
          const { models } = await loadCatalog(platform, config)

          const stream = streamChat(
            {
              modelKey: payload.modelKey,
              messages: payload.messages,
              system: payload.system,
              effort: payload.effort,
              maxOutputTokens: payload.maxOutputTokens,
              signal: controller.signal
            },
            { platform, config, models }
          )

          for await (const engineEvent of stream) {
            if (sender.isDestroyed()) break
            sender.send('charliecode:chat:event', { requestId: payload.requestId, event: engineEvent })
          }
        } catch (error) {
          if (!sender.isDestroyed()) {
            sender.send('charliecode:chat:event', {
              requestId: payload.requestId,
              event: {
                type: 'error',
                message: error instanceof Error ? error.message : String(error)
              }
            })
          }
        } finally {
          inFlight.delete(payload.requestId)
          if (!sender.isDestroyed()) {
            sender.send('charliecode:chat:end', { requestId: payload.requestId })
          }
        }
      })()

      return { ok: true }
    }
  )

  ipcMain.handle('charliecode:chat:stop', (_event, requestId: string): void => {
    inFlight.get(requestId)?.abort()
    inFlight.delete(requestId)
  })

  ipcMain.handle('charliecode:open-config', async (): Promise<void> => {
    await shell.openPath(platform.configDir)
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
