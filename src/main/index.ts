import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { globalAgentsPath, loadProjectContext } from '../engine/agents'
import { materializeHistory, saveAttachments } from '../engine/attachments'
import { loadCatalog } from '../engine/catalog'
import { resetProviderCache, streamChat } from '../engine/client'
import {
  CONFIG_FILE,
  CREDENTIALS_FILE,
  deleteCredential,
  loadConfig,
  maskKey,
  resolveApiKey,
  saveConfig,
  writeCredentials
} from '../engine/config'
import { createPlatform } from '../engine/platform'
import {
  appendMessage,
  createSession,
  deleteSession,
  listSessions,
  readSession,
  toChatHistory,
  updateSession,
  type SessionSummary
} from '../engine/sessions'
import type { CharlieCodeConfig } from '../engine/types'
import type {
  AddProviderPayload,
  AppInfo,
  ChatStartPayload,
  ModelsResponse,
  ProviderStatus
} from '../shared/ipc'

const platform = createPlatform()
const inFlight = new Map<string, AbortController>()

const BASE_SYSTEM_PROMPT = `Sei CharlieCode, un assistente di programmazione che lavora dentro il progetto dell'utente.

Regole:
- Rispondi nella lingua dell'utente.
- Quando citi file o comandi usa path relativi al progetto.
- Se non sai qualcosa, dillo invece di inventare.
- Non proporre modifiche distruttive senza avvisare.
- Il contesto del progetto è limitato a ciò che l'utente ha aperto: non assumere di poter leggere file che non ti sono stati mostrati.`

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 620,
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

async function providerStatuses(config: CharlieCodeConfig): Promise<ProviderStatus[]> {
  const statuses: ProviderStatus[] = []
  for (const provider of config.providers) {
    const key = await resolveApiKey(platform, provider)
    statuses.push({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      kind: provider.kind,
      enabled: provider.enabled,
      hasKey: Boolean(key.apiKey),
      keyHint: key.apiKey ? maskKey(key.apiKey) : key.hint,
      keySource: key.source
    })
  }
  return statuses
}

function rememberWorkspace(config: CharlieCodeConfig, workspace: string): CharlieCodeConfig {
  const recent = [workspace, ...config.recentWorkspaces.filter((entry) => entry !== workspace)]
  return { ...config, workspace, recentWorkspaces: recent.slice(0, 8) }
}

