import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { cliModelKey, parseCliModelKey } from '../../shared/cli-key'
import type {
  AttachmentRef,
  CatalogError,
  ContextStats,
  EffortLevel,
  ModelEntry
} from '../../engine/types'
import type {
  AppInfo,
  PluginStatus,
  ProviderStatus,
  SkillInfo,
  RoutersStatus,
  RoutingStatus,
  UpdateStatus
} from '../../shared/ipc'
import { Mascot, MascotDesk, MascotTeam, type MascotMood } from './components/Mascot'
import { Sidebar } from './components/Sidebar'
import { baseName, formatBytes } from './format'
import { useChat } from './hooks/useChat'
import { Markdown } from './components/Markdown'
import { PermissionModal } from './components/PermissionModal'
import { SetupWizard, type SetupPath } from './components/SetupWizard'
import { ProjectWizard } from './components/ProjectWizard'
import { ChangesPanel } from './components/ChangesPanel'
import { WorkbenchPanel } from './components/WorkbenchPanel'
import { ToolActivity } from './components/ToolActivity'
import { UpdateBanner } from './components/UpdateBanner'
import { ThinkingBlock } from './components/ThinkingBlock'
import { ModelPicker } from './components/ModelPicker'
import {
  readSelection,
  withCliModel,
  withModelKey,
  writeSelection,
  type StoredSelection
} from './selection'

const EFFORT_LABEL: Record<EffortLevel, string> = {
  none: 'predefinito',
  low: 'basso',
  high: 'alto',
  max: 'massimo'
}

function shortKey(key: string): string {
  const cli = parseCliModelKey(key)
  if (cli) return cli.model ? `${cli.profileId} · ${cli.model}` : cli.profileId
  return key.length > 46 ? `${key.slice(0, 45)}…` : key
}

