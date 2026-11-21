import type { ModelMessage } from 'ai'
import type { AgentMode, EngineEvent, TokenUsage } from './types'

/**
 * One turn of a conversation, whichever backend runs it.
 *
 * A native model loop and a user's CLI used to be two separate code paths that
 * happened to produce the same events. They now implement the same contract, so
 * the caller saves one result shape and a third backend (a local server, a
 * remote agent) only has to implement `run`.
 *
 * Two rules belong to the backend, not to the caller:
 *
 *  - it reports its own `start`/`done`/`error` in the stream, through
 *    `TurnEmitter`, so a turn never ends twice or stays open;
 *  - it returns the model that actually answered, because a fallback or a CLI
 *    profile can replace the one that was requested.
 */

export interface AgentBackendContext {
  /** Project the turn works on. Never the app directory. */
  workspace: string
  mode: AgentMode
  signal?: AbortSignal
  /** Stream of this turn: events go to the transcript, unchanged. */
  emit: (event: EngineEvent) => void
}

export interface AgentBackendResult {
  text: string
  /** Model (or CLI profile) that produced the answer. */
  modelKey: string
  error?: string
  aborted: boolean
  steps: number
  toolCalls: number
  usage?: TokenUsage
  /**
   * Context a native backend produced, to append to the session sidecar. A CLI
   * keeps its own history inside the CLI, so it has nothing to add.
   */
  newMessages?: ModelMessage[]
}

export interface AgentBackend {
  /** Where the model calls happen: in this process, or inside the user's CLI. */
  readonly kind: 'native' | 'cli'
  /** Name the transcript and the picker show for this backend. */
  readonly label: string
  run(context: AgentBackendContext): Promise<AgentBackendResult>
}
