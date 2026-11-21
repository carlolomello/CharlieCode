import type { EngineEvent, FileDiff, TokenUsage } from './types'

/** A subagent, when an event has to say who produced it. */
export interface AgentRef {
  id: string
  name: string
}

export interface TurnEmitterOptions {
  emit: (event: EngineEvent) => void
  /**
   * Progress rows a single turn may add to the transcript. A CLI can print
   * hundreds of lines; the transcript is not a log viewer.
   */
  maxActivity?: number
  /** Prefix of the generated ids, e.g. `cli-activity-1`. */
  idPrefix?: string
}

const DEFAULT_MAX_ACTIVITY = 50

/** A CLI that loops can report hundreds of calls: the transcript keeps a page. */
const MAX_TOOL_ROWS = 200

/** Events that describe a turn, not a worker inside it. */
const TURN_LIFECYCLE: ReadonlySet<EngineEvent['type']> = new Set(['start', 'done', 'error'])

/**
 * Wraps `emit` for a nested agent.
 *
 * A subagent is a card inside the turn: its `start`, `done` and `error` are the
 * card's business, and `subagent-start`/`subagent-end` already say them. Sent to
 * the parent stream they ended the main turn in the UI, replaced the model label
 * above the answer and saved the subagent's model and stats on the parent
 * message — the turn looked finished while the other workers were still running.
 */
export function nestedTurnEmit(
  emit: (event: EngineEvent) => void
): (event: EngineEvent) => void {
  return (event) => {
    if (TURN_LIFECYCLE.has(event.type)) return
    emit(event)
  }
}

/**
 * Builds the events of a turn in one place.
 *
 * A native turn and a CLI turn speak the same protocol, and both used to build
 * the same shapes by hand: that is how an event ends up without its `agentId`
 * and lands under the wrong name in the UI. Two rules live here because they
 * must not drift between backends: the transcript keeps only the first N
 * progress rows, and a note from a CLI is a tool row, not a stray line of text.
 */
export class TurnEmitter {
  private readonly emit: (event: EngineEvent) => void
  private readonly maxActivity: number
  private readonly idPrefix: string
  private generated = 0
  private activities = 0
  private writes = 0
  /** Ids already in the transcript, with the name the row was built with. */
  private readonly tools = new Map<string, { name: string }>()
  /** Ids whose result was already reported: a CLI can repeat an event. */
  private readonly closed = new Set<string>()

  constructor(options: TurnEmitterOptions) {
    this.emit = options.emit
    this.maxActivity = Math.max(0, options.maxActivity ?? DEFAULT_MAX_ACTIVITY)
    this.idPrefix = options.idPrefix ?? 'turn'
  }

  /** Tool rows this turn produced: calls, progress lines and files written. */
  get toolCalls(): number {
    return this.activities + this.writes + this.tools.size
  }

  /** The transcript already shows all the progress it accepts. */
  get saturated(): boolean {
    return this.activities >= this.maxActivity
  }

  /**
   * The turn began: the transcript labels the answer with the model that
   * actually produced it, and a fallback says where it came from.
   */
  start(input: { modelKey: string; label: string; fallbackFrom?: string }): void {
    this.emit({
      type: 'start',
      modelKey: input.modelKey,
      label: input.label,
      ...(input.fallbackFrom ? { fallbackFrom: input.fallbackFrom } : {})
    })
  }

  /** A turn that failed. The card stops waiting and shows the reason. */
  error(message: string, modelKey?: string): void {
    this.emit({ type: 'error', message, ...(modelKey ? { modelKey } : {}) })
  }

  delta(text: string, agent?: AgentRef): void {
    if (!text) return
    this.emit({ type: 'delta', text, ...(agent ? { agentId: agent.id } : {}) })
  }

  thinking(text: string, agent?: AgentRef): void {
    if (!text) return
    this.emit({ type: 'thinking', text, ...(agent ? { agentId: agent.id } : {}) })
  }

  step(index: number, agent?: AgentRef): void {
    this.emit({ type: 'step', index, ...(agent ? { agentId: agent.id } : {}) })
  }

  /** One progress line from a CLI. False when the transcript is already full. */
  activity(title: string, agent?: AgentRef): boolean {
    if (this.saturated) return false
    this.activities += 1
    this.pair(this.nextId('activity'), 'cli', title, 'attività riportata dalla CLI', agent)
    return true
  }