/** 8234 → "8.2k", 128000 → "128k": compact, no trailing .0 in a badge. */
function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  const thousands = value / 1000
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`
}

/**
 * The settings drawer has six independent jobs. One long scroll hid the last
 * two behind everything else, so each job is a tab: the drawer shows one
 * section at a time and the tab bar never scrolls away.
 */
type DrawerSection = 'models' | 'plugins' | 'project' | 'skills' | 'permissions' | 'instructions'

const DRAWER_SECTIONS: { id: DrawerSection; label: string }[] = [
  { id: 'models', label: 'Modelli' },
  { id: 'plugins', label: 'Plugin' },
  { id: 'project', label: 'Progetto' },
  { id: 'skills', label: 'Skill' },
  { id: 'permissions', label: 'Permessi' },
  { id: 'instructions', label: 'Istruzioni' }
]

function modelLabel(model: ModelEntry): string {
  const free = /free/i.test(model.id)
  return `${free ? '★ ' : ''}${model.label === model.id ? shortKey(model.id) : model.label}`
}

/**
 * A message header names the backend that produced it. The catalog label is
 * what the picker showed; a model that has since disappeared (retired, or a
 * CLI profile removed) falls back to its key rather than showing nothing.
 */
function messageModelLabel(modelKey: string | undefined, models: ModelEntry[]): string {
  if (!modelKey) return 'assistant'
  const known = models.find((model) => model.key === modelKey)
  return known ? modelLabel(known) : shortKey(modelKey)
}

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [errors, setErrors] = useState<CatalogError[]>([])
  const [loadingModels, setLoadingModels] = useState(true)
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [autoApprove, setAutoApprove] = useState<{ tools: string[]; commands: string[] } | null>(null)
  const [plugins, setPlugins] = useState<PluginStatus[]>([])
  const [setupReport, setSetupReport] = useState<string | null>(null)
  const [setupBusy, setSetupBusy] = useState(false)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillUrl, setSkillUrl] = useState('')
  const [skillTarget, setSkillTarget] = useState<'global' | 'project'>('global')
  const [skillBusy, setSkillBusy] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)
  const [modelKey, setModelKey] = useState<string>('')
  /** What was chosen before the last start; read once, kept up to date below. */
  const [initialSelection] = useState<StoredSelection>(readSelection)
  const selection = useRef<StoredSelection>(initialSelection)
  /** Model passed to the selected CLI, when the backend is a CLI profile. */
  const [cliModel, setCliModel] = useState<string>('')
  const [cliModels, setCliModels] = useState<string[]>([])
  const [cliModelsBusy, setCliModelsBusy] = useState(false)
  /** Bumped by the ↻ next to the CLI model control to re-read the list. */
  const [cliModelsNonce, setCliModelsNonce] = useState(0)
  /** Set by ↻: the next read ignores the list cached in the profile. */
  const cliModelsForce = useRef(false)
  const [preferredModel, setPreferredModel] = useState<string>('')
  const [effort, setEffort] = useState<EffortLevel>('none')
  const [mode, setMode] = useState<'plan' | 'build'>('build')
  const [workspace, setWorkspace] = useState<string | undefined>(undefined)
  const [fatal, setFatal] = useState<string | null>(null)
  /** Download of an update the user accepted at startup, when there is one. */
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  /** Outcome of the drawer's own check; the dialog and the banner are main's. */
  const [updateCheck, setUpdateCheck] = useState<'idle' | 'checking' | 'current' | 'unknown'>(
    'idle'
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Which drawer section is on screen; the drawer is tabbed, not scrolled. */
  const [drawerTab, setDrawerTab] = useState<DrawerSection>('models')
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [newProvider, setNewProvider] = useState({ id: '', label: '', baseUrl: '' })
  const [dragging, setDragging] = useState(false)
  /** Tokens sent to the model, its budget and whether compaction is active. */
  const [context, setContext] = useState<ContextStats | null>(null)
  const [contextBusy, setContextBusy] = useState(false)
  const [contextNotice, setContextNotice] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  /** Section the setup wizard opens on; the drawer's CLI entry asks for `cli`. */
  const [wizardPath, setWizardPath] = useState<SetupPath | undefined>(undefined)
  /** Workspace whose onboarding wizard is open, if any. */
  const [projectWizard, setProjectWizard] = useState<string | null>(null)
  /** Right-hand "what changed" panel, and the count for its badge. */
  const [changesOpen, setChangesOpen] = useState(false)
  /** Right-hand workbench: preview, code and browser. */
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  /** "Squadra": force this turn to be split across task subagents. */
  const [teamMode, setTeamMode] = useState(() => {
    try {
      return window.localStorage.getItem('charliecode.team') === '1'
    } catch {
      return false
    }
  })
  /**
   * A CLI backend splits by itself: it plans the turn and only parallelises
   * independent items, so this is on unless the user turned it off.
   */
  const [cliTeam, setCliTeam] = useState(() => {
    try {
      return window.localStorage.getItem('charliecode.team.cli') !== '0'
    } catch {
      return true
    }
  })
  /** The workshop scene, shown on demand from the sidebar mascot. */
  const [teamPreview, setTeamPreview] = useState(false)
  const [changesCount, setChangesCount] = useState(0)
  const [routers, setRouters] = useState<RoutersStatus | null>(null)
  const [routing, setRouting] = useState<RoutingStatus | null>(null)
  const [newToolDraft, setNewToolDraft] = useState('')
  const [newCommandDraft, setNewCommandDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // What the model picker resolves to, needed by the conversation: the backend
  // key carries the CLI model chosen for this turn, and "Squadra" has its own
  // switch per backend.
  const selectedModel = useMemo(
    () => models.find((model) => model.key === modelKey),
    [models, modelKey]
  )

  const cliBackend = selectedModel?.providerId === 'cli'
  const teamActive = cliBackend ? cliTeam : teamMode

  /** The key actually sent: a CLI can carry a model chosen for this turn. */
  const backendKey =
    selectedModel?.providerId === 'cli' && cliModel
      ? cliModelKey(selectedModel.id, cliModel)
      : modelKey

  /**
   * What the CLI model selector offers. The list the profile cached rides on
   * the catalog entry, so the control is a selector from the first render; a
   * model already chosen stays selectable even when it left the list.
   */
  const cliChoices = useMemo(() => {
    const list = cliModels.length > 0 ? cliModels : selectedModel?.cliModels ?? []
    return cliModel && !list.includes(cliModel) ? [cliModel, ...list] : list
  }, [cliModels, cliModel, selectedModel])

  const {
    sessions,
    sessionId,
    items,
    input,
    setInput,
    streamingId,
    loadingSession,
    attachments,
    attachError,
    showJump,
    setShowJump,
    permission,
    refreshSessions,
    decidePermission,
    startNewChat,
    openSession,
    removeSession,
    renameSession,
    addFiles,
    removeAttachment,
    send,
    stop,
    cancelSubagent,
    retrySubagent
  } = useChat({
    workspace,
    modelKey,
    backendKey,
    effort,
    mode,
    teamActive,
    setWorkspace,
    setInfo,
    setModelKey,
    setCliModel,
    setEffort,
    setFatal
  })

  const refreshProviders = useCallback(async (): Promise<void> => {
    setProviders(await window.charliecode.providers())
  }, [])

  const refreshRouters = useCallback(async (): Promise<void> => {
    try {
      setRouters(await window.charliecode.routers())
    } catch {
      setRouters(null)
    }
  }, [])

  const refreshRouting = useCallback(async (): Promise<void> => {
    try {
      setRouting(await window.charliecode.routing())
    } catch {
      setRouting(null)
    }
  }, [])

  /**
   * The badge answers "how much of the window am I using?". It is refreshed on
   * session change and when a turn ends, not on every token.
   */
  const refreshContext = useCallback(async (): Promise<void> => {
    if (!sessionId) {
      setContext(null)
      return
    }
    try {
      setContext(await window.charliecode.contextStats(sessionId, modelKey || undefined))
    } catch {
      setContext(null)
    }
  }, [modelKey, sessionId])

  const compactContext = useCallback(async (): Promise<void> => {
    if (!sessionId || contextBusy) return
    setContextBusy(true)
    setContextNotice(null)
    const before = context?.tokens ?? 0
    try {
      const next = await window.charliecode.compactContext(sessionId, modelKey || undefined)
      setContext(next)
      setContextNotice(
        `Contesto compattato: ${formatTokens(before)} → ${formatTokens(next.tokens)} token. La chat resta completa.`
      )
      window.setTimeout(() => setContextNotice(null), 7000)
    } catch (cause) {
      setContextNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setContextBusy(false)
    }
  }, [context?.tokens, contextBusy, modelKey, sessionId])

  const refreshAutoApprove = useCallback(async (): Promise<void> => {
    try {
      setAutoApprove(await window.charliecode.autoApprove())
    } catch {
      setAutoApprove(null)
    }
  }, [])

  const refreshPlugins = useCallback(async (): Promise<void> => {
    try {
      setPlugins(await window.charliecode.plugins())
    } catch {
      setPlugins([])
    }
  }, [])

  const refreshSkills = useCallback(async (): Promise<void> => {
    try {
      setSkills(await window.charliecode.skills())
    } catch {
      setSkills([])
    }
  }, [])

  const refreshModels = useCallback(async (): Promise<void> => {
    setLoadingModels(true)
    try {
      const response = await window.charliecode.models()
      setModels(response.models)
      setErrors(response.errors)
      const known = (key: string | undefined): key is string =>
        Boolean(key) && response.models.some((model) => model.key === key)
      const remembered = selection.current.modelKey
      setModelKey((current) => {
        if (known(current)) return current
        // The model picked last time wins over the catalog default.
        if (known(remembered)) return remembered
        const preferred =
          response.models.find((model) => model.key === response.defaultModel) ??
          response.models.find((model) => model.caps.tools) ??
          response.models[0]
        return preferred ? preferred.key : ''
      })
      setPreferredModel(response.defaultModel ?? '')
      setFatal(null)
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingModels(false)
    }
  }, [])

  useEffect(() => {
    void window.charliecode.info().then((value) => {
      setInfo(value)
      setWorkspace(value.workspacePath)
      setEffort(value.effort)
    })
    void refreshModels()
    void refreshProviders()
    void refreshSessions()
    void refreshRouters()
    void refreshRouting()
    void refreshAutoApprove()
    void refreshPlugins()
    void refreshSkills()
  }, [
    refreshModels,
    refreshProviders,
    refreshRouters,
    refreshRouting,
    refreshSessions,
    refreshAutoApprove,
    refreshPlugins,
    refreshSkills
  ])

  // Saving or deleting a CLI profile changes the picker without a reload.
  useEffect(
    () => window.charliecode.onModelsChanged(() => void refreshModels()),
    [refreshModels]
  )

  // The agent can change CharlieCode's own configuration from chat. Reflect it
  // in the drawer without a restart; the running turn keeps its snapshot.
  useEffect(
    () =>
      window.charliecode.onConfigChanged(() => {
        void refreshProviders()
        void refreshModels()
        void refreshPlugins()
        void refreshRouting()
        void refreshAutoApprove()
        void window.charliecode.info().then(setInfo)
      }),
    [refreshProviders, refreshModels, refreshPlugins, refreshRouting, refreshAutoApprove]
  )

  /** Asks the repository again, on the user's terms. */
  const checkUpdates = useCallback(async () => {
    setUpdateCheck('checking')
    const result = await window.charliecode.checkForUpdates()
    setUpdateCheck(
      result.state === 'up-to-date'
        ? 'current'
        : result.state === 'unavailable'
          ? 'unknown'
          : 'idle'
    )
  }, [])

  // A self-update is decided in the main process; here only its progress is
  // shown, so a slow download is visible instead of silent.
  useEffect(() => window.charliecode.onUpdateStatus(setUpdate), [])

  // Only follow the stream when the user is already at the bottom; otherwise
  // reading scrollback would be yanked away on every token.
  const stickToBottom = useRef(true)

  useEffect(() => {
    const node = scrollRef.current
    if (!node || !stickToBottom.current) return
    node.scrollTop = node.scrollHeight
    setShowJump(false)
  }, [items])

  // Esc closes the topmost overlay. The permission prompt is deliberately
  // excluded: it requires an explicit decision.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || permission) return
      if (teamPreview) {
        setTeamPreview(false)
        return
      }
      if (projectWizard) {
        setProjectWizard(null)
        return
      }
      if (wizardOpen) {
        setWizardOpen(false)
        return
      }
      if (settingsOpen) {
        setSettingsOpen(false)
        return
      }
      if (workbenchOpen) {
        setWorkbenchOpen(false)
        return
      }
      if (changesOpen) setChangesOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [permission, teamPreview, projectWizard, wizardOpen, settingsOpen, changesOpen, workbenchOpen])

  // The routing file is edited outside the app: re-read it when the drawer opens.
  useEffect(() => {
    if (settingsOpen) void refreshRouting()
  }, [settingsOpen, refreshRouting])

  // Give the keyboard back as soon as a turn ends.
  useEffect(() => {
    if (!streamingId) inputRef.current?.focus()
  }, [streamingId])

  useEffect(() => {
    void refreshContext()
  }, [refreshContext, streamingId])

  /**
   * The badge in the topbar: a cheap `git status` after every turn and on
   * project switch. The panel itself refreshes on open.
   */
  const refreshChanges = useCallback(async (): Promise<void> => {
    if (!workspace) {
      setChangesCount(0)
      return
    }
    try {
      const data = await window.charliecode.changes(workspace)
      setChangesCount(data.changes.length)
    } catch {
      setChangesCount(0)
    }
  }, [workspace])

  useEffect(() => {
    void refreshChanges()
  }, [refreshChanges, streamingId])

  /**
   * A project with no instructions and no onboarding marker gets the wizard
   * once. It never blocks anything: a failure here is silent, and "non ora"
   * writes the marker so it does not come back.
   */
  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    void (async () => {
      try {
        const facts = await window.charliecode.onboardingFacts(workspace)
        if (!cancelled && facts.needsOnboarding) setProjectWizard(workspace)
      } catch {
        // The wizard is a nicety: a broken scan must not stop the app.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace])

  useEffect(() => {
    try {
      window.localStorage.setItem('charliecode.team', teamMode ? '1' : '0')
    } catch {
      // Preference only.
    }
  }, [teamMode])

  useEffect(() => {
    try {
      window.localStorage.setItem('charliecode.team.cli', cliTeam ? '1' : '0')
    } catch {
      // Preference only.
    }
  }, [cliTeam])

  /**
   * Where the backend changed mid-conversation. The canonical context lives in
   * the session, so the switch is safe; the chip says so instead of leaving the
   * user to wonder whether the new model saw the old turns.
   */
  const handoffIds = useMemo(() => {
    const ids = new Set<string>()
    let previous: string | undefined
    for (const item of items) {
      if (item.role !== 'assistant' || !item.modelKey) continue
      if (previous && previous !== item.modelKey) ids.add(item.id)
      previous = item.modelKey
    }
    return ids
  }, [items])

  // A selection can go stale: the provider is removed, the model is retired,
  // or a restored session points at something this install no longer has. The
  // picker would then show one thing while `modelKey` held another, and every
  // send failed with "non presente nel catalog".
  useEffect(() => {
    if (models.length === 0) return
    if (models.some((model) => model.key === modelKey)) return
    const fallback =
      models.find((model) => model.key === preferredModel) ??
      models.find((model) => model.caps.tools) ??
      models[0]
    if (fallback) setModelKey(fallback.key)
  }, [models, modelKey, preferredModel])

  // A CLI profile has its own model list: load it only when that backend is
  // selected, so startup never spawns a CLI just to fill a menu.
  useEffect(() => {
    const profileId = selectedModel?.providerId === 'cli' ? selectedModel.id : undefined
    if (!profileId) {
      setCliModels([])
      setCliModelsBusy(false)
      return
    }

    let cancelled = false
    // The model this CLI was used with last time comes back with it.
    setCliModel((current) => current || selection.current.cliModels?.[profileId] || '')
    const force = cliModelsForce.current
    cliModelsForce.current = false
    setCliModelsBusy(true)
    void window.charliecode
      .cliProfileModels(profileId, force)
      .then((list) => {
        if (!cancelled) setCliModels(list)
      })
      .catch(() => {
        if (!cancelled) setCliModels([])
      })
      .finally(() => {
        if (!cancelled) setCliModelsBusy(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedModel?.providerId, selectedModel?.id, cliModelsNonce])

  // Remembering the backend is what makes the next start open where this one
  // left off. It is written once per change, not polled.
  useEffect(() => {
    if (!modelKey) return
    const next = withModelKey(selection.current, modelKey)
    selection.current = next
    writeSelection(next)
  }, [modelKey])

  const chooseCliModel = useCallback(
    (model: string): void => {
      setCliModel(model)
      const profileId = selectedModel?.providerId === 'cli' ? selectedModel.id : undefined
      if (!profileId) return
      const next = withCliModel(selection.current, profileId, model)
      selection.current = next
      writeSelection(next)
    },
    [selectedModel]
  )

  // The picker only offers levels the model actually accepts.
  const effortOptions = useMemo<EffortLevel[]>(
    () => (selectedModel?.efforts?.length ? selectedModel.efforts : ['none']),
    [selectedModel]
  )

  useEffect(() => {
    if (!effortOptions.includes(effort)) setEffort(effortOptions[0] ?? 'none')
  }, [effortOptions, effort])

  const mood: MascotMood = permission
    ? 'worried'
    : streamingId
      ? 'thinking'
      : items.length > 0
        ? 'happy'
        : 'idle'

  /** Subagents still running in the current turn, for the workshop scene. */
  const runningSubagents = useMemo(() => {
    if (!streamingId) return []
    const current = items.find((item) => item.requestId === streamingId)
    return (current?.subagents ?? []).filter((run) => run.status === 'running')
  }, [items, streamingId])

  const groupedModels = useMemo(() => {
    const groups = new Map<string, ModelEntry[]>()
    for (const model of models) {
      const list = groups.get(model.providerLabel) ?? []
      list.push(model)
      groups.set(model.providerLabel, list)
    }
    return [...groups.entries()]
  }, [models])

  /** Flat options for the searchable picker; `group` keeps the provider header. */
  const modelOptions = useMemo(
    () =>
      groupedModels.flatMap(([group, entries]) =>
        entries.map((model) => ({ key: model.key, label: modelLabel(model), group }))
      ),
    [groupedModels]
  )

  // Three shortcuts cover how the app is actually driven: a new chat, finding
  // an old one, and the settings drawer. Enter already sends.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'n') {
        event.preventDefault()
        startNewChat()
      } else if (key === 'k') {
        event.preventDefault()
        document.getElementById('session-search')?.focus()
      } else if (key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [startNewChat])

  /** Projects in the sidebar: the open one first, then the recent ones. */
  const projects = useMemo(() => {
    const list = [workspace, ...(info?.recentWorkspaces ?? [])].filter(
      (entry): entry is string => Boolean(entry)
    )
    return list.filter((entry, index) => list.indexOf(entry) === index)
  }, [workspace, info?.recentWorkspaces])

  const switchProject = useCallback(
    async (path: string): Promise<void> => {
      if (path === workspace) return
      try {
        const result = await window.charliecode.useWorkspace(path)
        if (!result.path) return
        setWorkspace(result.path)
        startNewChat()
        await refreshSessions()
        setInfo(await window.charliecode.info())
      } catch (cause) {
        setFatal(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [workspace, startNewChat, refreshSessions]
  )

  const pickWorkspace = useCallback(async (): Promise<void> => {
    const result = await window.charliecode.pickWorkspace()
    const picked = result.path
    if (!picked) return
    setWorkspace(picked)
    // A new project starts a new chat: keeping the previous one open would
    // write its next message into a folder you just left.
    startNewChat()
    setInfo((current) =>
      current
        ? {
            ...current,
            workspacePath: picked,
            recentWorkspaces: [
              picked,
              ...current.recentWorkspaces.filter((entry) => entry !== picked)
            ].slice(0, 8)
          }
        : current
    )
    await refreshSessions()
  }, [refreshSessions, startNewChat])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const saveKey = useCallback(
    async (providerId: string): Promise<void> => {
      const value = keyDrafts[providerId] ?? ''
      const statuses = await window.charliecode.setProviderKey(providerId, value)
      setProviders(statuses)
      setKeyDrafts((previous) => ({ ...previous, [providerId]: '' }))
      await refreshModels()
    },
    [keyDrafts, refreshModels]
  )

  const toggleProvider = useCallback(
    async (providerId: string, enabled: boolean): Promise<void> => {
      setProviders(await window.charliecode.toggleProvider(providerId, enabled))
      await refreshModels()
    },
    [refreshModels]
  )

  const toggleShowAllModels = useCallback(
    async (providerId: string, showAll: boolean): Promise<void> => {
      setProviders(await window.charliecode.setProviderShowAllModels(providerId, showAll))
      await refreshModels()
    },
    [refreshModels]
  )

  const togglePlugin = useCallback(async (id: string, enabled: boolean): Promise<void> => {
    setPlugins(await window.charliecode.setPluginEnabled(id, enabled))
  }, [])

  const runSetupAdvisor = useCallback(async (): Promise<void> => {
    setSetupBusy(true)
    try {
      setSetupReport(await window.charliecode.suggestSetup())
    } catch (error) {
      setSetupReport(error instanceof Error ? error.message : String(error))
    } finally {
      setSetupBusy(false)
    }
  }, [])

  const installSkill = useCallback(async (): Promise<void> => {
    const url = skillUrl.trim()
    if (!url) return
    setSkillBusy(true)
    setSkillError(null)
    try {
      setSkills(await window.charliecode.installSkill({ url, target: skillTarget }))
      setSkillUrl('')
    } catch (error) {
      setSkillError(error instanceof Error ? error.message : String(error))
    } finally {
      setSkillBusy(false)
    }
  }, [skillTarget, skillUrl])

  const uninstallSkill = useCallback(
    async (skill: SkillInfo): Promise<void> => {
      if (!window.confirm(`Rimuovere la skill "${skill.name}"?`)) return
      try {
        setSkills(await window.charliecode.removeSkill({ dir: skill.dir, source: skill.source }))
      } catch (error) {
        setSkillError(error instanceof Error ? error.message : String(error))
      }
    },
    []
  )

  const addProvider = useCallback(async (): Promise<void> => {
    const { id, label, baseUrl } = newProvider
    if (!id.trim() || !baseUrl.trim()) return
    setProviders(
      await window.charliecode.addProvider({
        id: id.trim(),
        label: label.trim() || id.trim(),
        baseUrl: baseUrl.trim(),
        kind: 'direct'
      })
    )
    setNewProvider({ id: '', label: '', baseUrl: '' })
    await refreshModels()
  }, [newProvider, refreshModels])

  const needsSetup = models.length === 0 && !loadingModels

  /** Free providers the user has not configured yet: the honest "what now?" list. */
  const freeWithoutKey = useMemo(
    () => providers.filter((provider) => provider.free && !provider.hasKey),
    [providers]
  )

  const wizardSetKey = useCallback(
    async (providerId: string, key: string): Promise<void> => {
      setProviders(await window.charliecode.setProviderKey(providerId, key))
      await refreshModels()
    },
    [refreshModels]
  )

  const wizardToggle = useCallback(
    async (providerId: string, enabled: boolean): Promise<void> => {
      setProviders(await window.charliecode.toggleProvider(providerId, enabled))
      await refreshModels()
    },
    [refreshModels]
  )

  const wizardAddProvider = useCallback(
    async (payload: {
      id: string
      label: string
      baseUrl: string
      kind: 'direct' | 'router'
    }): Promise<void> => {
      setProviders(await window.charliecode.addProvider(payload))
      await refreshModels()
    },
    [refreshModels]
  )

  const addAutoApprove = useCallback(
    async (tool?: string, command?: boolean): Promise<void> => {
      const entry = (tool ?? '').trim()
      if (!entry) return
      const next = await window.charliecode.setAutoApprove({
        tool: command ? undefined : entry,
        command: command ? entry : undefined
      })
      setAutoApprove(next)
    },
    []
  )

  const removeAutoApprove = useCallback(
    async (entry: string, command?: boolean): Promise<void> => {
      const next = await window.charliecode.setAutoApprove({
        tool: command ? undefined : entry,
        command: command ? entry : undefined,
        remove: true
      })
      setAutoApprove(next)
    },
    []
  )

  return (
    <div className={`app ${info?.platform === 'darwin' ? 'darwin' : ''}`}>
      <Sidebar
        info={info}
        {...(workspace ? { workspace } : {})}
        projects={projects}
        sessions={sessions}
        sessionId={sessionId}
        providers={providers}
        routers={routers}
        mood={mood}
        onTeamPreview={() => setTeamPreview(true)}
        onNewProject={() => void pickWorkspace()}
        onSwitchProject={(path) => void switchProject(path)}
        onNewChat={startNewChat}
        onOpenSession={(id) => void openSession(id)}
        onRenameSession={(id, title) => void renameSession(id, title)}
        onRemoveSession={(id) => void removeSession(id)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="main">
        <header className="topbar">
          <div className="controls">
            <ModelPicker
              options={modelOptions}
              value={modelKey}
              onChange={(key) => {
                setModelKey(key)
                setCliModel('')
              }}
              disabled={models.length === 0}
              title={selectedModel?.key ?? ''}
            />

            {selectedModel?.providerId === 'cli' && (
              <div className="cli-model-field">
                {cliChoices.length > 0 ? (
                  <select
                    className="select cli-model-select"
                    value={cliModel}
                    onChange={(event) => chooseCliModel(event.target.value)}
                    disabled={cliModelsBusy}
                    title="Modello passato alla CLI scelta"
                    aria-label="Modello della CLI"
                  >
                    <option value="">modello della CLI (predefinito)</option>
                    {cliChoices.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : (
                  // A CLI that cannot list its models still accepts a name: never
                  // leave the user without a way to choose one.
                  <input
                    className="select cli-model-input"
                    value={cliModel}
                    onChange={(event) => chooseCliModel(event.target.value)}
                    placeholder={cliModelsBusy ? 'carico modelli…' : 'modello (vuoto = predefinito)'}
                    title="Modello passato alla CLI: scrivilo se la CLI non elenca i suoi modelli"
                    aria-label="Modello della CLI"
                    readOnly={cliModelsBusy}
                  />
                )}
                <button
                  className="ghost"
                  onClick={() => {
                    cliModelsForce.current = true
                    setCliModelsNonce((value) => value + 1)
                  }}
                  disabled={cliModelsBusy}
                  title="Rileggi i modelli dalla CLI"
                  aria-label="Rileggi i modelli dalla CLI"
                >
                  {cliModelsBusy ? '…' : '↻'}
                </button>
              </div>
            )}

            <select
              className="select effort-select"
              value={effort}
              onChange={(event) => setEffort(event.target.value as EffortLevel)}
              title="Livello di effort (reasoning) passato al provider"
              disabled={effortOptions.length <= 1}
            >
              {effortOptions.map((level) => (
                <option key={level} value={level}>
                  ragionamento: {EFFORT_LABEL[level]}
                </option>
              ))}
            </select>

            <button
              className="ghost"
              onClick={() => void refreshModels()}
              disabled={loadingModels}
              title="Ricarica l’elenco dei modelli"
              aria-label="Ricarica l’elenco dei modelli"
            >
              {loadingModels ? '…' : '↻'}
            </button>

            <button
              className={`ghost small team-toggle ${teamActive ? 'active' : ''}`}
              onClick={() => {
                if (cliBackend) setCliTeam((value) => !value)
                else setTeamMode((value) => !value)
              }}
              title={
                cliBackend
                  ? 'Squadra: la CLI pianifica, i lavori indipendenti girano in parallelo e lei integra. Se il lavoro è uno solo resta un agente.'
                  : 'Divide il turno tra subagenti in parallelo: Charlie supervisiona, loro lavorano'
              }
              aria-pressed={teamActive}
            >
              {cliBackend ? 'Squadra auto' : 'Squadra'}
            </button>

            <div className="mode-switch" role="group" aria-label="Modalità dell'agente">
              <button
                className={`mode-option ${mode === 'plan' ? 'active' : ''}`}
                onClick={() => setMode('plan')}
                title="Sola lettura: esplora e propone un piano, senza modificare file"
              >
                Piano
              </button>
              <button
                className={`mode-option ${mode === 'build' ? 'active' : ''}`}
                onClick={() => setMode('build')}
                title="L'agente può scrivere file ed eseguire comandi"
              >
                Build
              </button>
            </div>
          </div>

          <div className="topbar-right">
            {workspace && (
              <button
                className={`ghost small workbench-toggle ${workbenchOpen ? 'active' : ''}`}
                onClick={() => {
                  setWorkbenchOpen((open) => !open)
                  setChangesOpen(false)
                }}
                title="Anteprima, codice e browser, accanto alla chat"
                aria-pressed={workbenchOpen}
              >
                ◫ Pannello
              </button>
            )}
            {workspace && (
              <button
                className={`ghost small changes-toggle ${changesOpen ? 'active' : ''}`}
                onClick={() => {
                  setChangesOpen((open) => !open)
                  setWorkbenchOpen(false)
                }}
                title="Cosa è cambiato nel progetto (git)"
              >
                Modifiche
                {changesCount > 0 && <span className="changes-count">{changesCount}</span>}
              </button>
            )}
            {workspace && (
              <button
                className="ghost small"
                onClick={() => void window.charliecode.openWorkspace()}
                title={workspace}
              >
                {baseName(workspace)}
              </button>
            )}
          </div>
        </header>

        {errors.length > 0 && (
          <div className="banner warn">
            <button
              className="banner-close"
              onClick={() => setErrors([])}
              title="Chiudi avvisi"
              aria-label="Chiudi avvisi"
            >
              ✕
            </button>
            {errors.map((error) => (
              <div key={error.providerId}>
                <strong>{error.providerLabel}</strong>: {error.message}
              </div>
            ))}
          </div>
        )}

        {update && <UpdateBanner status={update} onDismiss={() => setUpdate(null)} />}

        {fatal && (
          <div className="banner error">
            <button
              className="banner-close"
              onClick={() => setFatal(null)}
              title="Chiudi"
              aria-label="Chiudi l’errore"
            >
              ✕
            </button>
            {fatal}
          </div>
        )}

        {info?.configRecovered && (
          <div className="banner warn">
            Config non valida: ho salvato un backup in <code>{info.configRecovered}</code> e sono
            ripartito dai default.
          </div>
        )}

        <main
          className="scroll"
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget
            const distance = node.scrollHeight - node.scrollTop - node.clientHeight
            stickToBottom.current = distance < 90
            setShowJump(distance >= 90)
          }}
        >
          {needsSetup ? (
            <section className="setup">
              <Mascot size={120} mood="worried" className="setup-mascot" />
              <h1>Nessun modello disponibile</h1>
              <p>
                CharlieCode parla con qualsiasi endpoint OpenAI-compatible. Apri la procedura
                guidata: ti collega a un modello gratuito in meno di un minuto.
              </p>
              <div className="setup-actions">
                <button
                  className="primary"
                  onClick={() => {
                    setWizardPath(undefined)
                    setWizardOpen(true)
                  }}
                >
                  ✦ Collega un modello
                </button>
                <button className="ghost" onClick={() => setSettingsOpen(true)}>
                  Preferisco inserire la key a mano
                </button>
              </div>
              {freeWithoutKey.length > 0 && (
                <div className="free-hint">
                  <span className="muted small">Tier gratuiti, senza carta di credito:</span>
                  <div className="free-hint-list">
                    {freeWithoutKey.slice(0, 5).map((provider) => (
                      <button
                        key={provider.id}
                        className="free-chip"
                        // Opening the browser from a chip was a surprise: it now
                        // just shows the provider, whose "come ottenere la key"
                        // link is one click away.
                        onClick={() => setSettingsOpen(true)}
                        title={
                          provider.docs
                            ? `${provider.label} · la key si crea su ${provider.docs}`
                            : provider.baseUrl
                        }
                      >
                        {provider.label}
                      </button>
                    ))}
                  </div>
                  <span className="muted small">
                    Ogni provider si accende con il suo interruttore, e la key resta in{' '}
                    <code>~/.charliecode/credentials.json</code>.
                  </span>
                </div>
              )}
            </section>
          ) : items.length === 0 ? (
            <section className="empty">
              <Mascot size={140} mood={mood} className="empty-mascot" />
              <h1>{workspace ? baseName(workspace) : 'Ciao, sono Charlie.'}</h1>
              <p className="muted">
                {models.length} modelli · {sessions.length} chat salvate
                {workspace ? '' : ' · nessun progetto selezionato'}
              </p>
              <p className="empty-lead">
                Posso leggere, cercare, modificare ed eseguire comandi nel progetto — e mostrarti
                ogni diff prima di applicarlo. Per lavori grandi lancio subagenti in parallelo.
              </p>
              <div className="hints">
                <button onClick={() => void pickWorkspace()}>
                  {workspace ? 'Apri un’altra cartella' : 'Scegli un progetto'}
                </button>
                <button
                  onClick={() =>
                    void send(
                      'Esplora questo progetto: leggi AGENTS.md e il package.json, poi spiegami com’è organizzato.'
                    )
                  }
                >
                  Esplora il progetto
                </button>
                <button
                  onClick={() =>
                    void send(
                      'Usa un subagente explorer per trovare dove viene gestita l’autenticazione.'
                    )
                  }
                >
                  Prova un subagente
                </button>
              </div>
            </section>
          ) : (
            <div className="messages">
              {items.map((item) => (
                <article key={item.id} className={`message ${item.role}`}>
                  <div className="message-head">
                    <span className="role">
                      {item.role === 'user'
                        ? 'tu'
                        : messageModelLabel(item.modelKey, models)}
                    </span>
                    {handoffIds.has(item.id) && (
                      <span
                        className="handoff-chip"
                        title="Hai cambiato backend: la conversazione e il progetto sono gli stessi"
                      >
                        ↪ contesto condiviso
                      </span>
                    )}
                    {item.pending && <span className="pulse">sta scrivendo</span>}
                  </div>
                  {(item.attachments?.length ?? 0) > 0 && (
                    <div className="message-attachments">
                      {item.attachments?.map((attachment: AttachmentRef) => (
                        <span key={attachment.id} className={`chip static ${attachment.kind}`}>
                          <span className="chip-icon">{attachment.kind === 'image' ? '▧' : '▤'}</span>
                          <span className="chip-body">
                            <span className="chip-name">{attachment.name}</span>
                            <span className="chip-size">{formatBytes(attachment.size)}</span>
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                  {item.role === 'assistant' && (item.thinking ?? '').trim().length > 0 && (
                    <ThinkingBlock text={item.thinking ?? ''} live={Boolean(item.pending)} />
                  )}
                  {item.role === 'assistant' && item.content ? (
                    <div className="message-body assistant">
                      <Markdown text={item.content} />
                    </div>
                  ) : (
                    <div className="message-body">
                      {item.content || (item.pending || (item.attachments?.length ?? 0) > 0 ? '' : '—')}
                    </div>
                  )}
                  {item.role === 'assistant' && (
                    <ToolActivity
                      logs={item.tools ?? []}
                      subagents={item.subagents ?? []}
                      busy={Boolean(item.pending)}
                      onCancel={(agentId) => cancelSubagent(item.requestId, agentId)}
                      onRetry={
                        item.pending
                          ? (agentId) => retrySubagent(item.requestId, agentId)
                          : undefined
                      }
                    />
                  )}
                  {item.role === 'assistant' &&
                    item.mode === 'plan' &&
                    !item.pending &&
                    !streamingId &&
                    item.content.trim().length > 0 && (
                      <div className="plan-actions">
                        <button
                          className="primary small"
                          onClick={() => {
                            setMode('build')
                            void send(
                              'Il piano qui sopra va bene: implementalo ora. Applica le modifiche una alla volta e verifica con test/build quando possibile.',
                              'build'
                            )
                          }}
                        >
                          ▶ Esegui il piano
                        </button>
                        <span className="muted small">passa in Build e applica le modifiche</span>
                      </div>
                    )}
                  {item.error && <div className="message-error">{item.error}</div>}
                  {item.meta && <div className="message-meta">{item.meta}</div>}
                </article>
              ))}
            </div>
          )}

          {streamingId && (
            <div className="working-wrap">
              <div className={`working-badge ${runningSubagents.length > 0 ? 'with-team' : ''}`}>
                {runningSubagents.length > 0 ? (
                  <MascotTeam
                    width={runningSubagents.length > 1 ? 320 : 240}
                    members={runningSubagents.map((run) => ({
                      id: run.agentId,
                      label: run.description
                    }))}
                  />
                ) : (
                  <MascotDesk width={118} mood="thinking" />
                )}
                <div className="working-text">
                  <strong>
                    {runningSubagents.length > 0
                      ? `Charlie supervisiona ${runningSubagents.length} subagent${runningSubagents.length === 1 ? 'e' : 'i'}`
                      : 'Charlie sta lavorando'}
                  </strong>
                  <span>
                    {runningSubagents.length > 0
                      ? runningSubagents.map((run) => run.name).join(' · ')
                      : 'strumenti, diff e subagenti in corso…'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </main>

        {showJump && (
          <button
            className="jump-bottom"
            onClick={() => {
              stickToBottom.current = true
              setShowJump(false)
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
            }}
            title="Torna all'ultimo messaggio"
            aria-label="Torna all'ultimo messaggio"
          >
            ↓
          </button>
        )}

        <footer
          className={`composer ${dragging ? 'dragging' : ''}`}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node)) return
            setDragging(false)
          }}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            void addFiles([...event.dataTransfer.files])
          }}
        >
          {attachments.length > 0 && (
            <div className="attachment-chips">
              {attachments.map((item) => (
                <div key={item.localId} className={`chip ${item.kind}`}>
                  {item.kind === 'image' ? (
                    <img className="chip-thumb" src={item.data} alt={item.name} />
                  ) : (
                    <span className="chip-icon">▤</span>
                  )}
                  <span className="chip-body">
                    <span className="chip-name">{item.name}</span>
                    <span className="chip-size">{formatBytes(item.size)}</span>
                  </span>
                  <button
                    className="chip-remove"
                    title="Rimuovi allegato"
                    onClick={() => removeAttachment(item.localId)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {attachError && <div className="composer-error">{attachError}</div>}

          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const files = [...event.clipboardData.files]
              if (files.length > 0) {
                event.preventDefault()
                void addFiles(files)
              }
            }}
            placeholder={
              modelKey
                ? 'Scrivi un messaggio…  (Enter invia, Shift+Enter va a capo, trascina file o incolla immagini)'
                : 'Seleziona un modello…'
            }
            rows={3}
            disabled={!modelKey || loadingSession}
          />
          {(context || contextNotice) && (
            <div className="composer-context">
              {context && (
                <span
                  className={`ctx-badge ${context.compacted ? 'compacted' : ''}`}
                  title={`Il prossimo turno invia ${context.tokens} token su un budget di ${context.budget}. Contesto salvato: ${context.totalTokens} token in ${context.messages} messaggi.`}
                >
                  contesto {formatTokens(context.tokens)} / {formatTokens(context.budget)}
                  {context.compacted ? ` · da ${formatTokens(context.totalTokens)}` : ''}
                </span>
              )}
              {context?.compacted && (
                <button
                  className="ghost small"
                  onClick={() => void compactContext()}
                  disabled={contextBusy}
                  title="Sostituisce il contesto salvato con un riepilogo dei turni più vecchi. La chat e i file restano completi."
                >
                  {contextBusy ? 'Compatto…' : 'Compatta'}
                </button>
              )}
              {contextNotice && <span className="ctx-notice">{contextNotice}</span>}
            </div>
          )}
          <div className="composer-actions">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void addFiles([...(event.target.files ?? [])])
                event.target.value = ''
              }}
            />
            <button
              className="ghost attach-button"
              title="Allega immagini o documenti"
              onClick={() => fileInputRef.current?.click()}
              disabled={!modelKey || loadingSession}
            >
              + Allega
            </button>
            <span className="muted small">
              {selectedModel
                ? `${selectedModel.caps.tools ? 'strumenti' : 'senza strumenti'} · ${
                    selectedModel.caps.vision ? 'immagini' : 'solo testo'
                  } · ${Math.round(selectedModel.caps.contextWindow / 1024)}k contesto`
                : 'nessun modello'}
            </span>
            {streamingId ? (
              <button className="danger" onClick={() => void stop()}>
                Stop
              </button>
            ) : (
              <button
                className="primary"
                onClick={() => void send()}
                disabled={(!input.trim() && attachments.length === 0) || !modelKey}
              >
                Invia
              </button>
            )}
          </div>
        </footer>
      </div>

      {permission && (
        <PermissionModal request={permission.request} onDecide={(decision) => void decidePermission(decision)} />
      )}

      {wizardOpen && (
        <SetupWizard
          providers={providers}
          onSetKey={wizardSetKey}
          onToggleProvider={wizardToggle}
          onAddProvider={wizardAddProvider}
          {...(wizardPath ? { initialPath: wizardPath } : {})}
          onClose={() => {
            setWizardOpen(false)
            setWizardPath(undefined)
            void refreshRouters()
          }}
        />
      )}

      {teamPreview && (
        <div className="overlay team-overlay" onClick={() => setTeamPreview(false)}>
          <div className="team-preview" onClick={(event) => event.stopPropagation()}>
            <div className="team-preview-head">
              <div>
                <h2>La squadra di Charlie</h2>
                <p className="muted small">
                  Compare quando l’agente delega con <code>task</code>: Charlie in piedi
                  supervisiona, i subagenti scrivono al computer. Con «Squadra» attivo lo chiedi a
                  ogni turno.
                </p>
              </div>
              <button className="ghost small" onClick={() => setTeamPreview(false)}>
                ✕
              </button>
            </div>
            <MascotTeam
              width={720}
              members={[
                { id: 'demo-1', label: 'esplora' },
                { id: 'demo-2', label: 'implementa' },
                { id: 'demo-3', label: 'verifica' },
                { id: 'demo-4', label: 'documenta' }
              ]}
            />
            <div className="team-preview-foot">
              <span className="muted small">
                Un subagente = un contesto separato: legge, lavora e riporta. Charlie integra.
              </span>
              <button
                className="primary"
                onClick={() => {
                  setTeamMode(true)
                  setTeamPreview(false)
                }}
              >
                Attiva Squadra
              </button>
            </div>
          </div>
        </div>
      )}

      {changesOpen && workspace && (
        <ChangesPanel workspace={workspace} onClose={() => setChangesOpen(false)} />
      )}

      {workbenchOpen && workspace && (
        <WorkbenchPanel workspace={workspace} onClose={() => setWorkbenchOpen(false)} />
      )}

      {projectWizard && (
        <ProjectWizard
          workspace={projectWizard}
          onClose={() => setProjectWizard(null)}
          onApplied={async () => {
            await refreshSkills()
            await refreshPlugins()
          }}
        />
      )}

      {settingsOpen && (
        <div className="overlay" onClick={() => setSettingsOpen(false)}>
          <div className="drawer" ref={drawerRef} onClick={(event) => event.stopPropagation()}>
            <div className="drawer-head">
              <h2>Impostazioni</h2>
              <button className="ghost" onClick={() => setSettingsOpen(false)}>
                ✕
              </button>
            </div>

            <nav className="drawer-tabs" role="tablist" aria-label="Sezioni delle impostazioni">
              {DRAWER_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  role="tab"
                  aria-selected={drawerTab === section.id}
                  className={`drawer-tab ${drawerTab === section.id ? 'active' : ''}`}
                  onClick={() => {
                    setDrawerTab(section.id)
                    drawerRef.current?.scrollTo({ top: 0 })
                  }}
                >
                  {section.label}
                </button>
              ))}
            </nav>

            {drawerTab === 'models' && (
              <>
            <h3 id="set-models">Modelli</h3>
            <p className="muted small">
              Le chiavi finiscono in <code>{info?.credentialsPath ?? '~/.charliecode/credentials.json'}</code>{' '}
              con permessi 600. Vengono usate solo verso il provider a cui appartengono.
            </p>

            <p className="muted small">
              CharlieCode conosce la propria architettura: in chat puoi chiedere «configura CharlieCode
              per …» e l’agente legge la configurazione, propone la modifica e mostra il diff prima di
              applicarla. Le chiavi API restano fuori: le imposti solo tu, qui.
            </p>

            <div className="provider-list">
              {providers.map((provider) => (
                <div key={provider.id} className="provider">
                  <div className="provider-head">
                    <label className="provider-toggle">
                      <input
                        type="checkbox"
                        checked={provider.enabled}
                        onChange={(event) => void toggleProvider(provider.id, event.target.checked)}
                      />
                      <span className="provider-label">{provider.label}</span>
                      {provider.free && <span className="provider-badge">gratis</span>}
                    </label>
                    <span className={`key-state ${provider.hasKey ? 'ok' : 'warn'}`}>
                      {provider.hasKey ? `key ${provider.keyHint}` : 'nessuna key'}
                    </span>
                  </div>
                  <div className="provider-url">
                    {provider.baseUrl}
                    {provider.docs && (
                      <button
                        className="link-button"
                        onClick={() => void window.charliecode.openExternal(provider.docs as string)}
                      >
                        come ottenere la key
                      </button>
                    )}
                  </div>
                  {provider.kind === 'router' && (
                    <label className="provider-toggle small-toggle">
                      <input
                        type="checkbox"
                        checked={provider.showAllModels}
                        onChange={(event) =>
                          void toggleShowAllModels(provider.id, event.target.checked)
                        }
                      />
                      <span>mostra tutti i modelli del router (di default ne basta uno)</span>
                    </label>
                  )}
                  <div className="provider-key">
                    <input
                      type="password"
                      placeholder={provider.hasKey ? 'sostituisci la key…' : 'incolla la API key…'}
                      value={keyDrafts[provider.id] ?? ''}
                      onChange={(event) =>
                        setKeyDrafts((previous) => ({
                          ...previous,
                          [provider.id]: event.target.value
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveKey(provider.id)
                      }}
                    />
                    <button
                      className="ghost"
                      onClick={() => void saveKey(provider.id)}
                      disabled={!keyDrafts[provider.id]?.trim()}
                    >
                      Salva
                    </button>
                    {provider.hasKey && (
                      <button
                        className="ghost danger-text"
                        title="Rimuovi la key salvata"
                        onClick={() => {
                          setKeyDrafts((previous) => ({ ...previous, [provider.id]: '' }))
                          void window.charliecode
                            .setProviderKey(provider.id, '')
                            .then(setProviders)
                            .then(() => refreshModels())
                        }}
                      >
                        Rimuovi
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <h3>Aggiungi un provider</h3>
            <p className="muted small">
              Qualsiasi endpoint OpenAI-compatible: LM Studio, Ollama, vLLM, un gateway aziendale,
              OpenRouter, OpenAI…
            </p>
            <div className="add-provider">
              <input
                placeholder="id (es. lmstudio)"
                value={newProvider.id}
                onChange={(event) => setNewProvider({ ...newProvider, id: event.target.value })}
              />
              <input
                placeholder="nome (es. LM Studio)"
                value={newProvider.label}
                onChange={(event) => setNewProvider({ ...newProvider, label: event.target.value })}
              />
              <input
                placeholder="base URL (es. http://localhost:1234/v1)"
                value={newProvider.baseUrl}
                onChange={(event) => setNewProvider({ ...newProvider, baseUrl: event.target.value })}
              />
              <button
                className="primary"
                onClick={() => void addProvider()}
                disabled={!newProvider.id.trim() || !newProvider.baseUrl.trim()}
              >
                Aggiungi
              </button>
            </div>

            <h3 id="set-cli">CLI esterne</h3>
            <p className="muted small">
              Una CLI già installata è un backend come gli altri. Scrivi il comando con cui la
              avvii — <code>opencode</code>, <code>axet-code</code>, il tuo script — e CharlieCode
              legge il suo aiuto, trova i modelli e la mette nel selettore: nessuna chiave da
              incollare.
            </p>
            <div className="setup-actions">
              <button
                className="ghost"
                onClick={() => {
                  setWizardPath('cli')
                  setSettingsOpen(false)
                  setWizardOpen(true)
                }}
              >
                Collega una CLI
              </button>
            </div>
              </>
            )}

            {drawerTab === 'plugins' && (
              <>
            <h3 id="set-plugins">Plugin</h3>
            <p className="muted small">
              Arrivano già installati con l’app: ognuno aggiunge qualcosa all’agente e si
              accende o spegne da qui. Se li spegni, spariscono anche i loro tool.
            </p>
            <div className="plugins">
              {plugins.map((plugin) => (
                <div key={plugin.id} className={`plugin ${plugin.enabled ? 'on' : 'off'}`}>
                  <div className="plugin-head">
                    <div className="plugin-title">
                      <div className="plugin-name">{plugin.name}</div>
                      <div className="plugin-tagline">{plugin.tagline}</div>
                    </div>
                    <label className="switch" title={plugin.enabled ? 'Attivo' : 'Spento'}>
                      <input
                        type="checkbox"
                        checked={plugin.enabled}
                        onChange={(event) => void togglePlugin(plugin.id, event.target.checked)}
                      />
                      <span className="switch-track">
                        <span className="switch-thumb" />
                      </span>
                    </label>
                  </div>
                  <p className="plugin-desc">{plugin.description}</p>
                  <div className="plugin-tools">
                    {plugin.tools.map((tool) => (
                      <code key={tool}>{tool}</code>
                    ))}
                  </div>
                </div>
              ))}
              {plugins.length === 0 && <p className="muted small">Nessun plugin disponibile.</p>}
            </div>
              </>
            )}

            {drawerTab === 'project' && (
              <>
            <h3 id="set-project">Progetto</h3>
            <div className="setup-actions">
              <button
                className="ghost"
                onClick={() => void window.charliecode.openProjectMemory()}
                disabled={!workspace}
                title={workspace ? 'Apre .charliecode/memory.md' : 'Apri prima un progetto'}
              >
                Apri memoria del progetto
              </button>
              <button
                className="ghost"
                onClick={() => void runSetupAdvisor()}
                disabled={setupBusy || !workspace}
              >
                {setupBusy ? 'Analizzo…' : 'Consigli di setup'}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  if (!workspace) return
                  setSettingsOpen(false)
                  setProjectWizard(workspace)
                }}
                disabled={!workspace}
                title={
                  workspace
                    ? 'Riapre il wizard: AGENTS.md e skill del progetto'
                    : 'Apri prima un progetto'
                }
              >
                Configura progetto
              </button>
            </div>
            {setupReport && (
              <div className="setup-report">
                <div className="setup-report-head">
                  <span>Analisi del progetto</span>
                  <button className="ghost small" onClick={() => setSetupReport(null)}>
                    chiudi
                  </button>
                </div>
                <Markdown text={setupReport} />
              </div>
            )}

            <h3 id="set-routing">Routing dei subagenti</h3>
            <p className="muted small">
              Opzionale: <code>explorer</code>, <code>reviewer</code> e <code>implementer</code>{' '}
              possono usare modelli diversi, nativi o CLI. Si configura in{' '}
              <code>.charliecode/routing.yaml</code>; senza file vale il modello principale o la CLI
              worker.
            </p>
            {routing?.error && <div className="banner warn">{routing.error}</div>}
            {routing?.enabled ? (
              <div className="routing-roles">
                {routing.roles.map((route) => (
                  <div key={route.role} className="routing-role">
                    <code>{route.role}</code>
                    <span>
                      {route.modelKey}
                      {route.effort ? ` · effort ${route.effort}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">Non attivo.</p>
            )}
            <div className="setup-actions">
              <button
                className="ghost"
                onClick={() =>
                  void window.charliecode
                    .openRouting()
                    .then(setRouting)
                    .catch((cause) =>
                      setFatal(cause instanceof Error ? cause.message : String(cause))
                    )
                }
              >
                {routing?.source ? 'Apri routing.yaml' : 'Crea routing.yaml'}
              </button>
            </div>
              </>
            )}

            {drawerTab === 'skills' && (
              <>
            <h3 id="set-skills">Skill</h3>
            <p className="muted small">
              Procedure riutilizzabili in <code>SKILL.md</code>, come negli altri strumenti. Stanno in{' '}
              <code>.charliecode/skills</code> del progetto o in <code>~/.charliecode/skills</code>.
              L’agente vede solo nome e descrizione e carica il testo con il tool <code>skill</code>{' '}
              quando serve, quindi non consumano contesto.
            </p>
            <div className="skills">
              {skills.map((skill) => (
                <div key={skill.dir} className="skill">
                  <div className="skill-head">
                    <div>
                      <div className="skill-name">{skill.name}</div>
                      <div className="skill-desc">{skill.description}</div>
                    </div>
                    <div className="skill-actions">
                      <span className={`skill-source ${skill.source}`}>
                        {skill.source === 'project' ? 'progetto' : 'globale'}
                      </span>
                      <button
                        className="ghost small"
                        onClick={() => void uninstallSkill(skill)}
                        title="Rimuove la cartella della skill"
                      >
                        rimuovi
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {skills.length === 0 && (
                <p className="muted small">
                  Nessuna skill installata. Puoi crearne una a mano o installarne una da un
                  repository git.
                </p>
              )}
            </div>
            {skillError && <div className="message-error">{skillError}</div>}
            <div className="skill-install">
              <input
                placeholder="URL git (https://github.com/utente/repo)"
                value={skillUrl}
                onChange={(event) => setSkillUrl(event.target.value)}
              />
              <select
                value={skillTarget}
                onChange={(event) => setSkillTarget(event.target.value as 'global' | 'project')}
              >
                <option value="global">tutti i progetti</option>
                <option value="project">solo questo progetto</option>
              </select>
              <button
                className="primary"
                onClick={() => void installSkill()}
                disabled={skillBusy || !skillUrl.trim()}
              >
                {skillBusy ? 'Installo…' : 'Installa'}
              </button>
            </div>
            <div className="setup-actions">
              <button className="ghost" onClick={() => void window.charliecode.openSkillsDir('global')}>
                Apri cartella skill
              </button>
              <button
                className="ghost"
                onClick={() => void window.charliecode.openSkillsDir('project')}
                disabled={!workspace}
              >
                Skill del progetto
              </button>
            </div>
              </>
            )}

            {drawerTab === 'permissions' && (
              <>
            <h3 id="set-permissions">Permessi automatici</h3>
            <p className="muted small">
              Tool e comandi che CharlieCode esegue senza chiedere. I tool di sola
              lettura partono già approvati; aggiungi un comando bash per
              approvare tutti i suoi figli, es. <code>git status</code>.
            </p>
            <div className="auto-approve">
              <div className="auto-approve-group">
                <div className="auto-approve-label">Tool</div>
                <div className="auto-approve-chips">
                  {(autoApprove?.tools ?? []).map((tool) => (
                    <span key={tool} className="chip">
                      {tool}
                      <button
                        className="ghost danger-text"
                        onClick={() => void removeAutoApprove(tool)}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  <input
                    placeholder="es. write"
                    value={newToolDraft}
                    onChange={(event) => setNewToolDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void addAutoApprove()
                    }}
                  />
                  <button className="ghost" onClick={() => void addAutoApprove()}>
                    Aggiungi
                  </button>
                </div>
              </div>
              <div className="auto-approve-group">
                <div className="auto-approve-label">Comandi bash</div>
                <div className="auto-approve-chips">
                  {(autoApprove?.commands ?? []).map((command) => (
                    <span key={command} className="chip">
                      {command}
                      <button
                        className="ghost danger-text"
                        onClick={() => void removeAutoApprove(command, true)}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  <input
                    placeholder="es. git status"
                    value={newCommandDraft}
                    onChange={(event) => setNewCommandDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void addAutoApprove(undefined, true)
                    }}
                  />
                  <button className="ghost" onClick={() => void addAutoApprove(undefined, true)}>
                    Aggiungi
                  </button>
                </div>
              </div>
            </div>
              </>
            )}

            {drawerTab === 'instructions' && (
              <>
            <h3 id="set-instructions">Istruzioni del progetto</h3>
            <p className="muted small">
              CharlieCode legge <code>AGENTS.md</code>, <code>CHARLIECODE.md</code> e{' '}
              <code>CLAUDE.md</code> dalla radice del progetto, più un{' '}
              <code>AGENTS.md</code> globale in <code>{info?.configDir ?? '~/.charliecode'}</code>.
            </p>
            <div className="setup-actions">
              <button
                className="ghost"
                onClick={() => void window.charliecode.openGlobalAgents()}
              >
                Apri AGENTS.md globale
              </button>
              <button className="ghost" onClick={() => void window.charliecode.openConfigDir()}>
                Apri cartella config
              </button>
            </div>
              </>
            )}

            <div className="drawer-foot">
              <span className="muted small">CharlieCode v{info?.version ?? '—'}</span>
              <button
                className="ghost"
                disabled={updateCheck === 'checking'}
                onClick={() => void checkUpdates()}
              >
                {updateCheck === 'checking' ? 'Controllo…' : 'Controlla aggiornamenti'}
              </button>
              {updateCheck === 'current' && <span className="muted small">Sei aggiornato.</span>}
              {updateCheck === 'unknown' && (
                <span className="muted small">Controllo non riuscito: riprova più tardi.</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
