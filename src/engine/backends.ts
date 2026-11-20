import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
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
import { runExternalAgent, type ExternalRunResult } from './external-agents'
import { cliModelKey } from '../shared/cli-key'
import {
  integrationPrompt,
  maxWorkersOf,
  parseCliPlan,
  planPrompt,
  scheduleWaves,
  workerPrompt
} from './cli-team'

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
  const images = input.messages.reduce(
    (total, message) => total + (message.images?.length ?? 0),
    0
  )

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
    // A CLI is usually sandboxed to the project: a path under the app config
    // dir is unreadable there, so images are declared instead of linked.
    images > 0
      ? `Nota: questa conversazione contiene ${images} immagine/i che questa CLI non può vedere. Non descriverne il contenuto e non dire che mancano.`
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
  /**
   * Split the turn across parallel CLI processes. The CLI itself plans the
   * split; a plan with one item runs as a normal turn.
   */
  team?: boolean
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

interface SnapshotEntry {
  mtimeMs: number
  size: number
}

const SNAPSHOT_IGNORED = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  'release',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target'
])

/**
 * mtime+size snapshot of a project without git. `listChanges` needs a
 * repository; without one the CLI could write a dozen files and the transcript
 * still claimed nothing had changed.
 */
async function snapshotWorkspace(root: string): Promise<Map<string, SnapshotEntry>> {
  const result = new Map<string, SnapshotEntry>()

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || result.size >= 4_000) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (result.size >= 4_000) return
      if (SNAPSHOT_IGNORED.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(full).catch(() => undefined)
      if (!info) continue
      result.set(relative(root, full).split(sep).join('/'), {
        mtimeMs: info.mtimeMs,
        size: info.size
      })
    }
  }

  await walk(root, 0)
  return result
}

/**
 * Runs one turn through the CLI and turns its output into the same events a
 * native model produces. The CLI writes directly to the workspace; the diff is
 * computed around the run, so the user still sees what changed.
 */
