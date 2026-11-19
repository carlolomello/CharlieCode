import type {
  AgentMode,
  ChatMessage,
  CliProfile,
  EffortLevel,
  EngineEvent,
  FileDiff,
  ModelEntry
} from './types'
import type { CliProfileInfo, WorkspaceChanges } from '../shared/ipc'
import { changeDiff, listChanges } from './changes'
import { buildSummary } from './context'
import { runExternalAgent } from './external-agents'
import { cliModelKey } from '../shared/cli-key'

/**
 * A CLI as a first-class backend for the main conversation.
 *
 * The canonical context stays in the session: before each CLI turn the recent
 * conversation is written into a briefing, and after it the answer is imported
 * back as a normal assistant message. Switching to a native model therefore
 * keeps the same thread instead of starting a new one.
 */

export function cliModelEntries(profiles: CliProfileInfo[]): ModelEntry[] {
  return profiles
    .filter((entry) => entry.available)
    .map(({ profile }) => ({
      key: cliModelKey(profile.id),
      providerId: 'cli',
      providerLabel: 'CLI esterne',
      id: profile.id,
      label: profile.label,
      // The CLI decides its own context window; this is only the budget the
      // briefing uses, and it is deliberately conservative.
      caps: { tools: true, vision: false, contextWindow: 32_000 },
      capsConfidence: 'guess' as const,
      effort: 'none' as const,
      efforts: profile.effortArgs?.length
        ? (['none', 'low', 'high', 'max'] as EffortLevel[])
        : (['none'] as EffortLevel[])
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

const MAX_BRIEFING_CHARS = 24_000

/**
 * Writes the conversation as plain text for a CLI that only accepts a prompt.
 * The last user message is skipped when it is the current request, so the CLI
 * does not read it twice.
 */
export function buildCliBriefing(input: {
  system?: string
  messages: ChatMessage[]
  prompt: string
  mode?: AgentMode
  /** Files attached to this turn, already on disk. */
  attachments?: { name: string; path: string }[]
}): string {
  const prompt = input.prompt.trim()
  const history = input.messages.filter(
    (message, index) =>
      !(
        index === input.messages.length - 1 &&
        message.role === 'user' &&
        message.content.trim() === prompt
      )
  )

  const recent: string[] = []
  let used = 0
  let start = history.length
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]
    if (!message) continue
    const text = message.content.trim()
    if (!text) continue
    const entry = `${message.role === 'user' ? 'Utente' : 'Assistente'}:\n${text}`
    if (recent.length > 0 && used + entry.length > MAX_BRIEFING_CHARS) break
    recent.unshift(entry)
    start = index
    used += entry.length
  }

  const omitted = history.slice(0, start)

  return [
    'Sei il motore di una conversazione gestita da CharlieCode. Lavora sul progetto nella directory corrente e rispondi alla richiesta finale.',
    input.system ? `Istruzioni del progetto:\n${input.system}` : '',
    input.mode === 'plan'
      ? 'Modalità piano: esplora e proponi, non modificare file.'
      : 'Modalità build: puoi modificare il progetto.',
    omitted.length > 0
      ? `(${omitted.length} messaggi precedenti non entrano nel briefing. Riepilogo automatico:)\n${buildSummary(omitted, 4000)}`
      : '',
    recent.length > 0 ? `Conversazione finita qui:\n\n${recent.join('\n\n')}` : '',
    input.attachments?.length
      ? `Allegati di questo turno (file su disco):\n${input.attachments
          .map((item) => `- ${item.name}: ${item.path}`)
          .join('\n')}`
      : '',
    `Richiesta attuale:\n${prompt}`
  ]
    .filter(Boolean)
    .join('\n\n---\n\n')
}

export interface CliTurnInput {
  profile: CliProfile
  model?: string
  effort?: EffortLevel
  mode: AgentMode
  prompt: string
  /** Full chat history, including the current user message. */
  history: ChatMessage[]
  /** Project instructions (AGENTS.md), without native-tool instructions. */
  system?: string
  /** Absolute paths of the files attached to this turn. */
  attachments?: { name: string; path: string }[]
  workspace: string
  home: string
  signal?: AbortSignal
  emit: (event: EngineEvent) => void
}

export interface CliTurnResult {
  text: string
  error?: string
  aborted: boolean
  toolCalls: number
}

function changeSignature(change: {
  status: string
  added: number
  removed: number
}): string {
  return `${change.status}:${change.added}:${change.removed}`
}

/**
 * Runs one turn through the CLI and turns its output into the same events a
 * native model produces. The CLI writes directly to the workspace; the diff is
 * computed around the run, so the user still sees what changed.
 */
export async function runCliTurn(input: CliTurnInput): Promise<CliTurnResult> {
  const started = Date.now()
  let firstTextAt: number | undefined
  let toolCalls = 0
  let activityId = 0

  const before: WorkspaceChanges | undefined =
    input.mode === 'build' ? await listChanges(input.workspace).catch(() => undefined) : undefined

  input.emit({
    type: 'start',
    modelKey: cliModelKey(input.profile.id, input.model),
    label: input.profile.label
  })

  const result = await runExternalAgent(
    input.profile,
    {
      prompt: buildCliBriefing({
        ...(input.system ? { system: input.system } : {}),
        messages: input.history,
        prompt: input.prompt,
        mode: input.mode,
        ...(input.attachments?.length ? { attachments: input.attachments } : {})
      }),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      plan: input.mode === 'plan',
      auto: input.mode === 'build',
      workspace: input.workspace
    },
    {
      home: input.home,
      ...(input.signal ? { signal: input.signal } : {}),
      onText: (chunk) => {
        if (firstTextAt === undefined) firstTextAt = Date.now()
        input.emit({ type: 'delta', text: chunk })
      },
      onActivity: (activity) => {
        // A CLI can print hundreds of progress lines. The transcript is not a
        // log viewer: the first fifty are enough to show that work happened.
        if (toolCalls >= 50) return
        const id = `cli-activity-${++activityId}`
        toolCalls++
        input.emit({ type: 'tool-call', id, name: 'cli', title: activity })
        input.emit({
          type: 'tool-result',
          id,
          name: 'cli',
          ok: true,
          summary: 'attività riportata dalla CLI',
          ms: 0
        })
      }
    }
  )

  if (before) {
    const after = await listChanges(input.workspace).catch(() => undefined)
    if (after) {
      const previous = new Map(
        before.changes.map((change) => [change.path, changeSignature(change)])
      )
      const changed = after.changes
        .filter((change) => previous.get(change.path) !== changeSignature(change))
        .slice(0, 20)

      for (const change of changed) {
        let diff: FileDiff | undefined
        try {
          diff = await changeDiff(input.workspace, change.path)
        } catch {
          diff = undefined
        }
        const id = `cli-write-${change.path}`
        toolCalls++
        input.emit({
          type: 'tool-call',
          id,
          name: 'cli-write',
          title: `Scrittura tramite CLI: ${change.displayPath}`,
          input: { path: change.path }
        })
        input.emit({
          type: 'tool-result',
          id,
          name: 'cli-write',
          ok: true,
          summary: diff
            ? `${diff.added} aggiunte, ${diff.removed} rimosse`
            : 'file modificato',
          ...(diff ? { diff } : {}),
          ms: 0
        })
      }
    }
  }

  const ms = Date.now() - started
  const aborted = result.aborted || result.timedOut
  input.emit({
    type: 'done',
    modelKey: cliModelKey(input.profile.id, input.model),
    ms,
    ttftMs: Math.max(0, (firstTextAt ?? started) - started),
    steps: 1,
    toolCalls,
    ...(aborted ? { aborted: true } : {})
  })

  return {
    text: result.text,
    ...(result.error ? { error: result.error } : {}),
    aborted,
    toolCalls
  }
}
