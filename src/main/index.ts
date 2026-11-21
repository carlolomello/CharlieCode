import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { buildSystemPrompt, runAgent } from '../engine/agent'
import { applyConfigPatch, type AppConfigPatch } from '../engine/app-config'
import { selfKnowledgePrompt } from '../engine/self-knowledge'
import { globalAgentsPath, loadProjectContext } from '../engine/agents'
import {
  deleteSessionAttachments,
  materializeHistory,
  materializeModelHistory,
  saveAttachments
} from '../engine/attachments'
import { findModel, loadCatalog, pickDefaultModel } from '../engine/catalog'
import { complete, resetProviderCache } from '../engine/client'
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
import { appendCurrentUser, compactMessages, contextBudget, stripImages } from '../engine/context'
import {
  buildCliArgs,
  findBinary,
  formatCommand,
  profileModels,
  promptOnStdin,
  resolveBinaryViaShell,
  runExternalAgent,
  searchBinaries
} from '../engine/external-agents'
import { introspectCli } from '../engine/cli-introspect'
import {
  askModelCommand,
  connectCli,
  discoverModelCommand,
  ensureCliArgs
} from '../engine/cli-connect'
import { listWorkspaceDir, readWorkspaceFile } from '../engine/workspace-files'
import {
  deleteCliProfile,
  listCliProfiles,
  readCliProfile,
  saveCliProfile,
  validateCliProfile
} from '../engine/cli-profiles'
import { dockerAvailable, hasBinary, probeEndpoint, scanLocalEndpoints } from '../engine/local'
import { createPlatform } from '../engine/platform'
import { ensureProjectMemory, resolvePlugins } from '../engine/plugins'
import { suggestSetup } from '../engine/advisor'
import { changeDiff, initRepository, listChanges, revertChange, workspacePath } from '../engine/changes'
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
import { cliModelEntries, runCliTurn } from '../engine/backends'
import { readRouting, ensureRoutingFile } from '../engine/routing'
import { parseCliModelKey } from '../shared/cli-key'
import type {
  CharlieCodeConfig,
  EngineEvent,
  ExternalWorkerConfig,
  PermissionDecision,
  PermissionRequest,
  ToolLog
} from '../engine/types'
import type {
  AddProviderPayload,
  AppInfo,
  ChatStartPayload,
  CliConnectReport,
  CliPreview,
  CliPreviewPayload,
  CliProfilesStatus,
  CliTestResult,
  DetectedLocal,
  ModelsResponse,
  OnboardingAnswers,
  OnboardingApplyPayload,
  OnboardingFacts,
  OnboardingResult,
  ProviderStatus,
  WorkspaceChange,
  WorkspaceChanges,
  RoutersStatus,
  RoutingStatus,
  WorkspaceDirListing,
  WorkspaceFile
} from '../shared/ipc'

const platform = createPlatform()
const inFlight = new Map<string, AbortController>()

/** Permission prompts waiting for the renderer: permissionId → resolver. */
const permissionResolvers = new Map<string, (decision: PermissionDecision) => void>()
const permissionRequests = new Map<string, string>()

const OPEN_EXTERNAL_HOSTS = [
  'openrouter.ai',
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

function isAppNavigation(rawUrl: string): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    try {
      return new URL(rawUrl).origin === new URL(devUrl).origin
    } catch {
      return false
    }
  }
  const appUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  return rawUrl === appUrl || rawUrl.startsWith(`${appUrl}#`)
}

/**
 * Every project path coming from the renderer must be one the user opened.
 * `chat:start`, changes and onboarding used to trust it blindly.
 */
async function assertDirectory(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Progetto mancante.')
  const resolved = resolve(path)
  const info = await stat(resolved).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`La cartella del progetto non esiste: ${path}`)
  return resolved
}

