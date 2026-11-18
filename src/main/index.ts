import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { buildSystemPrompt, runAgent } from '../engine/agent'
import { globalAgentsPath, loadProjectContext } from '../engine/agents'
import { attachmentsDir, materializeHistory, saveAttachments } from '../engine/attachments'
import { findModel, loadCatalog, pickDefaultModel } from '../engine/catalog'
import { resetProviderCache } from '../engine/client'
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
import {
  compactAgentContext,
  deleteAgentContext,
  readAgentContext,
  readAgentContextStats,
  writeAgentContext
} from '../engine/context-store'
import { compactMessages, contextBudget } from '../engine/context'
import { agentModels, detectAgentClis, runExternalAgent } from '../engine/external-agents'
import { dockerAvailable, hasBinary, probeEndpoint, scanLocalEndpoints } from '../engine/local'
import { createPlatform } from '../engine/platform'
import { ensureProjectMemory, resolvePlugins } from '../engine/plugins'
import { suggestSetup } from '../engine/advisor'
import { changeDiff, listChanges, revertChange, workspacePath } from '../engine/changes'
import {
  globalSkillsDir,
  installSkillFromGit,
  listSkills,
  projectSkillsDir,
  removeSkill
} from '../engine/skills'
import {
  applyOnboarding,
  inspectProject,
  planOnboarding,
  skipOnboarding
} from '../engine/onboarding'
import {
  appendMessage,
  createSession,
  deleteSession,
  listSessions,
  readSession,
  toChatHistory,
  updateSession,
  upsertMessage,
  type SessionSummary
} from '../engine/sessions'
import { toolLogFromEvent } from '../engine/tools'
import type {
  CharlieCodeConfig,
  ExternalWorkerConfig,
  PermissionDecision,
  PermissionRequest,
  ToolLog
} from '../engine/types'
import type {
  AddProviderPayload,
  AppInfo,
  ChatStartPayload,
  DetectedLocal,
  ExternalAgentsStatus,
  ExternalTestResult,
  ModelsResponse,
  OnboardingAnswers,
  OnboardingApplyPayload,
  OnboardingFacts,
  OnboardingResult,
  ProviderStatus,
  WorkspaceChange,
  WorkspaceChanges,
  RoutersStatus
} from '../shared/ipc'

const platform = createPlatform()
const inFlight = new Map<string, AbortController>()

/** Permission prompts waiting for the renderer: permissionId → resolver. */
const permissionResolvers = new Map<string, (decision: PermissionDecision) => void>()
const permissionRequests = new Map<string, string>()

const OPEN_EXTERNAL_HOSTS = [
  'openrouter.ai',
  'opencode.ai',
  'github.com',
  'ollama.com',
  'lmstudio.ai',
  'aistudio.google.com',
  'console.groq.com',
  'cloud.cerebras.ai',
  'console.mistral.ai',
  'docs.vllm.ai',
  'huggingface.co',
  'freellmapi.com'
]

function isAllowedExternal(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true
    return OPEN_EXTERNAL_HOSTS.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    )
  } catch {
    return false
  }
}

/**
 * Links the user clicked are untrusted content. Known documentation hosts open
 * directly; anything else asks first, with the full URL visible. Silently
 * refusing a link (the old allowlist) looked like a broken click.
 */
async function openExternalWithConsent(rawUrl: string): Promise<boolean> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false

  if (isAllowedExternal(rawUrl)) {
    await shell.openExternal(rawUrl)
    return true
  }

  const options: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Apri nel browser', 'Annulla'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: 'Aprire questo link?',
    detail: rawUrl
  }
  const parent = BrowserWindow.getFocusedWindow()
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  if (response !== 0) return false
  await shell.openExternal(rawUrl)
  return true
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e1116',
    title: 'CharlieCode',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 18 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalWithConsent(url)
    return { action: 'deny' }
  })

  window.webContents.on('did-finish-load', () => {
    console.log('[charliecode] renderer loaded')
  })

  // In dev, surface renderer errors in the terminal: a React crash otherwise
  // only shows up in a DevTools window nobody opened.
  if (process.env.ELECTRON_RENDERER_URL) {
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') {
        console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
      }
    })
  }

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
      keySource: key.source,
      showAllModels: Boolean(provider.showAllModels),
      ...(provider.docs ? { docs: provider.docs } : {}),
      ...(provider.free ? { free: true } : {})
    })
  }
  return statuses
}

