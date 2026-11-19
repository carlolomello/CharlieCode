import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { cliModelKey, parseCliModelKey } from '../../shared/cli-key'
import type { IncomingAttachment } from '../../engine/types'
import type { Session, SessionSummary, StoredMessage } from '../../engine/session-types'
import type {
  AttachmentRef,
  CatalogError,
  ContextStats,
  EffortLevel,
  ModelEntry,
  PermissionDecision,
  PermissionRequest,
  ToolLog
} from '../../engine/types'
import type {
  AppInfo,
  ChatEventEnvelope,
  PermissionEnvelope,
  PluginStatus,
  ProviderStatus,
  SkillInfo,
  RoutersStatus
} from '../../shared/ipc'
import { Mascot, MascotDesk, MascotTeam, type MascotMood } from './components/Mascot'
import { Sidebar } from './components/Sidebar'
import { baseName } from './format'
import { Markdown } from './components/Markdown'
import { PermissionModal } from './components/PermissionModal'
import { SetupWizard } from './components/SetupWizard'
import { ProjectWizard } from './components/ProjectWizard'
import { ChangesPanel } from './components/ChangesPanel'
import { ToolActivity, type SubagentRun } from './components/ToolActivity'

type ChatItem = StoredMessage & {
  pending?: boolean
  requestId?: string
  tools?: ToolLog[]
  subagents?: SubagentRun[]
  /** Mode the turn ran in; drives the "esegui il piano" affordance. */
  mode?: 'plan' | 'build'
}

interface PendingAttachment extends IncomingAttachment {
  localId: string
}

const MAX_ATTACHMENTS = 8
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_TEXT_BYTES = 200 * 1024

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'csv', 'tsv', 'log',
  'xml', 'html', 'htm', 'css', 'scss', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go',
  'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'ps1',
  'sql', 'graphql', 'proto', 'patch', 'diff'
])

function attachmentKind(name: string, mime: string): 'image' | 'text' | undefined {
  if (/^image\/(png|jpe?g|webp|gif|bmp|avif)$/i.test(mime)) return 'image'
  if (mime.startsWith('text/')) return 'text'
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return undefined
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('lettura fallita'))
    reader.readAsDataURL(file)
  })
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('lettura fallita'))
    reader.readAsText(file)
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const EFFORT_LABEL: Record<EffortLevel, string> = {
  none: 'default',
  low: 'basso',
  high: 'alto',
  max: 'massimo'
}

function shortKey(key: string): string {
  const cli = parseCliModelKey(key)
  if (cli) return cli.model ? `${cli.profileId} · ${cli.model}` : cli.profileId
  return key.length > 46 ? `${key.slice(0, 45)}…` : key
}

/** 8234 → "8.2k": compact enough for a composer badge. */
function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

