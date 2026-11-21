import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type {
  AgentMode,
  ChatMessage,
  CliProfile,
  EffortLevel,
  EngineEvent,
  FileDiff,
  ModelEntry,
  PermissionDecision,
  PermissionRequest
} from './types'
import type { CliProfileInfo, WorkspaceChanges } from '../shared/ipc'
import { changeDiff, listChanges } from './changes'
import { buildSummary } from './context'
import {
  failedFast,
  profileEfforts,
  runExternalAgent,
  type ExternalRunResult
} from './external-agents'
import { clearCliSession, hasCliSession, markCliSession } from './cli-sessions'
import { TurnCancellation } from './turn-cancellation'
import { TurnEmitter, type AgentRef } from './turn-emitter'
import type { AgentBackend, AgentBackendResult } from './agent-backend'
import type { SubagentRetries } from './subagent-retry'
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
      // The effort can live in the model string (`provider/model#variant`)
      // instead of a flag of its own: the picker offers the levels either way.
      efforts: profileEfforts(profile)
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

/**
 * The next turn of a conversation the CLI already holds. Sending the whole
 * briefing again would pay for the history twice; a CLI with a live session
 * only needs to be told what is new.
 */
export function buildCliResumePrompt(input: {
  prompt: string
  mode?: AgentMode
  attachments?: { name: string; path: string }[]
}): string {
  return [
    'Continui la sessione precedente in questo progetto: non ripetere lavoro già fatto e non rileggere tutto da capo.',
    input.mode === 'plan'
      ? 'Modalità piano: esplora e proponi, non modificare file.'
      : 'Modalità build: puoi modificare il progetto.',
    input.attachments?.length
      ? `Allegati di questo turno (file su disco):\n${input.attachments
          .map((item) => `- ${item.name}: ${item.path}`)
          .join('\n')}`
      : '',
    `Richiesta attuale:\n${input.prompt.trim()}`
  ]
    .filter(Boolean)
    .join('\n\n')
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
  /** App config dir, so a flag a CLI refused is not retried after a restart. */
  stateDir?: string
  signal?: AbortSignal
  /**
   * Split the turn across parallel CLI processes. The CLI itself plans the
   * split; a plan with one item runs as a normal turn.
   */
  team?: boolean
  /**
   * Asks the user before a team turn spawns its workers. Without it the plan
   * runs as soon as it is parsed, which is a lot of processes to start on the
   * user's behalf without showing what they are.
   */
  askPermission?: (request: PermissionRequest) => Promise<PermissionDecision>
  /**
   * Lets the UI stop one team worker while the others keep working. Created
   * here when absent, so a CLI turn stays usable on its own (CLI, tests).
   */
  cancellation?: TurnCancellation
  /**
   * Lets the UI run one failed team worker again, with the same agent id so the
   * card is reused instead of duplicated.
   */
  retries?: SubagentRetries
  emit: (event: EngineEvent) => void
}

