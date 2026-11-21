/**
 * Stops one subagent without stopping the turn.
 *
 * Aborting the turn kills every worker at once, which is the wrong tool when a
 * single one is stuck: the other three are still doing useful work. Every
 * worker gets its own controller combined with the turn's signal, so the stop
 * button on one card and the stop button of the app both work, and neither has
 * to know about the other.
 */

function combine(parent: AbortSignal | undefined, own: AbortSignal): AbortSignal {
  if (!parent) return own
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([parent, own])
  // A system Node older than 20.3 may run the headless CLI: keep a fallback.
  const merged = new AbortController()
  const forward = (): void => merged.abort()
  if (parent.aborted || own.aborted) merged.abort()
  else {
    parent.addEventListener('abort', forward, { once: true })
    own.addEventListener('abort', forward, { once: true })
  }
  return merged.signal
}

export interface WorkerLease {
  signal: AbortSignal
  release: () => void
}

export class TurnCancellation {
  private readonly controllers = new Map<string, AbortController>()

  /** Workers that can still be stopped. */
  get running(): number {
    return this.controllers.size
  }

  register(agentId: string, parent?: AbortSignal): WorkerLease {
    const own = new AbortController()
    this.controllers.set(agentId, own)
    return {
      signal: combine(parent, own.signal),
      release: () => {
        // A cancelled worker is already gone from the map: the identity check
        // keeps a late release from deleting a newer registration.
        if (this.controllers.get(agentId) === own) this.controllers.delete(agentId)
      }
    }
  }

  /** Runs a worker under its own signal, releasing it even when it throws. */
  async run<T>(
    agentId: string,
    parent: AbortSignal | undefined,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const lease = this.register(agentId, parent)
    try {
      return await task(lease.signal)
    } finally {
      lease.release()
    }
  }

  /** False when the worker already ended: a late click is not an error. */
  cancel(agentId: string): boolean {
    const controller = this.controllers.get(agentId)
    if (!controller) return false
    controller.abort()
    this.controllers.delete(agentId)
    return true
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }
}