function modelLabel(model: ModelEntry): string {
  const free = /free/i.test(model.id)
  return `${free ? '★ ' : ''}${model.label === model.id ? shortKey(model.id) : model.label}`
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
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [modelKey, setModelKey] = useState<string>('')
  /** Model passed to the selected CLI, when the backend is a CLI profile. */
  const [cliModel, setCliModel] = useState<string>('')
  const [cliModels, setCliModels] = useState<string[]>([])
  const [cliModelsBusy, setCliModelsBusy] = useState(false)
  const [preferredModel, setPreferredModel] = useState<string>('')
  const [effort, setEffort] = useState<EffortLevel>('none')
  const [mode, setMode] = useState<'plan' | 'build'>('build')
  const [workspace, setWorkspace] = useState<string | undefined>(undefined)
  const [input, setInput] = useState('')
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [newProvider, setNewProvider] = useState({ id: '', label: '', baseUrl: '' })
  const [loadingSession, setLoadingSession] = useState(false)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [showJump, setShowJump] = useState(false)
  /** Tokens sent to the model, its budget and whether compaction is active. */
  const [context, setContext] = useState<ContextStats | null>(null)
  const [contextBusy, setContextBusy] = useState(false)
  const [contextNotice, setContextNotice] = useState<string | null>(null)
  const [permission, setPermission] = useState<PermissionEnvelope | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  /** Workspace whose onboarding wizard is open, if any. */
  const [projectWizard, setProjectWizard] = useState<string | null>(null)
  /** Right-hand "what changed" panel, and the count for its badge. */
  const [changesOpen, setChangesOpen] = useState(false)
  /** "Squadra": force this turn to be split across task subagents. */
  const [teamMode, setTeamMode] = useState(() => {
    try {
      return window.localStorage.getItem('charliecode.team') === '1'
    } catch {
      return false
    }
  })
  /** The workshop scene, shown on demand from the sidebar mascot. */
  const [teamPreview, setTeamPreview] = useState(false)
  const [changesCount, setChangesCount] = useState(0)
  const [routers, setRouters] = useState<RoutersStatus | null>(null)
  const [newToolDraft, setNewToolDraft] = useState('')
  const [newCommandDraft, setNewCommandDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const permissionQueue = useRef<PermissionEnvelope[]>([])
  const permissionRef = useRef<PermissionEnvelope | null>(null)

  const refreshSessions = useCallback(async (): Promise<void> => {
    setSessions(await window.charliecode.listSessions())
  }, [])

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
      setModelKey((current) => {
        if (current && response.models.some((model) => model.key === current)) return current
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
    void refreshAutoApprove()
    void refreshPlugins()
    void refreshSkills()
  }, [
    refreshModels,
    refreshProviders,
    refreshRouters,
    refreshSessions,
    refreshAutoApprove,
    refreshPlugins,
    refreshSkills
  ])

  useEffect(() => {
    const unsubscribe = window.charliecode.onChatEvent(({ requestId, event }: ChatEventEnvelope) => {
      setItems((previous) =>
        previous.map((item) => {
          if (item.requestId !== requestId) return item

          switch (event.type) {
            case 'start':
              return {
                ...item,
                modelKey: event.modelKey,
                meta: event.fallbackFrom ? `fallback da ${event.fallbackFrom}` : item.meta
              }
            case 'delta':
              // Subagent text belongs to its own card, not to the main answer.
              if (event.agentId) {
                return {
                  ...item,
                  subagents: (item.subagents ?? []).map((run) =>
                    run.agentId === event.agentId
                      ? { ...run, text: `${run.text ?? ''}${event.text}` }
                      : run
                  )
                }
              }
              return { ...item, content: item.content + event.text }
            case 'tool-call':
              return {
                ...item,
                tools: [
                  ...(item.tools ?? []),
                  {
                    id: event.id,
                    name: event.name,
                    title: event.title,
                    input: event.input,
                    status: 'running',
                    ...(event.agentId ? { agentId: event.agentId } : {}),
                    ...(event.agentName ? { agentName: event.agentName } : {})
                  }
                ]
              }
            case 'tool-result':
              return {
                ...item,
                tools: (item.tools ?? []).map((log) =>
                  log.id === event.id
                    ? {
                        ...log,
                        status: event.denied ? 'denied' : event.ok ? 'ok' : 'error',
                        summary: event.summary,
                        ...(event.output ? { output: event.output } : {}),
                        ...(event.diff ? { diff: event.diff } : {}),
                        ms: event.ms
                      }
                    : log
                )
              }
            case 'subagent-start':
              return {
                ...item,
                subagents: [
                  ...(item.subagents ?? []),
                  {
                    agentId: event.agentId,
                    name: event.name,
                    description: event.description,
                    modelKey: event.modelKey,
                    status: 'running'
                  }
                ]
              }
            case 'subagent-end':
              return {
                ...item,
                subagents: (item.subagents ?? []).map((run) =>
                  run.agentId === event.agentId
                    ? {
                        ...run,
                        status: event.ok ? 'ok' : 'error',
                        summary: event.summary,
                        ms: event.ms
                      }
                    : run
                )
              }
            case 'done':
              return {
                ...item,
                pending: false,
                meta: [
                  item.meta,
                  event.steps ? `${event.steps} step` : undefined,
                  event.toolCalls ? `${event.toolCalls} tool` : undefined,
                  `ttft ${event.ttftMs}ms`,
                  `totale ${event.ms}ms`,
                  event.usage?.outputTokens ? `${event.usage.outputTokens} token` : undefined,
                  event.aborted ? 'interrotto' : undefined
                ]
                  .filter(Boolean)
                  .join(' · ')
              }
            case 'error':
              return { ...item, pending: false, error: event.message }
            default:
              return item
          }
        })
      )

      if (event.type === 'done' || event.type === 'error') {
        setStreamingId((current) => (current === requestId ? null : current))
        // A finished request cannot answer a permission prompt any more.
        if (permissionRef.current?.requestId === requestId) {
          const next = permissionQueue.current.shift() ?? null
          permissionRef.current = next
          setPermission(next)
        }
      }
    })

    const unsubscribePermission = window.charliecode.onPermission((envelope: PermissionEnvelope) => {
      // Keep one prompt on screen at a time; the rest wait their turn.
      if (permissionRef.current) {
        permissionQueue.current.push(envelope)
        return
      }
      permissionRef.current = envelope
      setPermission(envelope)
    })

    const unsubscribeSession = window.charliecode.onChatSession(({ sessionId: id, title }) => {
      setSessionId((current) => current ?? id)
      setSessions((previous) => {
        const existing = previous.find((session) => session.id === id)
        if (!existing) return previous
        return previous
          .map((session) =>
            session.id === id
              ? { ...session, title, updatedAt: new Date().toISOString() }
              : session
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      })
      void refreshSessions()
    })

    return () => {
      unsubscribe()
      unsubscribePermission()
      unsubscribeSession()
    }
  }, [refreshSessions])

  // Saving or deleting a CLI profile changes the picker without a reload.
  useEffect(
    () => window.charliecode.onModelsChanged(() => void refreshModels()),
    [refreshModels]
  )

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
      if (changesOpen) setChangesOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [permission, teamPreview, projectWizard, wizardOpen, settingsOpen, changesOpen])

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

  const selectedModel = useMemo(
    () => models.find((model) => model.key === modelKey),
    [models, modelKey]
  )

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
    setCliModelsBusy(true)
    void window.charliecode
      .cliProfileModels(profileId)
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
  }, [selectedModel?.providerId, selectedModel?.id])

  /** The key actually sent: a CLI can carry a model chosen for this turn. */
  const backendKey =
    selectedModel?.providerId === 'cli' && cliModel
      ? cliModelKey(selectedModel.id, cliModel)
      : modelKey

  // The picker only offers levels the model actually accepts.
  const effortOptions = useMemo<EffortLevel[]>(
    () => (selectedModel?.efforts?.length ? selectedModel.efforts : ['none']),
    [selectedModel]
  )

  useEffect(() => {
    if (!effortOptions.includes(effort)) setEffort(effortOptions[0] ?? 'none')
  }, [effortOptions, effort])

  const decidePermission = useCallback(
    async (decision: PermissionDecision): Promise<void> => {
      const current = permissionRef.current
      if (!current) return
      await window.charliecode.respondPermission(current.request.id, decision)
      const next = permissionQueue.current.shift() ?? null
      permissionRef.current = next
      setPermission(next)
    },
    []
  )

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

  const startNewChat = useCallback((): void => {
    // Leaving a running turn in the background would keep burning tokens (and
    // writing) in a chat the user can no longer see.
    if (streamingId) void window.charliecode.stopChat(streamingId)
    setSessionId(null)
    setItems([])
    setInput('')
    setAttachments([])
    setAttachError(null)
    setStreamingId(null)
    setShowJump(false)
    permissionRef.current = null
    permissionQueue.current = []
    setPermission(null)
  }, [streamingId])

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

  const openSession = useCallback(async (id: string): Promise<void> => {
    // One conversation at a time: stop the previous turn before swapping the
    // transcript, otherwise its events would land in the wrong chat.
    if (streamingId) {
      await window.charliecode.stopChat(streamingId)
      setStreamingId(null)
    }
    // Composer state belongs to the chat, not to the window.
    setInput('')
    setAttachments([])
    setAttachError(null)
    setShowJump(false)
    permissionRef.current = null
    permissionQueue.current = []
    setPermission(null)

    setLoadingSession(true)
    try {
      const session: Session | null = await window.charliecode.loadSession(id)
      if (!session) return
      setSessionId(session.id)
      setItems(session.messages.map((message) => ({ ...message, pending: false })))
      if (session.modelKey) {
        const cli = parseCliModelKey(session.modelKey)
        if (cli) {
          // The picker holds the profile; the model is the secondary choice.
          setModelKey(cliModelKey(cli.profileId))
          setCliModel(cli.model ?? '')
        } else {
          setModelKey(session.modelKey)
          setCliModel('')
        }
      }
      setEffort(session.effort)
      if (session.workspacePath) setWorkspace(session.workspacePath)
    } finally {
      setLoadingSession(false)
    }
  }, [streamingId])

  const removeSession = useCallback(
    async (id: string): Promise<void> => {
      await window.charliecode.deleteSession(id)
      if (sessionId === id) startNewChat()
      await refreshSessions()
    },
    [refreshSessions, sessionId, startNewChat]
  )

  const renameSession = useCallback(
    async (id: string, title: string): Promise<void> => {
      const trimmed = title.trim()
      if (!trimmed) return
      await window.charliecode.renameSession(id, trimmed)
      await refreshSessions()
    },
    [refreshSessions]
  )

  const addFiles = useCallback(async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    setAttachError(null)

    const accepted: PendingAttachment[] = []
    for (const file of files) {
      if (attachments.length + accepted.length >= MAX_ATTACHMENTS) {
        setAttachError(`Massimo ${MAX_ATTACHMENTS} allegati per messaggio.`)
        break
      }

      const mime = file.type || 'application/octet-stream'
      const kind = attachmentKind(file.name, mime)
      if (!kind) {
        setAttachError(`Formato non supportato: ${file.name}`)
        continue
      }
      if (kind === 'image' && file.size > MAX_IMAGE_BYTES) {
        setAttachError(`Immagine troppo grande: ${file.name} (max 6 MB).`)
        continue
      }
      if (kind === 'text' && file.size > MAX_TEXT_BYTES) {
        setAttachError(`Documento troppo grande: ${file.name} (max 200 KB).`)
        continue
      }

      try {
        const data =
          kind === 'image' ? await readFileAsDataUrl(file) : await readFileAsText(file)
        accepted.push({
          localId: crypto.randomUUID(),
          name: file.name,
          mime: mime || (kind === 'image' ? 'image/png' : 'text/plain'),
          kind,
          size: file.size,
          data
        })
      } catch {
        setAttachError(`Impossibile leggere ${file.name}.`)
      }
    }

    if (accepted.length > 0) setAttachments((previous) => [...previous, ...accepted])
  }, [attachments.length])

  const removeAttachment = useCallback((localId: string): void => {
    setAttachments((previous) => previous.filter((item) => item.localId !== localId))
  }, [])

  const send = useCallback(
    async (overrideText?: string, overrideMode?: 'plan' | 'build'): Promise<void> => {
      const text = (overrideText ?? input).trim()
      // A "▶ Esegui il piano" click sends only its own prompt and leaves the
      // composer (draft text and attachments) untouched.
      const isOverride = overrideText !== undefined
      const sentAttachments = isOverride ? [] : attachments
      if ((!text && sentAttachments.length === 0) || streamingId || !modelKey) return
      const activeMode = overrideMode ?? mode

      const requestId = crypto.randomUUID()
      const userMessageId = crypto.randomUUID()
      const assistantMessageId = crypto.randomUUID()
      const createdAt = new Date().toISOString()

      setItems((previous) => [
        ...previous,
        {
          id: userMessageId,
          role: 'user',
          content: text,
          createdAt,
          ...(sentAttachments.length > 0
            ? {
                attachments: sentAttachments.map((item) => ({
                  id: item.localId,
                  name: item.name,
                  mime: item.mime,
                  size: item.size,
                  kind: item.kind
                }))
              }
            : {})
        },
        {
          id: assistantMessageId,
          role: 'assistant',
          content: '',
          createdAt,
          pending: true,
          requestId,
          mode: activeMode
        }
      ])
      if (!isOverride) {
        setInput('')
        setAttachments([])
      }
      setAttachError(null)
      setStreamingId(requestId)
      setFatal(null)

    try {
      const result = await window.charliecode.startChat({
        requestId,
        sessionId: sessionId ?? undefined,
        userMessageId,
        assistantMessageId,
        modelKey: backendKey,
        text,
        effort,
        mode: activeMode,
        team: teamMode,
        workspacePath: workspace,
        ...(sentAttachments.length > 0
          ? {
              attachments: sentAttachments.map((item) => ({
                name: item.name,
                mime: item.mime,
                kind: item.kind,
                size: item.size,
                data: item.data
              }))
            }
          : {})
      })

      if (!result.ok) {
        setItems((previous) =>
          previous.map((item) =>
            item.id === assistantMessageId
              ? { ...item, pending: false, error: result.error ?? 'avvio fallito' }
              : item
          )
        )
        setStreamingId(null)
        return
      }

      if (result.sessionId) setSessionId(result.sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setItems((previous) =>
        previous.map((item) =>
          item.id === assistantMessageId ? { ...item, pending: false, error: message } : item
        )
      )
      setStreamingId(null)
    }
  }, [
    attachments,
    backendKey,
    effort,
    input,
    mode,
    modelKey,
    sessionId,
    streamingId,
    teamMode,
    workspace
  ])

  const stop = useCallback(async (): Promise<void> => {
    if (!streamingId) return
    await window.charliecode.stopChat(streamingId)
    permissionRef.current = null
    permissionQueue.current = []
    setPermission(null)
  }, [streamingId])

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
        onOpenWizard={() => setWizardOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenConfig={() => void window.charliecode.openConfigDir()}
      />

      <div className="main">
        <header className="topbar">
          <div className="controls">
            <select
              className="select model-select"
              value={modelKey}
              onChange={(event) => {
                setModelKey(event.target.value)
                setCliModel('')
              }}
              disabled={models.length === 0}
              title={selectedModel?.key ?? ''}
            >
              {models.length === 0 && <option value="">nessun modello</option>}
              {groupedModels.map(([providerLabel, group]) => (
                <optgroup key={providerLabel} label={providerLabel}>
                  {group.map((model) => (
                    <option key={model.key} value={model.key}>
                      {modelLabel(model)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            {selectedModel?.providerId === 'cli' && (cliModelsBusy || cliModels.length > 0) && (
              <select
                className="select cli-model-select"
                value={cliModel}
                onChange={(event) => setCliModel(event.target.value)}
                disabled={cliModelsBusy}
                title="Modello passato alla CLI scelta"
              >
                <option value="">
                  {cliModelsBusy ? 'carico modelli…' : 'modello predefinito'}
                </option>
                {cliModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
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
                  effort: {EFFORT_LABEL[level]}
                </option>
              ))}
            </select>

            <button className="ghost" onClick={() => void refreshModels()} disabled={loadingModels}>
              {loadingModels ? '…' : '↻'}
            </button>

            <button
              className={`ghost small team-toggle ${teamMode ? 'active' : ''}`}
              onClick={() => setTeamMode((value) => !value)}
              disabled={selectedModel?.providerId === 'cli'}
              title={
                selectedModel?.providerId === 'cli'
                  ? 'La CLI gestisce il turno con il proprio loop di agenti'
                  : 'Divide il turno tra subagenti in parallelo: Charlie supervisiona, loro lavorano'
              }
              aria-pressed={teamMode}
            >
              Squadra
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
                className={`ghost small changes-toggle ${changesOpen ? 'active' : ''}`}
                onClick={() => setChangesOpen((open) => !open)}
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

        {fatal && <div className="banner error">{fatal}</div>}

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
                <button className="primary" onClick={() => setWizardOpen(true)}>
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
                        onClick={() => {
                          setSettingsOpen(true)
                          if (provider.docs) void window.charliecode.openExternal(provider.docs)
                        }}
                        title={provider.docs ? `Crea la key su ${provider.docs}` : provider.baseUrl}
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
                {workspace ? ` · progetto ${workspace}` : ' · nessun progetto selezionato'}
              </p>
              <p className="empty-lead">
                Posso leggere, cercare, modificare ed eseguire comandi nel progetto — e mostrarti
                ogni diff prima di applicarlo. Per lavori grandi lancio subagenti in parallelo.
              </p>
              <div className="hints">
                <button onClick={() => void pickWorkspace()}>Scegli un progetto</button>
                <button
                  onClick={() =>
                    setInput(
                      'Esplora questo progetto: leggi AGENTS.md e il package.json, poi spiegami com’è organizzato.'
                    )
                  }
                >
                  Esplora il progetto
                </button>
                <button
                  onClick={() =>
                    setInput('Usa un subagente explorer per trovare dove viene gestita l’autenticazione.')
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
                        : item.modelKey
                          ? shortKey(item.modelKey)
                          : 'assistant'}
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
                ? `${selectedModel.caps.tools ? 'tools' : 'no-tools'} · ${
                    selectedModel.caps.vision ? 'vision' : 'testo'
                  } · ${Math.round(selectedModel.caps.contextWindow / 1024)}k ctx`
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
          onClose={() => {
            setWizardOpen(false)
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
          <div className="drawer" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-head">
              <h2>Provider e chiavi</h2>
              <button className="ghost" onClick={() => setSettingsOpen(false)}>
                ✕
              </button>
            </div>

            <p className="muted small">
              Le chiavi finiscono in <code>{info?.credentialsPath ?? '~/.charliecode/credentials.json'}</code>{' '}
              con permessi 600. Vengono usate solo verso il provider a cui appartengono.
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

            <h3>Plugin</h3>
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

            <h3>Skill</h3>
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

            <h3>Permessi automatici</h3>
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

            <h3>Istruzioni del progetto</h3>
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
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
