import { useCallback, useEffect, useRef, useState } from 'react'
import { cliModelKey, parseCliModelKey } from '../../../shared/cli-key'
import type { Session, SessionSummary, StoredMessage } from '../../../engine/session-types'
import type {
  EffortLevel,
  EngineEvent,
  IncomingAttachment,
  PermissionDecision,
  ToolLog
} from '../../../engine/types'
import type { AppInfo, ChatEventEnvelope, PermissionEnvelope } from '../../../shared/ipc'
import type { SubagentRun } from '../components/ToolActivity'

/**
 * The conversation: transcript, session, drafts, attachments and the stream
 * that fills them.
 *
 * It used to live inside `App`, next to the drawer, the topbar and every
 * setting, in a component that had grown past 2.400 lines. Nothing here draws
 * anything: `App` renders what this returns, and a change to how a turn is sent
 * no longer has to be read past the plugin panel.
 */

export type ChatItem = StoredMessage & {
  pending?: boolean
  requestId?: string
  tools?: ToolLog[]
  subagents?: SubagentRun[]
  /** Reasoning streamed by a CLI: shown live, never stored. */
  thinking?: string
  /** Mode the turn ran in; drives the "esegui il piano" affordance. */
  mode?: 'plan' | 'build'
}

export interface PendingAttachment extends IncomingAttachment {
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

/**
 * One event, applied to the message it belongs to. Pure on purpose: the shape
 * of the transcript is the part of the UI worth reasoning about alone, and the
 * retry of a worker reuses its card instead of adding a second one.
 */
export function applyChatEvent(item: ChatItem, event: EngineEvent): ChatItem {
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
    case 'thinking':
      // Subagent reasoning has no card of its own yet: it stays out of the
      // main answer instead of appearing under the wrong name.
      if (event.agentId) return item
      return { ...item, thinking: `${item.thinking ?? ''}${event.text}` }
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
    case 'subagent-start': {
      // A retried worker keeps its agent id: replace the card instead of
      // stacking a second one for the same worker.
      const run: SubagentRun = {
        agentId: event.agentId,
        name: event.name,
        description: event.description,
        modelKey: event.modelKey,
        status: 'running'
      }
      const existing = item.subagents ?? []
      return {
        ...item,
        subagents: existing.some((entry) => entry.agentId === event.agentId)
          ? existing.map((entry) => (entry.agentId === event.agentId ? run : entry))
          : [...existing, run]
      }
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
                ms: event.ms,
                ...(event.usage ? { usage: event.usage } : {}),
                ...(event.steps !== undefined ? { steps: event.steps } : {})
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
          `primo token ${event.ttftMs}ms`,
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
}

export interface UseChatOptions {
  workspace?: string
  modelKey: string
  /** Key actually sent: a CLI can carry a model chosen for this turn. */
  backendKey: string
  effort: EffortLevel
  mode: 'plan' | 'build'
  /** "Squadra" is on for this turn. */
  teamActive: boolean
  /** A saved chat can belong to another project: opening it moves the app. */
  setWorkspace: (path: string) => void
  setInfo: (info: AppInfo) => void
  setModelKey: (key: string) => void
  setCliModel: (model: string) => void
  setEffort: (effort: EffortLevel) => void
  setFatal: (message: string | null) => void
}

export function useChat(options: UseChatOptions) {
  const {
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
  } = options

  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [loadingSession, setLoadingSession] = useState(false)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [permission, setPermission] = useState<PermissionEnvelope | null>(null)
  /** Incremented whenever the visible conversation changes: stale async work
   *  (a late `chat:session`, a slow `loadSession`) must not touch the new one. */
  const viewEpoch = useRef(0)
  const permissionQueue = useRef<PermissionEnvelope[]>([])
  const permissionRef = useRef<PermissionEnvelope | null>(null)

  const refreshSessions = useCallback(async (): Promise<void> => {
    setSessions(await window.charliecode.listSessions())
  }, [])

  useEffect(() => {
    const unsubscribe = window.charliecode.onChatEvent(({ requestId, event }: ChatEventEnvelope) => {
      setItems((previous) =>
        previous.map((item) =>
          item.requestId === requestId ? applyChatEvent(item, event) : item
        )
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
      // The result of `startChat` already set the id. A late event for an old
      // request must not attach the new chat to the old session.
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

  /**
   * One composer draft per conversation. Switching chats used to throw away
   * half-written prompts; now the text follows the chat, and the unsent text of
   * a new chat survives a reload too.
   */
  const draftKey = `charliecode.draft.${sessionId ?? 'new'}`
  const draftRef = useRef<{ key: string; value: string }>({ key: draftKey, value: '' })

  useEffect(() => {
    const previous = draftRef.current
    if (previous.key !== draftKey) {
      try {
        if (previous.value) window.localStorage.setItem(previous.key, previous.value)
        else window.localStorage.removeItem(previous.key)
      } catch {
        // Storage can be blocked; the draft is a convenience, not state.
      }
    }

    let loaded = ''
    try {
      loaded = window.localStorage.getItem(draftKey) ?? ''
    } catch {
      loaded = ''
    }
    draftRef.current = { key: draftKey, value: loaded }
    setInput(loaded)
  }, [draftKey])

  useEffect(() => {
    draftRef.current = { key: draftKey, value: input }
    const timer = window.setTimeout(() => {
      try {
        if (input) window.localStorage.setItem(draftKey, input)
        else window.localStorage.removeItem(draftKey)
      } catch {
        // Same: losing a draft is better than breaking the composer.
      }
    }, 400)
    return () => window.clearTimeout(timer)
  }, [draftKey, input])

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

  const startNewChat = useCallback((): void => {
    viewEpoch.current += 1
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

  const openSession = useCallback(async (id: string): Promise<void> => {
    const epoch = ++viewEpoch.current
    // One conversation at a time: stop the previous turn before swapping the
    // transcript, otherwise its events would land in the wrong chat.
    if (streamingId) {
      await window.charliecode.stopChat(streamingId)
      setStreamingId(null)
    }
    // Attachments belong to the chat, not to the window. The draft text is
    // restored by the per-session draft effect.
    setAttachments([])
    setAttachError(null)
    setShowJump(false)
    permissionRef.current = null
    permissionQueue.current = []
    setPermission(null)

    setLoadingSession(true)
    try {
      const session: Session | null = await window.charliecode.loadSession(id)
      if (!session || epoch !== viewEpoch.current) return

      // A saved chat can belong to another project: open that project too, or
      // the drawer, skills, routing and memory keep pointing at the old one.
      if (session.workspacePath && session.workspacePath !== workspace) {
        const result = await window.charliecode.useWorkspace(session.workspacePath)
        if (epoch !== viewEpoch.current) return
        if (result.path) {
          setWorkspace(result.path)
          setInfo(await window.charliecode.info())
        }
      }

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
    } catch (cause) {
      // A saved chat can point at a folder the user moved or deleted. Say so
      // instead of leaving an unhandled rejection from the click handler.
      if (epoch === viewEpoch.current) {
        setFatal(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (epoch === viewEpoch.current) setLoadingSession(false)
    }
  }, [streamingId, workspace, setWorkspace, setInfo, setModelKey, setCliModel, setEffort, setFatal])

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
      if (!workspace) {
        setFatal('Apri un progetto prima di inviare un messaggio.')
        return
      }
      const activeMode = overrideMode ?? mode
      const epoch = viewEpoch.current

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
          team: teamActive,
          workspacePath: workspace,
          // Always an array: the main process rejects a missing list, and a
          // message without files is the normal case.
          attachments: sentAttachments.map((item) => ({
            name: item.name,
            mime: item.mime,
            kind: item.kind,
            size: item.size,
            data: item.data
          }))
        })

        if (epoch !== viewEpoch.current) return
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
        if (epoch !== viewEpoch.current) return
        const message = error instanceof Error ? error.message : String(error)
        setItems((previous) =>
          previous.map((item) =>
            item.id === assistantMessageId ? { ...item, pending: false, error: message } : item
          )
        )
        setStreamingId(null)
      }
    },
    [
      attachments,
      backendKey,
      effort,
      input,
      mode,
      modelKey,
      sessionId,
      streamingId,
      teamActive,
      workspace,
      setFatal
    ]
  )

  const stop = useCallback(async (): Promise<void> => {
    if (!streamingId) return
    await window.charliecode.stopChat(streamingId)
    permissionRef.current = null
    permissionQueue.current = []
    setPermission(null)
  }, [streamingId])

  /** The card's ■: the worker stops, the rest of the turn keeps going. */
  const cancelSubagent = useCallback((requestId: string | undefined, agentId: string): void => {
    if (!requestId) return
    void window.charliecode.cancelSubagent(requestId, agentId)
  }, [])

  /** The card's ↻: one failed worker runs again, same card. */
  const retrySubagent = useCallback((requestId: string | undefined, agentId: string): void => {
    if (!requestId) return
    void window.charliecode.retrySubagent(requestId, agentId)
  }, [])

  return {
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
  }
}