export async function runCliTurn(input: CliTurnInput): Promise<CliTurnResult> {
  // A profile without a read-only flag cannot honour plan mode. Saying so is
  // better than running it in build mode after the user chose "Piano".
  if (input.mode === 'plan' && !input.profile.planArgs?.length) {
    const message = `${input.profile.label} non ha un flag di sola lettura configurato: aggiungi \`planArgs\` al profilo o usa un modello nativo per la modalità piano.`
    input.emit({ type: 'error', message })
    input.emit({
      type: 'done',
      modelKey: cliModelKey(input.profile.id, input.model),
      ms: 0,
      ttftMs: 0,
      steps: 0,
      toolCalls: 0
    })
    return { text: '', error: message, aborted: false, toolCalls: 0 }
  }

  const started = Date.now()
  let firstTextAt: number | undefined
  let toolCalls = 0
  let activityId = 0

  const before: WorkspaceChanges | undefined =
    input.mode === 'build' ? await listChanges(input.workspace).catch(() => undefined) : undefined
  const beforeSnapshot =
    input.mode === 'build' && !before?.git
      ? await snapshotWorkspace(input.workspace).catch(() => new Map<string, SnapshotEntry>())
      : undefined

  input.emit({
    type: 'start',
    modelKey: cliModelKey(input.profile.id, input.model),
    label: input.profile.label
  })

  const projectContext = (input.system ?? '').slice(0, 4_000)

  const emitActivity = (activity: string, agent?: { id: string; name: string }): void => {
    // A CLI can print hundreds of progress lines. The transcript is not a log
    // viewer: the first fifty are enough to show that work happened.
    if (toolCalls >= 50) return
    const id = `cli-activity-${++activityId}`
    toolCalls++
    const attribution = agent ? { agentId: agent.id, agentName: agent.name } : {}
    input.emit({ type: 'tool-call', id, name: 'cli', title: activity, ...attribution })
    input.emit({
      type: 'tool-result',
      id,
      name: 'cli',
      ok: true,
      summary: 'attività riportata dalla CLI',
      ms: 0,
      ...attribution
    })
  }

  /** One CLI process. `quiet` keeps the output out of the transcript. */
  const runOnce = async (
    prompt: string,
    options: {
      mode: AgentMode
      quiet?: boolean
      agent?: { id: string; name: string }
    }
  ): Promise<ExternalRunResult> => {
    const result = await runExternalAgent(
      input.profile,
      {
        prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        plan: options.mode === 'plan',
        auto: options.mode === 'build',
        workspace: input.workspace
      },
      {
        home: input.home,
        ...(input.signal ? { signal: input.signal } : {}),
        onText: (chunk) => {
          if (options.quiet) return
          if (firstTextAt === undefined) firstTextAt = Date.now()
          input.emit({ type: 'delta', text: chunk })
        },
        onActivity: (activity) => emitActivity(activity, options.agent)
      }
    )

    // The turn ran on the CLI's own default because the chosen model was
    // rejected: saying it in the transcript is the difference between a silent
    // downgrade and a visible one.
    if (result.warning) {
      const id = `cli-warning-${++activityId}`
      const attribution = options.agent
        ? { agentId: options.agent.id, agentName: options.agent.name }
        : {}
      input.emit({
        type: 'tool-call',
        id,
        name: 'cli-warning',
        title: 'Modello della CLI non applicato',
        ...attribution
      })
      input.emit({
        type: 'tool-result',
        id,
        name: 'cli-warning',
        ok: true,
        summary: result.warning,
        ms: 0,
        ...attribution
      })
    }

    return result
  }

  interface Outcome {
    text: string
    error?: string
    aborted: boolean
  }

  const runSingle = async (): Promise<Outcome> => {
    const result = await runOnce(
      buildCliBriefing({
        ...(input.system ? { system: input.system } : {}),
        messages: input.history,
        prompt: input.prompt,
        mode: input.mode,
        ...(input.attachments?.length ? { attachments: input.attachments } : {})
      }),
      { mode: input.mode }
    )
    return {
      text: result.text,
      ...(result.error ? { error: result.error } : {}),
      aborted: result.aborted || result.timedOut
    }
  }

  /**
   * Squadra CLI: the CLI plans, the app runs the independent items as parallel
   * processes on disjoint files, the CLI integrates. A plan with a single item
   * (or no plan at all) falls back to a normal turn, so a task that cannot be
   * split costs only the planning call.
   */
  const runTeam = async (): Promise<Outcome> => {
    const maxWorkers = maxWorkersOf(input.profile.maxWorkers)
    const planCall = await runOnce(
      planPrompt({
        prompt: input.prompt,
        maxWorkers: maxWorkers,
        ...(projectContext ? { context: projectContext } : {})
      }),
      { mode: 'plan', quiet: true }
    )

    // The plan is structured output: read the raw stdout, not the chat text a
    // JSON output format may have emptied.
    const plan = parseCliPlan(planCall.raw || planCall.text)
    if (!plan || plan.items.length < 2) {
      return runSingle()
    }

    input.emit({
      type: 'tool-call',
      id: `cli-plan-${Date.now()}`,
      name: 'cli-plan',
      title: `Squadra: ${plan.items.length} lavori indipendenti`,
      input: { items: plan.items.map((entry) => entry.title) }
    })

    const waves = scheduleWaves(plan.items, maxWorkers)
    const reports: { item: (typeof plan.items)[number]; text: string; error?: string }[] = []
    let workerIndex = 0

    for (const wave of waves) {
      if (input.signal?.aborted) break
      const results = await Promise.all(
        wave.map(async (item) => {
          const agentId = `cli-worker-${++workerIndex}`
          const startedAt = Date.now()
          input.emit({
            type: 'subagent-start',
            agentId,
            name: item.title,
            description: item.instructions.slice(0, 200),
            modelKey: `${input.profile.label}${input.model ? ` · ${input.model}` : ''}`
          })
          const result = await runOnce(
            workerPrompt({
              item,
              index: workerIndex,
              total: plan.items.length,
              workspace: input.workspace,
              ...(projectContext ? { context: projectContext } : {})
            }),
            { mode: 'build', quiet: true, agent: { id: agentId, name: item.title } }
          )
          const failed = result.error ?? (result.timedOut ? 'timeout' : undefined)
          input.emit({
            type: 'subagent-end',
            agentId,
            name: item.title,
            ok: !failed,
            summary:
              failed ?? ((result.text.trim().split('\n')[0] ?? '').slice(0, 200) || 'fatto'),
            ms: Date.now() - startedAt
          })
          return {
            item,
            text: result.text,
            ...(failed ? { error: failed } : {})
          }
        })
      )
      reports.push(...results)
    }

    if (input.signal?.aborted) return { text: '', aborted: true }

    const integration = await runOnce(
      integrationPrompt({ prompt: input.prompt, workers: reports }),
      { mode: 'build' }
    )

    const failedAll = reports.length > 0 && reports.every((report) => report.error)
    const fallback = reports
      .map((report) =>
        `${report.item.title}: ${report.error ?? report.text.trim().slice(0, 400)}`
      )
      .join('\n\n')

    return {
      text: integration.text.trim() || fallback,
      ...(integration.error
        ? { error: integration.error }
        : failedAll
          ? { error: 'Tutti i worker della squadra sono falliti.' }
          : {}),
      aborted: integration.aborted || integration.timedOut
    }
  }

  const outcome =
    input.team === true && input.mode === 'build' ? await runTeam() : await runSingle()

  if (before?.git) {
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
  } else if (beforeSnapshot) {
    const afterSnapshot = await snapshotWorkspace(input.workspace).catch(
      () => new Map<string, SnapshotEntry>()
    )
    const changed = [...afterSnapshot.entries()]
      .filter(([path, info]) => {
        const previous = beforeSnapshot.get(path)
        return !previous || previous.mtimeMs !== info.mtimeMs || previous.size !== info.size
      })
      .map(([path]) => path)
    const removed = [...beforeSnapshot.keys()].filter((path) => !afterSnapshot.has(path))

    for (const path of [...changed, ...removed].slice(0, 20)) {
      const id = `cli-write-${path}`
      toolCalls++
      input.emit({
        type: 'tool-call',
        id,
        name: 'cli-write',
        title: `Scrittura tramite CLI: ${path}`,
        input: { path }
      })
      input.emit({
        type: 'tool-result',
        id,
        name: 'cli-write',
        ok: true,
        summary: removed.includes(path)
          ? 'file rimosso (progetto senza git)'
          : 'file modificato (progetto senza git)',
        ms: 0
      })
    }
  }

  const ms = Date.now() - started
  const aborted = outcome.aborted
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
    text: outcome.text,
    ...(outcome.error ? { error: outcome.error } : {}),
    aborted,
    toolCalls
  }
}