function registerIpc(): void {
  ipcMain.handle('charliecode:info', async (): Promise<AppInfo> => {
    console.log('[charliecode] renderer connected')
    const { config } = await loadConfig(platform)
    return {
      version: app.getVersion(),
      platform: platform.id,
      configDir: platform.configDir,
      configPath: platform.configPath(CONFIG_FILE),
      credentialsPath: platform.configPath(CREDENTIALS_FILE),
      electron: process.versions.electron,
      workspacePath: config.workspace,
      recentWorkspaces: config.recentWorkspaces,
      defaultModel: config.defaultModel,
      effort: config.effort
    }
  })

  ipcMain.handle('charliecode:models', async (): Promise<ModelsResponse> => {
    const { config } = await loadConfig(platform)
    const { models, errors } = await loadCatalog(platform, config)
    return { models, errors, defaultModel: config.defaultModel }
  })

  ipcMain.handle('charliecode:workspace:pick', async (event): Promise<{ path?: string }> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Scegli il progetto',
      buttonLabel: 'Apri progetto',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const picked = result.filePaths[0]
    if (result.canceled || !picked) return {}

    const { config } = await loadConfig(platform)
    await saveConfig(platform, rememberWorkspace(config, picked))
    return { path: picked }
  })

  ipcMain.handle('charliecode:workspace:use', async (_event, path: string): Promise<{ path?: string }> => {
    if (!path) return {}
    const { config } = await loadConfig(platform)
    await saveConfig(platform, rememberWorkspace(config, path))
    return { path }
  })

  ipcMain.handle('charliecode:workspace:open', async (): Promise<void> => {
    const { config } = await loadConfig(platform)
    if (config.workspace) await shell.openPath(config.workspace)
  })

  ipcMain.handle('charliecode:providers:list', async (): Promise<ProviderStatus[]> => {
    const { config } = await loadConfig(platform)
    return providerStatuses(config)
  })

  ipcMain.handle(
    'charliecode:providers:set-key',
    async (_event, providerId: string, apiKey: string): Promise<ProviderStatus[]> => {
      const trimmed = apiKey.trim()
      if (trimmed) await writeCredentials(platform, providerId, trimmed)
      else await deleteCredential(platform, providerId)
      resetProviderCache()
      const { config } = await loadConfig(platform)
      return providerStatuses(config)
    }
  )

  ipcMain.handle(
    'charliecode:providers:toggle',
    async (_event, providerId: string, enabled: boolean): Promise<ProviderStatus[]> => {
      const { config } = await loadConfig(platform)
      const next: CharlieCodeConfig = {
        ...config,
        providers: config.providers.map((provider) =>
          provider.id === providerId ? { ...provider, enabled } : provider
        )
      }
      await saveConfig(platform, next)
      resetProviderCache()
      return providerStatuses(next)
    }
  )

  ipcMain.handle(
    'charliecode:providers:add',
    async (_event, payload: AddProviderPayload): Promise<ProviderStatus[]> => {
      const id = payload.id.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-')
      const baseUrl = payload.baseUrl.trim().replace(/\/+$/, '')
      if (!id) throw new Error('Serve un id per il provider.')
      if (!/^https?:\/\//i.test(baseUrl)) throw new Error('La base URL deve iniziare con http:// o https://')

      const { config } = await loadConfig(platform)
      if (config.providers.some((provider) => provider.id === id)) {
        throw new Error(`Esiste già un provider con id "${id}".`)
      }

      const next: CharlieCodeConfig = {
        ...config,
        providers: [
          ...config.providers,
          {
            id,
            label: payload.label.trim() || id,
            baseUrl,
            kind: payload.kind === 'router' ? 'router' : 'direct',
            enabled: true
          }
        ]
      }
      await saveConfig(platform, next)
      resetProviderCache()
      return providerStatuses(next)
    }
  )

  ipcMain.handle('charliecode:agents:open-global', async (): Promise<void> => {
    const path = globalAgentsPath(platform)
    if (!existsSync(path)) {
      await writeFile(
        path,
        `# Istruzioni globali per CharlieCode

Valgono per ogni progetto aperto. Le istruzioni nel \`AGENTS.md\` del progetto
hanno priorità su queste.

- Rispondi in italiano.
- Preferisci soluzioni semplici e leggibili.
- Prima di modificare un file, spiega cosa stai cambiando.
`,
        'utf8'
      )
    }
    await shell.openPath(path)
  })

  ipcMain.handle('charliecode:sessions:list', async (): Promise<SessionSummary[]> => {
    return listSessions(platform)
  })

  ipcMain.handle('charliecode:sessions:load', async (_event, id: string) => {
    return (await readSession(platform, id)) ?? null
  })

  ipcMain.handle('charliecode:sessions:delete', async (_event, id: string): Promise<boolean> => {
    return deleteSession(platform, id)
  })

  ipcMain.handle('charliecode:sessions:rename', async (_event, id: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return null
    return (await updateSession(platform, id, { title: trimmed })) ?? null
  })

  ipcMain.handle(
    'charliecode:chat:start',
    async (
      event,
      payload: ChatStartPayload
    ): Promise<{ ok: boolean; error?: string; sessionId?: string }> => {
      if (inFlight.has(payload.requestId)) {
        return { ok: false, error: 'Richiesta già in corso' }
      }

      const controller = new AbortController()
      inFlight.set(payload.requestId, controller)
      const sender = event.sender

      // The main process owns the conversation: it persists the user turn,
      // streams, then persists the assistant turn. The renderer only renders.
      const { config } = await loadConfig(platform)
      const session =
        (payload.sessionId ? await readSession(platform, payload.sessionId) : undefined) ??
        (await createSession(platform, {
          id: payload.sessionId,
          workspacePath: payload.workspacePath ?? config.workspace,
          modelKey: payload.modelKey,
          effort: payload.effort ?? config.effort
        }))

      // Attachments are validated and written before the stream starts, so a
      // rejected file never leaves a half turn on disk.
      let attachmentRefs: Awaited<ReturnType<typeof saveAttachments>> = []
      try {
        attachmentRefs = await saveAttachments(
          platform,
          session.id,
          payload.userMessageId,
          payload.attachments ?? []
        )
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          sessionId: session.id
        }
      }

      await appendMessage(platform, session.id, {
        id: payload.userMessageId,
        role: 'user',
        content: payload.text,
        createdAt: new Date().toISOString(),
        ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {})
      })
      await updateSession(platform, session.id, {
        modelKey: payload.modelKey,
        effort: payload.effort ?? config.effort,
        ...(payload.workspacePath ? { workspacePath: payload.workspacePath } : {})
      })

      void (async () => {
        let text = ''
        let usedModel = payload.modelKey
        let meta: string | undefined
        let failure: string | undefined
        let aborted = false

        try {
          const { models } = await loadCatalog(platform, config)
          const stored = (await readSession(platform, session.id)) ?? session
          const history = await materializeHistory(platform, toChatHistory(stored))
          const context = await loadProjectContext(
            platform,
            payload.workspacePath ?? config.workspace
          )
          const system = [BASE_SYSTEM_PROMPT, context.system].filter(Boolean).join('\n\n')

          const stream = streamChat(
            {
              modelKey: payload.modelKey,
              messages: history,
              system: payload.system ?? system,
              effort: payload.effort,
              maxOutputTokens: payload.maxOutputTokens,
              signal: controller.signal
            },
            { platform, config, models }
          )

          for await (const engineEvent of stream) {
            if (sender.isDestroyed()) break

            if (engineEvent.type === 'start') {
              usedModel = engineEvent.modelKey
              if (engineEvent.fallbackFrom) meta = `fallback da ${engineEvent.fallbackFrom}`
            }
            if (engineEvent.type === 'delta') text += engineEvent.text
            if (engineEvent.type === 'done') {
              aborted = Boolean(engineEvent.aborted)
              meta = [
                meta,
                `ttft ${engineEvent.ttftMs}ms`,
                `totale ${engineEvent.ms}ms`,
                engineEvent.usage?.outputTokens ? `${engineEvent.usage.outputTokens} token` : undefined,
                aborted ? 'interrotto' : undefined
              ]
                .filter(Boolean)
                .join(' · ')
            }
            if (engineEvent.type === 'error') failure = engineEvent.message

            sender.send('charliecode:chat:event', {
              requestId: payload.requestId,
              event: engineEvent
            })
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
          if (!sender.isDestroyed()) {
            sender.send('charliecode:chat:event', {
              requestId: payload.requestId,
              event: { type: 'error', message: failure }
            })
          }
        } finally {
          inFlight.delete(payload.requestId)

          // Persist even a partial or failed turn: the conversation the user
          // saw on screen must be the conversation on disk.
          try {
            await appendMessage(platform, session.id, {
              id: payload.assistantMessageId,
              role: 'assistant',
              content: text,
              createdAt: new Date().toISOString(),
              modelKey: usedModel,
              error: failure,
              meta
            })
            const saved = await readSession(platform, session.id)
            if (!sender.isDestroyed()) {
              sender.send('charliecode:chat:session', {
                requestId: payload.requestId,
                sessionId: session.id,
                title: saved?.title ?? session.title,
                updatedAt: saved?.updatedAt ?? new Date().toISOString()
              })
              sender.send('charliecode:chat:end', { requestId: payload.requestId })
            }
          } catch (persistError) {
            console.error('[charliecode] impossibile salvare la sessione:', persistError)
          }
        }
      })()

      return { ok: true, sessionId: session.id }
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