async function assertWorkspace(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Progetto mancante.')
  const resolved = resolve(path)
  const { config } = await loadConfig(platform)
  const allowed = new Set(
    [config.workspace, ...config.recentWorkspaces]
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => resolve(entry))
  )
  if (!allowed.has(resolved)) throw new Error('Progetto non valido o non aperto di recente.')
  const info = await stat(resolved).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`La cartella del progetto non esiste: ${path}`)
  return resolved
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

  // A remote page loaded in this window would keep the preload bridge and
  // could call chat:start, changes:revert or skills:install. Only our own app
  // may navigate; links go to the browser, with consent.
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppNavigation(url)) return
    event.preventDefault()
    void openExternalWithConsent(url)
  })
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  // The app needs no camera, microphone, geolocation or notifications. Copy
  // still works: clipboard writes are the only permission we grant.
  const allowedPermissions = new Set<string>(['clipboard-sanitized-write', 'clipboard-read'])
  window.webContents.session.setPermissionRequestHandler(
    (_contents, permission, callback) => callback(allowedPermissions.has(permission))
  )
  window.webContents.session.setPermissionCheckHandler((_contents, permission) =>
    allowedPermissions.has(permission)
  )

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
  request: PermissionRequest
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
    // Reload: the user may have changed a setting in the drawer while the turn
    // was running, and saving the snapshot taken at the start would lose it.
    const { config } = await loadConfig(platform)
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
  const label = id === 'freellmapi' ? 'FreeLLMAPI' : 'Ollama'
  const track = (child: ReturnType<typeof spawn>): void => {
    // Without this listener a missing binary emits an unhandled `error` and,
    // on Linux, can take the whole app down.
    child.on('error', (error) => {
      console.error(`[charliecode] impossibile avviare ${label}:`, error)
    })
    child.unref()
  }

  try {
    if (platform.id === 'darwin') {
      track(spawn('open', ['-a', label], { detached: true, stdio: 'ignore' }))
      return true
    }
    if (platform.isWindows) {
      const command = id === 'freellmapi' ? 'FreeLLMAPI' : 'ollama'
      track(
        spawn('cmd.exe', ['/c', 'start', '', command], {
          detached: true,
          stdio: 'ignore'
        })
      )
      return true
    }
    track(
      spawn(id === 'freellmapi' ? 'freellmapi' : 'ollama', ['serve'], {
        detached: true,
        stdio: 'ignore'
      })
    )
    return true
  } catch {
    return false
  }
}

