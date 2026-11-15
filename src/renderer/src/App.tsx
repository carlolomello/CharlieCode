import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { IncomingAttachment } from '../../engine/types'
import type { Session, SessionSummary, StoredMessage } from '../../engine/session-types'
import type {
  AttachmentRef,
  CatalogError,
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
  RoutersStatus
} from '../../shared/ipc'
import { Mascot, MascotDesk, type MascotMood } from './components/Mascot'
import { Markdown } from './components/Markdown'
import { PermissionModal } from './components/PermissionModal'
import { SetupWizard } from './components/SetupWizard'
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
  return key.length > 46 ? `${key.slice(0, 45)}…` : key
}

function modelLabel(model: ModelEntry): string {
  const free = /free/i.test(model.id)
  return `${free ? '★ ' : ''}${model.label === model.id ? shortKey(model.id) : model.label}`
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return 'ora'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}g`
  return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
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
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [modelKey, setModelKey] = useState<string>('')
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
  const [permission, setPermission] = useState<PermissionEnvelope | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
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
  }, [
    refreshModels,
    refreshProviders,
    refreshRouters,
    refreshSessions,
    refreshAutoApprove,
    refreshPlugins
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
              if (event.agentId) return item
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

  // Only follow the stream when the user is already at the bottom; otherwise
  // reading scrollback would be yanked away on every token.
  const stickToBottom = useRef(true)

  useEffect(() => {
    const node = scrollRef.current
    if (!node || !stickToBottom.current) return
    node.scrollTop = node.scrollHeight
  }, [items])

  // Give the keyboard back as soon as a turn ends.
  useEffect(() => {
    if (!streamingId) inputRef.current?.focus()
  }, [streamingId])

  const selectedModel = useMemo(
    () => models.find((model) => model.key === modelKey),
    [models, modelKey]
  )

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
    setSessionId(null)
    setItems([])
    setInput('')
    setAttachments([])
    setAttachError(null)
    setStreamingId(null)
    permissionRef.current = null
    permissionQueue.current = []
    setPermission(null)
  }, [])

  const pickWorkspace = useCallback(async (): Promise<void> => {
    const result = await window.charliecode.pickWorkspace()
    const picked = result.path
    if (picked) {
      setWorkspace(picked)
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
      void refreshSessions()
    }
  }, [refreshSessions])

  const openSession = useCallback(async (id: string): Promise<void> => {
    setLoadingSession(true)
    try {
      const session: Session | null = await window.charliecode.loadSession(id)
      if (!session) return
      setSessionId(session.id)
      setItems(session.messages.map((message) => ({ ...message, pending: false })))
      if (session.modelKey) setModelKey(session.modelKey)
      setEffort(session.effort)
      if (session.workspacePath) setWorkspace(session.workspacePath)
    } finally {
      setLoadingSession(false)
    }
  }, [])

  const removeSession = useCallback(
    async (id: string): Promise<void> => {
      const target = sessions.find((session) => session.id === id)
      if (!window.confirm(`Eliminare la chat "${target?.title ?? id}"?`)) return
      await window.charliecode.deleteSession(id)
      if (sessionId === id) startNewChat()
      await refreshSessions()
    },
    [refreshSessions, sessionId, sessions, startNewChat]
  )

  const renameSession = useCallback(
    async (id: string, current: string): Promise<void> => {
      const title = window.prompt('Nuovo titolo', current)
      if (!title?.trim()) return
      await window.charliecode.renameSession(id, title)
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
        modelKey,
        text,
        effort,
        mode: activeMode,
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
  }, [attachments, effort, input, mode, modelKey, sessionId, streamingId, workspace])

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
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <Mascot size={38} mood={mood} />
            <div>
              <div className="brand-name">CharlieCode</div>
              <div className="brand-sub">v{info?.version ?? '0.0.1'}</div>
            </div>
          </div>

          <button className="project" onClick={() => void pickWorkspace()} title="Scegli la cartella del progetto">
            <span className="project-icon">▣</span>
            <span className="project-body">
              <span className="project-label">{workspace ? baseName(workspace) : 'Nessun progetto'}</span>
              <span className="project-path">{workspace ?? 'clicca per scegliere una cartella'}</span>
            </span>
          </button>

          <button className="new-chat" onClick={startNewChat}>
            + Nuova chat
          </button>
        </div>

        <div className="session-list">
          {sessions.length === 0 && <div className="session-empty">Nessuna chat salvata</div>}
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session ${session.id === sessionId ? 'active' : ''}`}
              onClick={() => void openSession(session.id)}
              title={session.preview || session.title}
            >
              <div className="session-main">
                <div className="session-title">{session.title}</div>
                <div className="session-meta">
                  {relativeTime(session.updatedAt)} · {session.messageCount} msg
                </div>
              </div>
              <div className="session-actions">
                <button
                  className="icon"
                  title="Rinomina"
                  onClick={(event) => {
                    event.stopPropagation()
                    void renameSession(session.id, session.title)
                  }}
                >
                  ✎
                </button>
                <button
                  className="icon danger-text"
                  title="Elimina"
                  onClick={(event) => {
                    event.stopPropagation()
                    void removeSession(session.id)
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="sidebar-bottom">
          <button className="primary wide" onClick={() => setWizardOpen(true)}>
            ✦ Collega un modello
          </button>
          <button className="ghost wide" onClick={() => setSettingsOpen(true)}>
            ⚙ Provider e chiavi
          </button>
          <button className="ghost wide" onClick={() => void window.charliecode.openConfigDir()}>
            Apri cartella config
          </button>
          <div className="sidebar-foot">
            {info?.platform ?? '…'} · {providers.filter((provider) => provider.enabled).length} provider
            {routers?.ollama.running ? ' · ollama ✓' : ''}
            {routers?.freellmapi.running ? ' · router ✓' : ''}
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="controls">
            <select
              className="select model-select"
              value={modelKey}
              onChange={(event) => setModelKey(event.target.value)}
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
            stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90
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
              <div className="working-badge">
                <MascotDesk width={118} mood="thinking" />
                <div className="working-text">
                  <strong>Charlie sta lavorando</strong>
                  <span>strumenti, diff e subagenti in corso…</span>
                </div>
              </div>
            </div>
          )}
        </main>

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
          onRefreshRouters={refreshRouters}
          onSetKey={wizardSetKey}
          onToggleProvider={wizardToggle}
          onAddProvider={wizardAddProvider}
          onClose={() => {
            setWizardOpen(false)
            void refreshRouters()
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
                    </label>
                    <span className={`key-state ${provider.hasKey ? 'ok' : 'warn'}`}>
                      {provider.hasKey ? `key ${provider.keyHint}` : 'nessuna key'}
                    </span>
                  </div>
                  <div className="provider-url">{provider.baseUrl}</div>
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
