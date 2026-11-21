/**
 * Retries a failed subagent while its turn is still running.
 *
 * A worker that died on a rate limit, a timeout or a CLI that exited badly used
 * to leave the card red and the work lost: the only way back was to send the
 * whole request again, paying for every worker that had succeeded. Each failed
 * worker registers how to run itself once more, and the card's retry button
 * calls it.
 *
 * The registry belongs to one turn: when the turn ends the parent has already
 * integrated the results, so a retry after that would be work the answer does
 * not know about. `main` drops the registry with the turn.
 */

export type SubagentRetry = () => Promise<void>

export class SubagentRetries {
  private readonly entries = new Map<string, SubagentRetry>()
  private running = new Set<string>()

  /** Workers that can be retried right now. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Registers the retry of a worker. The newest attempt wins: a worker retried
   * twice must not be run by two closures at once.
   */
  register(agentId: string, retry: SubagentRetry): void {
    this.entries.set(agentId, retry)
  }

  /** A worker that succeeded, or was stopped, is not offered again. */
  release(agentId: string): void {
    this.entries.delete(agentId)
  }

  /**
   * Runs the retry of one worker. False when it is unknown (a late click after
   * the turn ended) or already running (a double click is not two workers).
   */
  async run(agentId: string): Promise<boolean> {
    const retry = this.entries.get(agentId)
    if (!retry || this.running.has(agentId)) return false
    this.running.add(agentId)
    try {
      await retry()
      return true
    } finally {
      this.running.delete(agentId)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}