  /**
   * One tool call a CLI reported.
   *
   * The row is created on the first event for its id and closed by the first
   * terminal one: a CLI can print a call once when it starts and again when it
   * ends, or — like opencode — a single event with the finished state. Both
   * produce one row, with the command, the path and the output on it.
   */
  tool(
    input: {
      id: string
      name: string
      title: string
      status: 'running' | 'ok' | 'error'
      input?: Record<string, unknown>
      output?: string
      summary?: string
      ms?: number
    },
    agent?: AgentRef
  ): void {
    const attribution = agent ? { agentId: agent.id, agentName: agent.name } : {}
    const known = this.tools.get(input.id)

    if (!known) {
      // A result line without its call has no name and no title to show.
      if (!input.name) return
      if (this.tools.size >= MAX_TOOL_ROWS) return
      this.tools.set(input.id, { name: input.name })
      this.emit({
        type: 'tool-call',
        id: input.id,
        name: input.name,
        title: input.title,
        ...(input.input ? { input: input.input } : {}),
        ...attribution
      })
    }

    if (input.status === 'running' || this.closed.has(input.id)) return
    this.closed.add(input.id)

    const output = input.output?.trim().slice(0, 4_000)
    const firstLine = output
      ?.split('\n')
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 200)
    this.emit({
      type: 'tool-result',
      id: input.id,
      name: known?.name ?? input.name,
      ok: input.status === 'ok',
      summary: input.summary?.trim() || firstLine || (input.status === 'ok' ? 'fatto' : 'errore'),
      ...(output ? { output } : {}),
      ms: input.ms ?? 0,
      ...attribution
    })
  }

  /**
   * A downgrade the user must see — a model the CLI dropped, a flag it refused.
   * It is not a tool call: it describes the turn, it does not count as work.
   */
  warning(summary: string, agent?: AgentRef): void {
    this.pair(this.nextId('warning'), 'cli-warning', 'Nota della CLI', summary, agent)
  }

  /** A file a CLI wrote: it counts as a tool row, so the turn reports it. */
  fileWrite(input: { path: string; title: string; summary: string; diff?: FileDiff }): void {
    this.writes += 1
    const id = `${this.idPrefix}-write-${input.path}`
    this.emit({
      type: 'tool-call',
      id,
      name: 'cli-write',
      title: input.title,
      input: { path: input.path }
    })
    this.emit({
      type: 'tool-result',
      id,
      name: 'cli-write',
      ok: true,
      summary: input.summary,
      ...(input.diff ? { diff: input.diff } : {}),
      ms: 0
    })
  }

  subagentStart(input: {
    agentId: string
    name: string
    description: string
    modelKey: string
  }): void {
    this.emit({ type: 'subagent-start', ...input })
  }

  subagentEnd(input: {
    agentId: string
    name: string
    ok: boolean
    summary: string
    ms: number
    usage?: TokenUsage
    steps?: number
  }): void {
    this.emit({
      type: 'subagent-end',
      agentId: input.agentId,
      name: input.name,
      ok: input.ok,
      summary: input.summary,
      ms: input.ms,
      ...(input.usage ? { usage: input.usage } : {}),
      ...(input.steps !== undefined ? { steps: input.steps } : {})
    })
  }

  done(input: {
    modelKey: string
    ms: number
    ttftMs: number
    steps?: number
    toolCalls?: number
    usage?: TokenUsage
    aborted?: boolean
  }): void {
    this.emit({
      type: 'done',
      modelKey: input.modelKey,
      ms: input.ms,
      ttftMs: input.ttftMs,
      ...(input.steps !== undefined ? { steps: input.steps } : {}),
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      ...(input.aborted ? { aborted: true } : {})
    })
  }

  private nextId(kind: string): string {
    this.generated += 1
    return `${this.idPrefix}-${kind}-${this.generated}`
  }

  private pair(
    id: string,
    name: string,
    title: string,
    summary: string,
    agent?: AgentRef
  ): void {
    const attribution = agent ? { agentId: agent.id, agentName: agent.name } : {}
    this.emit({ type: 'tool-call', id, name, title, ...attribution })
    this.emit({ type: 'tool-result', id, name, ok: true, summary, ms: 0, ...attribution })
  }
}