function rememberWorkspace(config: CharlieCodeConfig, workspace: string): CharlieCodeConfig {
  const recent = [workspace, ...config.recentWorkspaces.filter((entry) => entry !== workspace)]
  return { ...config, workspace, recentWorkspaces: recent.slice(0, 8) }
}

/** Token budget of the model in use, for the context badge and compaction. */
async function modelContextBudget(modelKey?: string): Promise<number> {
  const { config } = await loadConfig(platform)
  const { models } = await loadCatalog(platform, config)
  const entry =
    (modelKey ? findModel(models, modelKey) : undefined) ?? pickDefaultModel(models, config)
  return contextBudget(entry?.caps)
}

/** Wires one permission request to the renderer and waits for the answer. */
async function askUser(
  sender: Electron.WebContents,
  requestId: string,
  request: PermissionRequest,
  config: CharlieCodeConfig
): Promise<PermissionDecision> {
  if (sender.isDestroyed()) return 'deny'

  const decision = await new Promise<PermissionDecision>((resolve) => {
    const timer = setTimeout(() => {
      permissionResolvers.delete(request.id)
      permissionRequests.delete(request.id)
      resolve('deny')
    }, 10 * 60 * 1000)

    permissionResolvers.set(request.id, (value) => {
      clearTimeout(timer)
      permissionResolvers.delete(request.id)
      permissionRequests.delete(request.id)
      resolve(value)
    })
    permissionRequests.set(request.id, requestId)
    sender.send('charliecode:chat:permission', { requestId, request })
  })

  if (decision === 'allow-always') {
    const next: CharlieCodeConfig = structuredClone(config)
    if (request.tool === 'bash' && request.command) {
      const prefix = request.command.trim().split(/\s+/).slice(0, 2).join(' ')
      if (prefix && !next.agents.autoApproveCommands.includes(prefix)) {
        next.agents.autoApproveCommands.push(prefix)
      }
    } else if (!next.agents.autoApprove.includes(request.tool)) {
      next.agents.autoApprove.push(request.tool)
    }
    await saveConfig(platform, next)
  }

  return decision
}

