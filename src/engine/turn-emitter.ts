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

  constructor(options: TurnEmitterOptions) {
    this.emit = options.emit
    this.maxActivity = Math.max(0, options.maxActivity ?? DEFAULT_MAX_ACTIVITY)
    this.idPrefix = options.idPrefix ?? 'turn'
  }

  /** Tool rows this turn produced: progress lines plus files written. */
  get toolCalls(): number {
    return this.activities + this.writes
  }

  /** The transcript already shows all the progress it accepts. */
  get saturated(): boolean {
    return this.activities >= this.maxActivity
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