/** A CLI turn answers the same questions as a native one. */
export type CliTurnResult = AgentBackendResult

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
  const modelKey = cliModelKey(input.profile.id, input.model)
  const turn = new TurnEmitter({ emit: input.emit, idPrefix: 'cli' })

  // A profile without a read-only flag cannot honour plan mode. Saying so is
  // better than running it in build mode after the user chose "Piano".
  if (input.mode === 'plan' && !input.profile.planArgs?.length) {
    const message = `${input.profile.label} non ha un flag di sola lettura configurato: aggiungi \`planArgs\` al profilo o usa un modello nativo per la modalità piano.`
    turn.error(message, modelKey)
    turn.done({ modelKey, ms: 0, ttftMs: 0, steps: 0, toolCalls: 0 })
    return { text: '', modelKey, error: message, aborted: false, steps: 0, toolCalls: 0 }
  }

  const started = Date.now()
  let firstTextAt: number | undefined
  const cancellation = input.cancellation ?? new TurnCancellation()

  const before: WorkspaceChanges | undefined =
    input.mode === 'build' ? await listChanges(input.workspace).catch(() => undefined) : undefined
  const beforeSnapshot =
    input.mode === 'build' && !before?.git
      ? await snapshotWorkspace(input.workspace).catch(() => new Map<string, SnapshotEntry>())
      : undefined

  turn.start({ modelKey, label: input.profile.label })

  const projectContext = (input.system ?? '').slice(0, 4_000)

  const emitActivity = (activity: string, agent?: AgentRef): void => {
    // The cap and the shape live in the emitter: a CLI can print hundreds of
    // progress lines and the transcript is not a log viewer.
    turn.activity(activity, agent)
  }

  /** One CLI process. `quiet` keeps the output out of the transcript. */
  const runOnce = async (
    prompt: string,
    options: {
      mode: AgentMode
      quiet?: boolean
      agent?: AgentRef
      continueSession?: boolean
      /** A worker's own signal, so stopping it does not stop the wave. */
      signal?: AbortSignal
    }
  ): Promise<ExternalRunResult> => {
    const signal = options.signal ?? input.signal
    const result = await runExternalAgent(
      input.profile,
      {
        prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(options.continueSession ? { continueSession: true } : {}),
        plan: options.mode === 'plan',
        auto: options.mode === 'build',
        workspace: input.workspace
      },
      {
        home: input.home,
        ...(input.stateDir ? { stateDir: input.stateDir } : {}),
        ...(signal ? { signal } : {}),
        onText: (chunk) => {
          // A worker's text belongs to its own card: a quiet turn used to drop
          // it entirely, so the card sat on "in corso" until the worker ended.
          if (options.quiet && !options.agent) return
          if (!options.agent && firstTextAt === undefined) firstTextAt = Date.now()
          turn.delta(chunk, options.agent)
        },
        // Reasoning is shown while the turn runs, like every agent CLI does.
        // A planning call and a subagent stay quiet: their reasoning belongs to
        // a card the user did not open.
        onThinking: (chunk) => {
          if (options.quiet || options.agent) return
          turn.thinking(chunk)
        },
        onActivity: (activity) => emitActivity(activity, options.agent)
      }
    )

    // The turn ran without the model, or without a flag the CLI refused: saying
    // it in the transcript is the difference between a silent downgrade and a
    // visible one.
    if (result.warning) turn.warning(result.warning, options.agent)

    return result
  }

  interface Outcome {
    text: string
    error?: string
    aborted: boolean
  }

  const fullPrompt = (): string =>
    buildCliBriefing({
      ...(input.system ? { system: input.system } : {}),
      messages: input.history,
      prompt: input.prompt,
      mode: input.mode,
      ...(input.attachments?.length ? { attachments: input.attachments } : {})
    })

  const toOutcome = (result: ExternalRunResult): Outcome => ({
    text: result.text,
    ...(result.error ? { error: result.error } : {}),
    aborted: result.aborted || result.timedOut
  })

  /** A turn that did its job: the CLI's session is now worth continuing. */
  const rememberSession = async (result: ExternalRunResult): Promise<void> => {
    if (!input.stateDir) return
    // A profile without `continueArgs` cannot resume: writing a record would
    // only add a file nobody reads.
    if (!input.profile.continueArgs?.length) return
    if (result.error || result.aborted || result.timedOut) return
    await markCliSession(input.stateDir, input.profile.id, input.workspace)
  }

  /**
   * One turn. With `useSession` the CLI continues its own previous session and
   * receives only this request: the history already lives inside the CLI, so
   * the briefing would be paid for twice. A CLI that lost the session (new
   * install, cleaned cache, update) fails immediately; the turn is then
   * repeated with the full briefing instead of being reported as broken.
   */
  const runSingle = async (useSession: boolean): Promise<Outcome> => {
    if (!useSession) {
      const result = await runOnce(fullPrompt(), { mode: input.mode })
      await rememberSession(result)
      return toOutcome(result)
    }

    const result = await runOnce(
      buildCliResumePrompt({
        prompt: input.prompt,
        mode: input.mode,
        ...(input.attachments?.length ? { attachments: input.attachments } : {})
      }),
      { mode: input.mode, continueSession: true }
    )

    if (failedFast(result)) {
      if (input.stateDir) await clearCliSession(input.stateDir, input.profile.id)
      const retried = await runOnce(fullPrompt(), { mode: input.mode })
      await rememberSession(retried)
      return toOutcome(retried)
    }

    await rememberSession(result)
    return toOutcome(result)
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
      return runSingle(false)
    }

    // The plan is the moment the user can still say no. Starting five CLI
    // processes without showing what they are is a surprise, not a feature.
    if (input.askPermission) {
      const decision = await input.askPermission({
        id: `cli-team-${Date.now()}`,
        tool: 'cli-team',
        title: `Dividere il turno in ${plan.items.length} parti in parallelo?`,
        detail: plan.items
          .map(
            (item, index) =>
              `${index + 1}. ${item.title}${
                item.files.length > 0 ? ` — ${item.files.join(', ')}` : ''
              }`
          )
          .join('\n'),
        risk: 'medium'
      })
      if (decision === 'deny') return runSingle(false)
    }

    input.emit({
      type: 'tool-call',
      id: `cli-plan-${Date.now()}`,
      name: 'cli-plan',
      title: `Squadra: ${plan.items.length} lavori indipendenti`,
      input: { items: plan.items.map((entry) => entry.title) }
    })

    const waves = scheduleWaves(plan.items, maxWorkers)
    type TeamItem = (typeof plan.items)[number]
    const reports: { item: TeamItem; text: string; error?: string }[] = []
    let workerIndex = 0
    const workerModel = `${input.profile.label}${input.model ? ` · ${input.model}` : ''}`

    /**
     * One team worker, start to end. A failed one registers its own retry: the
     * card can run it again while the other workers keep going.
     */
    const runWorker = async (
      item: TeamItem,
      agentId: string,
      index: number
    ): Promise<{ item: TeamItem; text: string; error?: string }> => {
      const startedAt = Date.now()
      turn.subagentStart({
        agentId,
        name: item.title,
        description: item.instructions.slice(0, 200),
        modelKey: workerModel
      })
      // Each worker has its own signal: stopping one leaves the wave alive.
      const lease = cancellation.register(agentId, input.signal)
      try {
        const result = await runOnce(
          workerPrompt({
            item,
            index,
            total: plan.items.length,
            workspace: input.workspace,
            ...(projectContext ? { context: projectContext } : {})
          }),
          {
            mode: 'build',
            quiet: true,
            agent: { id: agentId, name: item.title },
            signal: lease.signal
          }
        )
        const failed =
          result.error ??
          (result.aborted ? 'fermato dall’utente' : result.timedOut ? 'timeout' : undefined)
        turn.subagentEnd({
          agentId,
          name: item.title,
          ok: !failed,
          summary:
            failed ?? ((result.text.trim().split('\n')[0] ?? '').slice(0, 200) || 'fatto'),
          ms: Date.now() - startedAt
        })
        // Same agent id on retry: the card is reused, not duplicated.
        if (failed) input.retries?.register(agentId, () => runWorker(item, agentId, index).then(() => undefined))
        else input.retries?.release(agentId)
        return {
          item,
          text: result.text,
          ...(failed ? { error: failed } : {})
        }
      } finally {
        lease.release()
      }
    }

    for (const wave of waves) {
      if (input.signal?.aborted) break
      const results = await Promise.all(
        wave.map((item) => {
          const index = ++workerIndex
          return runWorker(item, `cli-worker-${index}`, index)
        })
      )
      reports.push(...results)
    }

    if (input.signal?.aborted) {
      // The CLI's last session is a worker, not the conversation: the next turn
      // must send the briefing again instead of continuing from there.
      if (input.stateDir) await clearCliSession(input.stateDir, input.profile.id)
      return { text: '', aborted: true }
    }

    const integration = await runOnce(
      integrationPrompt({ prompt: input.prompt, workers: reports }),
      { mode: 'build' }
    )

    // Same reason as above: the session now belongs to the integration turn.
    if (input.stateDir) await clearCliSession(input.stateDir, input.profile.id)

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

  /** A team turn owns several processes, so it never resumes a chat session. */
  const resumable = async (): Promise<boolean> => {
    if (input.team === true || !input.stateDir) return false
    if (!input.profile.continueArgs?.length) return false
    return hasCliSession(input.stateDir, input.profile.id, input.workspace)
  }

  const outcome =
    input.team === true && input.mode === 'build'
      ? await runTeam()
      : await runSingle(await resumable())

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
        turn.fileWrite({
          path: change.path,
          title: `Scrittura tramite CLI: ${change.displayPath}`,
          summary: diff
            ? `${diff.added} aggiunte, ${diff.removed} rimosse`
            : 'file modificato',
          ...(diff ? { diff } : {})
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
      turn.fileWrite({
        path,
        title: `Scrittura tramite CLI: ${path}`,
        summary: removed.includes(path)
          ? 'file rimosso (progetto senza git)'
          : 'file modificato (progetto senza git)'
      })
    }
  }

  const ms = Date.now() - started
  const aborted = outcome.aborted
  // The backend owns its stream: the failure is reported before the turn
  // closes, so the caller only records it.
  if (outcome.error) turn.error(outcome.error, modelKey)
  turn.done({
    modelKey,
    ms,
    ttftMs: Math.max(0, (firstTextAt ?? started) - started),
    steps: 1,
    toolCalls: turn.toolCalls,
    ...(aborted ? { aborted: true } : {})
  })

  return {
    text: outcome.text,
    modelKey,
    ...(outcome.error ? { error: outcome.error } : {}),
    aborted,
    steps: 1,
    toolCalls: turn.toolCalls
  }
}

/** Everything a CLI backend needs except the per-turn fields of the contract. */
export type CliBackendInput = Omit<CliTurnInput, 'emit' | 'mode' | 'workspace' | 'signal'>

/**
 * A CLI as an `AgentBackend`. The turn's workspace, mode, signal and stream
 * come from the caller; the profile, model and prompt belong to this backend.
 */
export function cliBackend(input: CliBackendInput): AgentBackend {
  return {
    kind: 'cli',
    label: input.profile.label,
    run: (context) =>
      runCliTurn({
        ...input,
        mode: context.mode,
        workspace: context.workspace,
        ...(context.signal ? { signal: context.signal } : {}),
        emit: context.emit
      })
  }
}