function launchRuntime(id: 'freellmapi' | 'ollama'): boolean {
  try {
    if (platform.id === 'darwin') {
      const name = id === 'freellmapi' ? 'FreeLLMAPI' : 'Ollama'
      const child = spawn('open', ['-a', name], { detached: true, stdio: 'ignore' })
      child.unref()
      return true
    }
    if (platform.isWindows) {
      const command = id === 'freellmapi' ? 'FreeLLMAPI' : 'ollama'
      const child = spawn('cmd.exe', ['/c', 'start', '', command], {
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      return true
    }
    const child = spawn(id === 'freellmapi' ? 'freellmapi' : 'ollama', ['serve'], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

function registerIpc(): void {
  ipcMain.handle('charliecode:info', async (): Promise<AppInfo> => {
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
    // The resolved default, not the raw config value: the renderer uses it to
    // repair a stale selection (a model whose provider is gone).
    return { models, errors, defaultModel: pickDefaultModel(models, config)?.key ?? config.defaultModel }
  })

  ipcMain.handle('charliecode:workspace:pick', async (event): Promise<{ path?: string }> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Scegli il progetto',
      buttonLabel: 'Apri progetto',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
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

  ipcMain.handle(
    'charliecode:workspace:use',
    async (_event, path: string): Promise<{ path?: string }> => {
      if (!path) return {}
      const { config } = await loadConfig(platform)
      await saveConfig(platform, rememberWorkspace(config, path))
      return { path }
    }
  )

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
    'charliecode:providers:show-all-models',
    async (_event, providerId: string, showAll: boolean): Promise<ProviderStatus[]> => {
      const { config } = await loadConfig(platform)
      const next: CharlieCodeConfig = {
        ...config,
        providers: config.providers.map((provider) =>
          provider.id === providerId ? { ...provider, showAllModels: showAll } : provider
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
      if (!/^https?:\/\//i.test(baseUrl)) {
        throw new Error('La base URL deve iniziare con http:// o https://')
      }

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

  /* ----------------------------- agent CLIs ----------------------------- */

  const externalStatus = async (): Promise<ExternalAgentsStatus> => {
    const { config } = await loadConfig(platform)
    return {
      detected: await detectAgentClis(platform.homeDir),
      ...(config.external ? { worker: config.external } : {})
    }
  }

  ipcMain.handle('charliecode:external:list', () => externalStatus())

  ipcMain.handle(
    'charliecode:external:models',
    async (_event, id: string): Promise<string[]> => agentModels(id, platform.homeDir)
  )

  ipcMain.handle(
    'charliecode:external:test',
    async (
      _event,
      payload: { id: string; model?: string }
    ): Promise<ExternalTestResult> => {
      const started = Date.now()
      const { config } = await loadConfig(platform)
      try {
        const result = await runExternalAgent(
          payload.id,
          {
            prompt:
              'Rispondi soltanto con la parola ok. Non leggere file e non eseguire comandi.',
            ...(payload.model ? { model: payload.model } : {}),
            // A test must never modify the project.
            plan: true,
            workspace: config.workspace ?? platform.homeDir
          },
          { home: platform.homeDir, timeoutMs: 120_000 }
        )
        return {
          ok: result.code === 0 && result.text.length > 0,
          text: result.text.slice(0, 400),
          ms: Date.now() - started
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ms: Date.now() - started
        }
      }
    }
  )

  ipcMain.handle(
    'charliecode:external:set-worker',
    async (_event, worker: ExternalWorkerConfig | null): Promise<ExternalAgentsStatus> => {
      const { config } = await loadConfig(platform)
      const next: CharlieCodeConfig = { ...config }
      if (worker?.id) next.external = worker
      else delete next.external
      await saveConfig(platform, next)
      return externalStatus()
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

  ipcMain.handle('charliecode:routers:status', async (): Promise<RoutersStatus> => {
    const freePrimary = await probeEndpoint('http://127.0.0.1:31415/v1')
    const freeFallback = freePrimary.ok
      ? freePrimary
      : await probeEndpoint('http://127.0.0.1:3001/v1')
    const ollamaProbe = await probeEndpoint('http://localhost:11434/v1')
    const detected = await scanLocalEndpoints()

    const freellmapiInstalled =
      platform.id === 'darwin'
        ? existsSync('/Applications/FreeLLMAPI.app')
        : existsSync(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'freellmapi', 'FreeLLMAPI.exe'))

    return {
      freellmapi: {
        id: 'freellmapi',
        label: 'FreeLLMAPI',
        running: freeFallback.ok,
        installed: freellmapiInstalled,
        baseUrl: freeFallback.baseUrl,
        hint: freeFallback.ok
          ? `${freeFallback.models ?? '?'} modelli dal router locale`
          : 'Router locale non in esecuzione'
      },
      ollama: {
        id: 'ollama',
        label: 'Ollama',
        running: ollamaProbe.ok,
        installed: hasBinary('ollama') || existsSync('/Applications/Ollama.app'),
        baseUrl: ollamaProbe.baseUrl,
        hint: ollamaProbe.ok
          ? `${ollamaProbe.models ?? '?'} modelli locali`
          : 'Nessun modello locale in ascolto su 11434'
      },
      detected: detected.map((entry): DetectedLocal => ({
        id: entry.preset.id,
        label: entry.preset.label,
        baseUrl: entry.preset.baseUrl,
        models: entry.models,
        needsKey: entry.preset.needsKey,
        docs: entry.preset.docs,
        startCommand: entry.preset.startCommand,
        container: entry.preset.container
      })),
      docker: await dockerAvailable()
    }
  })

  ipcMain.handle('charliecode:routers:launch', (_event, id: 'freellmapi' | 'ollama'): boolean => {
    return launchRuntime(id)
  })

  ipcMain.handle('charliecode:open-external', async (_event, url: string): Promise<void> => {
    const opened = await openExternalWithConsent(url)
    if (!opened && !/^https?:/i.test(url)) throw new Error(`URL non consentito: ${url}`)
  })

  ipcMain.handle('charliecode:sessions:list', async (): Promise<SessionSummary[]> => {
    return listSessions(platform)
  })

  ipcMain.handle('charliecode:sessions:load', async (_event, id: string) => {
    return (await readSession(platform, id)) ?? null
  })

  ipcMain.handle('charliecode:sessions:delete', async (_event, id: string): Promise<boolean> => {
    const removed = await deleteSession(platform, id)
    await deleteAgentContext(platform, id)
    await rm(attachmentsDir(platform, id, ''), { recursive: true, force: true }).catch(() => undefined)
    return removed
  })

  ipcMain.handle('charliecode:sessions:rename', async (_event, id: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return null
    return (await updateSession(platform, id, { title: trimmed })) ?? null
  })

  ipcMain.handle(
    'charliecode:context:stats',
    async (_event, sessionId: string, modelKey?: string) => {
      const budget = await modelContextBudget(modelKey)
      const session = await readSession(platform, sessionId)
      // Legacy sessions predate the sidecar: measure the transcript instead of
      // showing 0 tokens for a conversation that is clearly long.
      const fallback = session
        ? await materializeHistory(platform, toChatHistory(session))
        : []
      return readAgentContextStats(platform, sessionId, budget, fallback)
    }
  )

  ipcMain.handle(
    'charliecode:context:compact',
    async (_event, sessionId: string, modelKey?: string) => {
      const budget = await modelContextBudget(modelKey)
      const session = await readSession(platform, sessionId)
      const fallback = session
        ? await materializeHistory(platform, toChatHistory(session))
        : []
      return compactAgentContext(platform, sessionId, budget, fallback)
    }
  )

  ipcMain.handle('charliecode:chat:permission-response', (_event, permissionId: string, decision: PermissionDecision): void => {
    permissionResolvers.get(permissionId)?.(decision)
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
        let logs: ToolLog[] = []
        let fullHistory: import('ai').ModelMessage[] = []
        let newMessages: import('ai').ModelMessage[] | undefined
        const workspace = payload.workspacePath ?? config.workspace

        // The answer is persisted while it streams, so a crash or a quit does
        // not lose ten minutes of work. Drafts and the final version share the
        // message id, so the final `upsertMessage` replaces the draft.
        let streamed = ''
        let lastDraftAt = 0
        let draftChain: Promise<void> = Promise.resolve()
        const assistantCreatedAt = new Date().toISOString()

        const flushDraft = (): void => {
          if (!streamed.trim()) return
          const at = Date.now()
          if (at - lastDraftAt < 1_500) return
          lastDraftAt = at
          const content = streamed
          draftChain = draftChain
            .then(() =>
              upsertMessage(platform, session.id, {
                id: payload.assistantMessageId,
                role: 'assistant',
                content,
                createdAt: assistantCreatedAt,
                modelKey: usedModel
              })
            )
            .then(() => undefined)
            .catch(() => undefined)
        }

        try {
          const { models } = await loadCatalog(platform, config)
          // The requested model may be gone (provider removed, model retired,
          // session restored from an older install). Falling back here keeps a
          // stale key from dead-ending the chat.
          const requested = findModel(models, payload.modelKey)
          const activeModel = requested ?? pickDefaultModel(models, config)
          const modelKey = activeModel?.key ?? payload.modelKey
          if (modelKey !== payload.modelKey) {
            usedModel = modelKey
            await updateSession(platform, session.id, { modelKey })
          }
          const stored = (await readSession(platform, session.id)) ?? session
          const savedContext = await readAgentContext(platform, session.id)
          fullHistory =
            savedContext.length > 0
              ? savedContext
              : await materializeHistory(platform, toChatHistory(stored))
          // The model gets a fitted context; the sidecar keeps the full one.
          const budget = contextBudget(activeModel?.caps)
          const history = compactMessages(fullHistory, { budget }).messages
          const projectContext = await loadProjectContext(platform, workspace)
          const system =
            payload.system ?? buildSystemPrompt(projectContext.system, workspace)

          const result = await runAgent(
            {
              modelKey,
              messages: [],
              system,
              effort: payload.effort,
              maxOutputTokens: payload.maxOutputTokens,
              signal: controller.signal,
              mode: payload.mode ?? 'build',
              ...(payload.team ? { team: true } : {})
            },
            {
              platform,
              config,
              models,
              workspace,
              modelMessages: history,
              maxSteps: config.agents.maxSteps,
              subagentMaxSteps: config.agents.subagentMaxSteps,
              askPermission: (request) =>
                askUser(sender, payload.requestId, request, config),
              emit: (engineEvent) => {
                if (engineEvent.type === 'tool-call' || engineEvent.type === 'tool-result') {
                  logs = toolLogFromEvent(engineEvent, logs)
                }
                if (engineEvent.type === 'delta' && !engineEvent.agentId) {
                  streamed += engineEvent.text
                  flushDraft()
                }
                if (engineEvent.type === 'start') usedModel = engineEvent.modelKey
                if (engineEvent.type === 'done') {
                  aborted = Boolean(engineEvent.aborted)
                  meta = [
                    meta,
                    engineEvent.steps ? `${engineEvent.steps} step` : undefined,
                    engineEvent.toolCalls ? `${engineEvent.toolCalls} tool` : undefined,
                    `ttft ${engineEvent.ttftMs}ms`,
                    `totale ${engineEvent.ms}ms`,
                    engineEvent.usage?.outputTokens
                      ? `${engineEvent.usage.outputTokens} token`
                      : undefined,
                    aborted ? 'interrotto' : undefined
                  ]
                    .filter(Boolean)
                    .join(' · ')
                }
                if (engineEvent.type === 'error') failure = engineEvent.message
                if (!sender.isDestroyed()) {
                  sender.send('charliecode:chat:event', {
                    requestId: payload.requestId,
                    event: engineEvent
                  })
                }
              }
            }
          )

          text = result.text
          usedModel = result.modelKey || usedModel
          aborted = result.aborted
          if (result.error) failure = result.error
          if (result.newMessages.length > 0) newMessages = result.newMessages
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

          // A stopped request must not leave the UI waiting for a permission.
          for (const [permissionId, requestId] of permissionRequests) {
            if (requestId !== payload.requestId) continue
            permissionResolvers.get(permissionId)?.('deny')
          }

          try {
            // Wait for a draft already queued, then replace it with the final
            // version: same id, no duplicate in the transcript.
            await draftChain
            await upsertMessage(platform, session.id, {
              id: payload.assistantMessageId,
              role: 'assistant',
              content: text || streamed,
              createdAt: new Date().toISOString(),
              modelKey: usedModel,
              error: failure,
              meta,
              ...(logs.length > 0 ? { tools: logs } : {})
            })
            if (newMessages) {
              // Persist the *full* history, not the compacted one the model
              // saw: compaction is a read-time view and must stay reversible.
              await writeAgentContext(platform, session.id, [...fullHistory, ...newMessages])
            }
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
    for (const [permissionId, owner] of permissionRequests) {
      if (owner !== requestId) continue
      permissionResolvers.get(permissionId)?.('deny')
    }
  })

  ipcMain.handle('charliecode:open-config', async (): Promise<void> => {
    await shell.openPath(platform.configDir)
  })

  /** The list of tools and bash prefixes that never ask the user. */
  ipcMain.handle('charliecode:agents:auto-approve', async () => {
    const { config } = await loadConfig(platform)
    return {
      tools: [...config.agents.autoApprove].sort(),
      commands: [...config.agents.autoApproveCommands].sort()
    }
  })

  ipcMain.handle(
    'charliecode:agents:auto-approve:set',
    async (
      _event,
      payload: { tool?: string; command?: string; remove?: boolean }
    ): Promise<{ tools: string[]; commands: string[] }> => {
      const { config } = await loadConfig(platform)
      const next: CharlieCodeConfig = structuredClone(config)
      const list = payload.command ? next.agents.autoApproveCommands : next.agents.autoApprove
      const entry = (payload.command ?? payload.tool ?? '').trim()

      if (payload.remove) {
        const index = list.indexOf(entry)
        if (index > -1) list.splice(index, 1)
      } else if (entry) {
        if (!list.includes(entry)) list.push(entry)
      }

      await saveConfig(platform, next)
      return {
        tools: [...next.agents.autoApprove].sort(),
        commands: [...next.agents.autoApproveCommands].sort()
      }
    }
  )

  /* ---------------------------- plugins ---------------------------- */

  ipcMain.handle('charliecode:plugins:list', async () => {
    const { config } = await loadConfig(platform)
    return resolvePlugins(config)
  })

  ipcMain.handle('charliecode:plugins:set', async (_event, id: string, enabled: boolean) => {
    const { config } = await loadConfig(platform)
    const next: CharlieCodeConfig = {
      ...config,
      plugins: { ...(config.plugins ?? {}), [id]: { enabled } }
    }
    await saveConfig(platform, next)
    return resolvePlugins(next)
  })

  /** Runs the setup advisor for the open project, outside the agent loop. */
  ipcMain.handle('charliecode:plugins:suggest-setup', async (): Promise<string> => {
    const { config } = await loadConfig(platform)
    if (!config.workspace) throw new Error('Apri prima un progetto.')
    const report = await suggestSetup(config.workspace)
    return report.markdown
  })

  /**
   * Project memory lives in the project (`.charliecode/memory.md`) so it is
   * visible, editable and can be committed with the code.
   */
  ipcMain.handle('charliecode:plugins:open-memory', async (): Promise<string | null> => {
    const { config } = await loadConfig(platform)
    if (!config.workspace) return null
    const path = await ensureProjectMemory(config.workspace)
    await shell.openPath(path)
    return path
  })

  /* ----------------------------- skills ----------------------------- */

  const skillsFor = async (): Promise<{ workspace?: string; skills: Awaited<ReturnType<typeof listSkills>> }> => {
    const { config } = await loadConfig(platform)
    return { workspace: config.workspace, skills: await listSkills(platform, config.workspace) }
  }

  /* --------------------------- onboarding --------------------------- */

  ipcMain.handle(
    'charliecode:onboarding:facts',
    async (_event, workspace: string): Promise<OnboardingFacts> =>
      inspectProject(platform, workspace)
  )

  ipcMain.handle(
    'charliecode:onboarding:preview',
    async (_event, payload: { workspace: string; answers: OnboardingAnswers }) =>
      planOnboarding(platform, payload.workspace, payload.answers)
  )

  ipcMain.handle(
    'charliecode:onboarding:apply',
    async (
      _event,
      payload: { workspace: string; apply: OnboardingApplyPayload }
    ): Promise<OnboardingResult> => {
      const result = await applyOnboarding(platform, payload.workspace, payload.apply)
      if (result.autoApprove.length > 0) {
        const { config } = await loadConfig(platform)
        const merged = [...new Set([...config.agents.autoApproveCommands, ...result.autoApprove])]
        await saveConfig(platform, {
          ...config,
          agents: { ...config.agents, autoApproveCommands: merged }
        })
      }
      return result
    }
  )

  ipcMain.handle('charliecode:onboarding:skip', async (_event, workspace: string): Promise<void> => {
    await skipOnboarding(workspace)
  })

  /* ----------------------------- changes ---------------------------- */

  ipcMain.handle(
    'charliecode:changes:list',
    async (_event, workspace: string): Promise<WorkspaceChanges> => listChanges(workspace)
  )

  ipcMain.handle(
    'charliecode:changes:diff',
    async (_event, payload: { workspace: string; path: string }) =>
      changeDiff(payload.workspace, payload.path)
  )

  ipcMain.handle(
    'charliecode:changes:revert',
    async (
      _event,
      payload: { workspace: string; change: WorkspaceChange }
    ): Promise<WorkspaceChanges> => {
      await revertChange(payload.workspace, payload.change)
      return listChanges(payload.workspace)
    }
  )

  ipcMain.handle(
    'charliecode:file:open',
    async (_event, payload: { workspace: string; path: string }): Promise<void> => {
      const target = workspacePath(payload.workspace, payload.path)
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
    }
  )

  ipcMain.handle('charliecode:skills:list', async () => (await skillsFor()).skills)

  ipcMain.handle(
    'charliecode:skills:install',
    async (_event, payload: { url: string; target: 'global' | 'project' }) => {
      const { workspace } = await skillsFor()
      await installSkillFromGit(platform, payload.url, payload.target, workspace)
      return (await skillsFor()).skills
    }
  )

  ipcMain.handle(
    'charliecode:skills:remove',
    async (_event, payload: { dir: string; source: 'global' | 'project' }) => {
      const { workspace } = await skillsFor()
      await removeSkill(platform, payload, workspace)
      return (await skillsFor()).skills
    }
  )

  ipcMain.handle('charliecode:skills:open-dir', async (_event, target: 'global' | 'project') => {
    const { workspace } = await skillsFor()
    if (target === 'project' && !workspace) throw new Error('Apri prima un progetto.')
    const dir =
      target === 'project' ? projectSkillsDir(workspace as string) : globalSkillsDir(platform)
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })
}

app.setName('CharlieCode')

/**
 * In development Electron runs from `node_modules`, so the Dock would show the
 * Electron name and logo. Point it at our own icon; a packaged build already
 * gets both from the bundle (Info.plist + icon.icns).
 */
if (process.platform === 'darwin' && !app.isPackaged) {
  const devIcon = join(__dirname, '../../build/icon.png')
  if (existsSync(devIcon)) {
    const image = nativeImage.createFromPath(devIcon)
    if (!image.isEmpty()) app.dock?.setIcon(image)
  }
}

// Two instances would write the same config, sessions and context sidecars.
// The second one hands focus to the first and exits.
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

  app.whenReady().then(() => {
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