function registerIpc(): void {
  ipcMain.handle('charliecode:info', async (): Promise<AppInfo> => {
    const { config, recovered } = await loadConfig(platform)
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
      effort: config.effort,
      ...(recovered ? { configRecovered: recovered } : {})
    }
  })

  ipcMain.handle('charliecode:models', async (): Promise<ModelsResponse> => {
    const { config } = await loadConfig(platform)
    const { models, errors } = await loadCatalog(platform, config)
    // CLI profiles are backends too: they appear in the same picker as native
    // models, so the user chooses one without leaving the conversation.
    const cli = await cliStatus()
    // The resolved default, not the raw config value: the renderer uses it to
    // repair a stale selection (a model whose provider is gone).
    return {
      models: [...models, ...cliModelEntries(cli.profiles)],
      errors,
      defaultModel: pickDefaultModel(models, config)?.key ?? config.defaultModel
    }
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
      // `useWorkspace` is how a project enters the recent list (a session can
      // point at a folder older than the last eight), so it checks that the
      // folder exists. The dangerous handlers check the allow-list.
      const valid = await assertDirectory(path)
      const { config } = await loadConfig(platform)
      await saveConfig(platform, rememberWorkspace(config, valid))
      return { path: valid }
    }
  )

  ipcMain.handle('charliecode:workspace:open', async (): Promise<void> => {
    const { config } = await loadConfig(platform)
    if (config.workspace) await shell.openPath(config.workspace)
  })

  ipcMain.handle(
    'charliecode:workspace:tree',
    async (_event, workspace: string, path?: string): Promise<WorkspaceDirListing> => {
      const root = await assertDirectory(workspace)
      return listWorkspaceDir(root, path ?? '')
    }
  )

  ipcMain.handle(
    'charliecode:workspace:file',
    async (_event, workspace: string, path: string): Promise<WorkspaceFile> => {
      const root = await assertDirectory(workspace)
      return readWorkspaceFile(root, path)
    }
  )

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

  const notifyModelsChanged = (): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('charliecode:models:changed')
    }
  }

  /**
   * One question to the model the app already uses. CLI setup needs it: an
   * unknown CLI says in its own help which command prints its models, and a
   * model reads that far more reliably than a list of spellings.
   */
  const askModel = async (prompt: string): Promise<string> => {
    const { config } = await loadConfig(platform)
    const { models } = await loadCatalog(platform, config)
    const entry = pickDefaultModel(models, config)
    if (!entry) throw new Error('Nessun modello configurato per leggere la CLI.')
    const { text } = await complete(
      {
        modelKey: entry.key,
        messages: [{ role: 'user', content: prompt }],
        maxOutputTokens: 400,
        temperature: 0
      },
      { platform, config, models }
    )
    return text
  }

  const notifyConfigChanged = (): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('charliecode:config:changed')
    }
  }

  /**
   * Persists a patch the agent validated against the catalog of its turn. The
   * config is re-read first, so a change the user made in the drawer during the
   * turn is not overwritten by a stale snapshot.
   */
  const applyAgentConfig = async (
    patch: AppConfigPatch,
    validKeys?: string[]
  ): Promise<{ config: CharlieCodeConfig; path: string; summary: string }> => {
    const { config: current } = await loadConfig(platform)
    const result = applyConfigPatch(current, patch, validKeys)
    const path = await saveConfig(platform, result.config)
    resetProviderCache()
    notifyModelsChanged()
    notifyConfigChanged()
    return {
      config: result.config,
      path,
      summary: result.changes.join('\n')
    }
  }

  const cliStatus = async (): Promise<CliProfilesStatus> => {
    const { config } = await loadConfig(platform)
    const { profiles, errors } = await listCliProfiles(platform)

    const resolved = await Promise.all(
      profiles.map(async (profile) => ({
        profile,
        path:
          findBinary(profile.command, platform.homeDir, config.workspace) ??
          (await resolveBinaryViaShell(profile.command, {
            home: platform.homeDir,
            timeoutMs: 2_000
          }))
      }))
    )

    return {
      profiles: resolved.map(({ profile, path }) => ({
        profile,
        available: Boolean(path),
        ...(path ? { path } : {})
      })),
      errors,
      ...(config.external ? { worker: config.external } : {})
    }
  }

  ipcMain.handle('charliecode:clis:list', () => cliStatus())

  const routingStatus = async (): Promise<RoutingStatus> => {
    const { config } = await loadConfig(platform)
    const routing = await readRouting(config.workspace, platform.homeDir)
    return {
      enabled: routing.enabled,
      roles: Object.entries(routing.roles).flatMap(([role, route]) =>
        route
          ? [
              {
                role,
                modelKey: route.modelKey,
                ...(route.effort ? { effort: route.effort } : {})
              }
            ]
          : []
      ),
      ...(routing.source ? { source: routing.source } : {}),
      ...(routing.error ? { error: routing.error } : {})
    }
  }

  ipcMain.handle('charliecode:routing:status', () => routingStatus())

  ipcMain.handle('charliecode:routing:open', async (): Promise<RoutingStatus> => {
    const { config } = await loadConfig(platform)
    const path = await ensureRoutingFile(config.workspace, platform.homeDir)
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
    return routingStatus()
  })

  ipcMain.handle('charliecode:clis:search', async (_event, query: string) => {
    const { config } = await loadConfig(platform)
    return searchBinaries(query, platform.homeDir, config.workspace)
  })

  ipcMain.handle(
    'charliecode:clis:introspect',
    async (_event, payload: { command?: unknown; args?: unknown }) => {
      if (typeof payload?.command !== 'string' || !payload.command.trim()) {
        throw new Error('Comando mancante.')
      }
      const args = Array.isArray(payload.args)
        ? payload.args.filter((arg): arg is string => typeof arg === 'string').slice(0, 64)
        : []
      const { config } = await loadConfig(platform)
      return introspectCli(payload.command, {
        home: platform.homeDir,
        ...(config.workspace ? { workspace: config.workspace } : {}),
        args
      })
    }
  )

  // One step, one command: the panel sends what the user types in a terminal.
  ipcMain.handle(
    'charliecode:clis:connect',
    async (
      _event,
      payload: { command?: unknown; label?: unknown }
    ): Promise<CliConnectReport> => {
      if (typeof payload?.command !== 'string' || !payload.command.trim()) {
        throw new Error('Scrivi il comando con cui avvii la CLI.')
      }
      const { config } = await loadConfig(platform)
      const report = await connectCli(platform, {
        command: payload.command,
        ...(typeof payload.label === 'string' && payload.label.trim()
          ? { label: payload.label }
          : {}),
        ...(config.workspace ? { workspace: config.workspace } : {}),
        ask: askModel
      })
      notifyModelsChanged()
      return { ...report, status: await cliStatus() }
    }
  )

  ipcMain.handle('charliecode:clis:save', async (_event, input: unknown): Promise<CliProfilesStatus> => {
    await saveCliProfile(platform, input)
    notifyModelsChanged()
    return cliStatus()
  })

  ipcMain.handle('charliecode:clis:delete', async (_event, id: string): Promise<CliProfilesStatus> => {
    await deleteCliProfile(platform, id)
    const { config } = await loadConfig(platform)
    // Removing the profile the worker points at must not leave a dangling id.
    if (config.external?.id === id) {
      const next: CharlieCodeConfig = { ...config }
      delete next.external
      await saveConfig(platform, next)
    }
    notifyModelsChanged()
    return cliStatus()
  })

  ipcMain.handle(
    'charliecode:clis:preview',
    async (_event, payload: CliPreviewPayload): Promise<CliPreview> => {
      const profile = validateCliProfile(payload.profile)
      const { config } = await loadConfig(platform)
      const workspace = config.workspace ?? platform.homeDir
      const argv = buildCliArgs(profile, {
        // A sample prompt, so the panel shows the shape of the command without
        // sending the user's real text anywhere.
        prompt: '<prompt>',
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.plan ? { plan: true } : {}),
        ...(payload.auto ? { auto: true } : {}),
        workspace
      })
      const binary = findBinary(profile.command, platform.homeDir, workspace)

      return {
        command: binary ?? profile.command,
        argv,
        display: `${formatCommand(binary ?? profile.command, argv)}${
          promptOnStdin(profile) ? ' < <prompt>' : ''
        }`,
        promptMode: promptOnStdin(profile) ? 'stdin' : 'arg'
      }
    }
  )

  ipcMain.handle(
    'charliecode:clis:test',
    async (_event, payload: { id: string; model?: string }): Promise<CliTestResult> => {
      const started = Date.now()
      const { config } = await loadConfig(platform)
      const saved = await readCliProfile(platform, payload.id)
      if (!saved) {
        return { ok: false, error: `Profilo "${payload.id}" non trovato.`, ms: 0 }
      }
      // The test is the first place a broken profile shows up: repair it before
      // spawning instead of reporting a failure the user cannot act on.
      const profile = await ensureCliArgs(platform, saved, config.workspace)

      // A test must never touch the project: it runs in an empty temp folder.
      const scratch = await mkdtemp(join(tmpdir(), 'charliecode-cli-test-'))
      try {
        const result = await runExternalAgent(
          profile,
          {
            prompt:
              'Rispondi soltanto con la parola ok. Non leggere file e non eseguire comandi.',
            ...(payload.model ? { model: payload.model } : {}),
            plan: true,
            workspace: scratch
          },
          {
            home: platform.homeDir,
            timeoutMs: profile.timeoutSeconds
              ? Math.min(profile.timeoutSeconds * 1_000, 120_000)
              : 120_000
          }
        )
        const binary = findBinary(profile.command, platform.homeDir, config.workspace)
        return {
          ok: !result.error && result.text.length > 0,
          text: result.text.slice(0, 400),
          ms: Date.now() - started,
          ...(result.error ? { error: result.error } : {}),
          ...(binary ? { command: binary } : {})
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ms: Date.now() - started
        }
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  )

  // A models command loads the whole CLI runtime: the answer is reused for a
  // few minutes so opening the picker does not spawn the CLI again, and ↻
  // (force) asks for a fresh list.
  const MODEL_CACHE_MS = 10 * 60_000

  ipcMain.handle(
    'charliecode:clis:models',
    async (_event, id: string, force?: boolean): Promise<string[]> => {
      const { config } = await loadConfig(platform)
      const saved = await readCliProfile(platform, id)
      if (!saved) return []
      // Opening this list is the moment the CLI becomes the backend: a profile
      // saved without a way to pass the prompt is repaired here, so an existing
      // install works without being deleted and created again.
      const profile = await ensureCliArgs(platform, saved, config.workspace)

      const cache = profile.modelsCache
      const sameArgs =
        (cache?.args ?? []).join('\u0000') === (profile.modelsArgs ?? []).join('\u0000')
      if (!force && cache && sameArgs && Date.now() - Date.parse(cache.at) < MODEL_CACHE_MS) {
        return cache.models
      }

      const models = await profileModels(profile, platform.homeDir, config.workspace)
      if (models.length > 0) {
        await saveCliProfile(platform, {
          ...profile,
          modelsCache: {
            args: [...(profile.modelsArgs ?? [])],
            at: new Date().toISOString(),
            models: models.slice(0, 400)
          }
        }).catch(() => undefined)
        return models
      }

      // A profile saved without a models command (an older connect, a profile
      // written by hand) gets one now: the picker must not stay empty for a CLI
      // that knows how to list its own models.
      const binary =
        findBinary(profile.command, platform.homeDir, config.workspace) ??
        (await resolveBinaryViaShell(profile.command, { home: platform.homeDir }))
      if (!binary) return []

      // The usual spellings first. If none prints a list, the app's own model
      // reads the CLI's help and proposes the command; the proposal is verified
      // by running it, so a wrong guess changes nothing.
      const discovered =
        (await discoverModelCommand(binary, {
          ...(config.workspace ? { workspace: config.workspace } : {})
        })) ??
        (await askModelCommand(binary, askModel, {
          ...(config.workspace ? { workspace: config.workspace } : {})
        }).catch(() => undefined))
      if (!discovered) return []

      await saveCliProfile(platform, {
        ...profile,
        modelsArgs: discovered.args,
        ...(discovered.format ? { modelsFormat: discovered.format } : {}),
        ...(discovered.path ? { modelsPath: discovered.path } : {}),
        modelsCache: {
          args: [...discovered.args],
          at: new Date().toISOString(),
          models: discovered.models.slice(0, 400)
        }
      })
      return discovered.models
    }
  )

  ipcMain.handle(
    'charliecode:clis:set-worker',
    async (_event, worker: ExternalWorkerConfig | null): Promise<CliProfilesStatus> => {
      if (worker?.id) {
        const profile = await readCliProfile(platform, worker.id)
        if (!profile) throw new Error(`Profilo "${worker.id}" non trovato.`)
      }

      const { config } = await loadConfig(platform)
      const next: CharlieCodeConfig = { ...config }
      if (worker?.id) next.external = worker
      else delete next.external
      await saveConfig(platform, next)
      notifyModelsChanged()
      return cliStatus()
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
    await deleteSessionAttachments(platform, id).catch(() => undefined)
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
        ? await materializeModelHistory(platform, toChatHistory(session))
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
        ? await materializeModelHistory(platform, toChatHistory(session))
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
      if (!payload || typeof payload.requestId !== 'string' || typeof payload.text !== 'string') {
        return { ok: false, error: 'Richiesta non valida.' }
      }
      if (inFlight.has(payload.requestId)) {
        return { ok: false, error: 'Richiesta già in corso' }
      }
      if (!payload.text.trim()) {
        return { ok: false, error: 'Il messaggio è vuoto.' }
      }
      // A message without files simply has no `attachments` field: only a
      // malformed value is refused, never a plain text turn.
      if (payload.attachments !== undefined && !Array.isArray(payload.attachments)) {
        return { ok: false, error: 'Allegati non validi.' }
      }
      if (payload.effort && !['none', 'low', 'high', 'max'].includes(payload.effort)) {
        return { ok: false, error: 'Livello di effort non valido.' }
      }
      if (
        payload.maxOutputTokens !== undefined &&
        (!Number.isFinite(payload.maxOutputTokens) || payload.maxOutputTokens <= 0)
      ) {
        return { ok: false, error: 'maxOutputTokens non valido.' }
      }

      const controller = new AbortController()
      inFlight.set(payload.requestId, controller)
      const sender = event.sender

      const { config } = await loadConfig(platform)
      const existing = payload.sessionId ? await readSession(platform, payload.sessionId) : undefined

      // The renderer is untrusted: only projects the user actually opened are
      // accepted, so a remote page (or a bug) cannot point the agent at `~`.
      const allowed = new Set(
        [config.workspace, ...config.recentWorkspaces]
          .filter((entry): entry is string => Boolean(entry))
          .map((entry) => resolve(entry))
      )
      const requestedWorkspace = payload.workspacePath?.trim()
      if (requestedWorkspace && !allowed.has(resolve(requestedWorkspace))) {
        return {
          ok: false,
          error: 'Il progetto richiesto non è tra quelli aperti di recente. Riaprilo dal selettore.'
        }
      }
      const sessionWorkspace =
        existing?.workspacePath && allowed.has(resolve(existing.workspacePath))
          ? existing.workspacePath
          : undefined
      const workspace = requestedWorkspace ?? sessionWorkspace ?? config.workspace
      if (!workspace) {
        return { ok: false, error: 'Apri un progetto prima di inviare un messaggio.' }
      }
      const workspaceInfo = await stat(workspace).catch(() => undefined)
      if (!workspaceInfo?.isDirectory()) {
        return { ok: false, error: `La cartella del progetto non esiste: ${workspace}` }
      }

      const session =
        existing ??
        (await createSession(platform, {
          id: payload.sessionId,
          workspacePath: workspace,
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
        workspacePath: workspace
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
          // Rewriting the whole JSONL every 1.5s was O(n²) on long chats.
          if (at - lastDraftAt < 5_000) return
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

        const emit = (engineEvent: EngineEvent): void => {
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

        try {
          const stored = (await readSession(platform, session.id)) ?? session
          const savedContext = await readAgentContext(platform, session.id)
          // The sidecar is written at the end of a turn, so it never contains
          // the message that opens the next one: append it explicitly.
          const currentUser = await materializeModelHistory(platform, [
            {
              role: 'user',
              content: payload.text,
              ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {})
            }
          ])
          fullHistory =
            savedContext.length > 0
              ? appendCurrentUser(savedContext, currentUser)
              : await materializeModelHistory(platform, toChatHistory(stored))
          const projectContext = await loadProjectContext(platform, workspace)
          const cliTarget = parseCliModelKey(payload.modelKey)
          const cliInfo = await cliStatus()

          if (cliTarget) {
            const savedProfile = cliInfo.profiles.find(
              (entry) => entry.profile.id === cliTarget.profileId
            )?.profile
            // Sending a message must not depend on the picker having been
            // opened first: a profile saved without a way to pass the prompt is
            // repaired here too.
            const profile = savedProfile
              ? await ensureCliArgs(
                  platform,
                  savedProfile,
                  workspace ?? platform.homeDir
                )
              : undefined
            if (!profile) {
              const message = `Il profilo CLI "${cliTarget.profileId}" non esiste più. Scegli un altro backend nel selettore.`
              failure = message
              emit({ type: 'error', message })
            } else {
              // The briefing summarises older turns itself, so it gets the whole
              // transcript instead of the last forty messages.
              const history = await materializeHistory(
                platform,
                toChatHistory(stored, stored.messages.length)
              )
              // Documents are already inlined in the history by
              // `materializeHistory`, and the files live under the app config
              // dir: a CLI sandboxed to the project cannot open those paths, so
              // handing them over only made it answer that the attachments were
              // unavailable. Images are declared in the briefing instead.

              // A CLI backend has no `charliecode_config` tool, but it still
              // needs the architecture to guide the user instead of inventing.
              const cliSystem = [
                projectContext.system,
                selfKnowledgePrompt(config, {
                  platform,
                  modelKey: payload.modelKey,
                  ...(workspace ? { workspace } : {}),
                  cliProfiles: cliInfo.profiles,
                  canApply: false
                })
              ]
                .filter(Boolean)
                .join('\n\n')

              const result = await runCliTurn({
                profile,
                ...(cliTarget.model ? { model: cliTarget.model } : {}),
                ...(payload.effort ? { effort: payload.effort } : {}),
                mode: payload.mode ?? 'build',
                team: payload.team === true,
                prompt: payload.text,
                history,
                system: cliSystem,
                workspace: workspace ?? platform.homeDir,
                home: platform.homeDir,
                stateDir: platform.configDir,
                signal: controller.signal,
                // A team turn spawns several CLI processes: the user sees the
                // plan and can stop it before any of them starts.
                askPermission: (request) => askUser(sender, payload.requestId, request),
                emit
              })

              text = result.text
              aborted = result.aborted
              if (result.error) {
                const message = result.error
                failure = message
                emit({ type: 'error', message })
              }

              // Import the CLI turn into the canonical context: the current
              // user message is already in `fullHistory`, so only the answer
              // is new.
              newMessages = [
                { role: 'assistant' as const, content: text || '(nessuna risposta)' }
              ]
            }
          } else {
            const { models } = await loadCatalog(platform, config)
            // The requested model may be gone (provider removed, model
            // retired, session restored from an older install). Falling back
            // here keeps a stale key from dead-ending the chat.
            const requested = findModel(models, payload.modelKey)
            const activeModel = requested ?? pickDefaultModel(models, config)
            const modelKey = activeModel?.key ?? payload.modelKey
            if (modelKey !== payload.modelKey) {
              usedModel = modelKey
              await updateSession(platform, session.id, { modelKey })
            }

            // The model gets a fitted context; the sidecar keeps the full one.
            // Images are dropped when the active model cannot see them, not
            // left in the request to make the provider answer 400.
            const vision = activeModel?.caps.vision ?? true
            const fitted = vision ? fullHistory : stripImages(fullHistory)
            const budget = contextBudget(activeModel?.caps)
            const history = compactMessages(fitted, { budget }).messages
            const system = buildSystemPrompt(projectContext.system, workspace)
            const routing = await readRouting(workspace, platform.homeDir)

            const result = await runAgent(
              {
                modelKey,
                messages: [],
                system,
                effort: payload.effort,
                maxOutputTokens: Math.min(payload.maxOutputTokens ?? 4096, 32_000),
                signal: controller.signal,
                mode: payload.mode ?? 'build',
                ...(payload.team ? { team: true } : {})
              },
              {
                platform,
                config,
                models,
                cliProfiles: cliInfo.profiles,
                workspace,
                projectContext: projectContext.system,
                modelMessages: history,
                maxSteps: config.agents.maxSteps,
                subagentMaxSteps: config.agents.subagentMaxSteps,
                routing,
                appVersion: app.getVersion(),
                applyConfig: applyAgentConfig,
                askPermission: (request) => askUser(sender, payload.requestId, request),
                emit
              }
            )

            text = result.text
            usedModel = result.modelKey || usedModel
            aborted = result.aborted
            if (result.error) failure = result.error
            if (result.newMessages.length > 0) newMessages = result.newMessages
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
            // Persist the *full* history, not the compacted one the model saw:
            // compaction is a read-time view and must stay reversible. The
            // sidecar is written even when the turn produced no assistant
            // message, so the next turn still starts from the real context.
            const persisted = newMessages ?? []
            if (fullHistory.length > 0 || persisted.length > 0) {
              await writeAgentContext(platform, session.id, [...fullHistory, ...persisted])
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
      inspectProject(platform, await assertWorkspace(workspace))
  )

  ipcMain.handle(
    'charliecode:onboarding:preview',
    async (_event, payload: { workspace: string; answers: OnboardingAnswers }) =>
      planOnboarding(platform, await assertWorkspace(payload.workspace), payload.answers)
  )

  ipcMain.handle(
    'charliecode:onboarding:apply',
    async (
      _event,
      payload: { workspace: string; apply: OnboardingApplyPayload }
    ): Promise<OnboardingResult> => {
      const result = await applyOnboarding(
        platform,
        await assertWorkspace(payload.workspace),
        payload.apply
      )
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
    await skipOnboarding(await assertWorkspace(workspace))
  })

  /* ----------------------------- changes ---------------------------- */

  ipcMain.handle(
    'charliecode:changes:list',
    async (_event, workspace: string): Promise<WorkspaceChanges> => {
      const valid = await assertWorkspace(workspace)
      return listChanges(valid)
    }
  )

  ipcMain.handle(
    'charliecode:changes:init',
    async (_event, workspace: string): Promise<WorkspaceChanges> => {
      const valid = await assertWorkspace(workspace)
      return initRepository(valid)
    }
  )

  ipcMain.handle(
    'charliecode:changes:diff',
    async (_event, payload: { workspace: string; path: string }) => {
      const valid = await assertWorkspace(payload.workspace)
      return changeDiff(valid, payload.path)
    }
  )

  ipcMain.handle(
    'charliecode:changes:revert',
    async (
      _event,
      payload: { workspace: string; change: WorkspaceChange }
    ): Promise<WorkspaceChanges> => {
      const valid = await assertWorkspace(payload.workspace)
      await revertChange(valid, payload.change)
      return listChanges(valid)
    }
  )

  ipcMain.handle(
    'charliecode:file:open',
    async (_event, payload: { workspace: string; path: string }): Promise<void> => {
      const valid = await assertWorkspace(payload.workspace)
      const target = workspacePath(valid, payload.path)
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
