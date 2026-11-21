/**
 * Runs subagents in parallel without letting them trample each other.
 *
 * Two problems showed up once a model could emit several `task` calls in one
 * step:
 *
 *  - the SDK executes tool calls of a step with no concurrency limit, so six
 *    `task` calls meant six full agent loops against the same provider at the
 *    same moment (rate limits, quota, memory);
 *  - nothing stopped two `implementer` subagents from writing the same file,
 *    which is a race the user only notices when the last writer wins.
 *
 * The pool fixes both without touching the agent loop: a task declares the
 * files it will touch, waits for a free slot and for the files to be free, and
 * releases both when it ends. A task that declares no files is independent by
 * definition and only obeys the concurrency limit.
 *
 * The lease is a scheduler, not a sandbox: it prevents concurrent writes to the
 * same file, it does not forbid a subagent from writing outside its list. That
 * is deliberate — a new file that does not exist yet cannot be listed, and
 * refusing it would break legitimate work.
 */

/** Hard ceiling, so a bad config cannot open an unbounded number of loops. */
export const MAX_PARALLEL_SUBAGENTS = 8
export const DEFAULT_PARALLEL_SUBAGENTS = 3

/**
 * Comparable form of a declared path. Case-insensitive on purpose: macOS and
 * Windows file systems are, and over-blocking a pair of paths costs a little
 * parallelism, while under-blocking costs a lost write.
 */
function scopeOf(files: string[]): string[] {
  const seen = new Set<string>()
  for (const raw of files) {
    const path = raw
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '')
    if (path) seen.add(path.toLowerCase())
  }
  return [...seen]
}

/** True when two scopes name at least one file in common. */
export function scopesOverlap(left: string[], right: string[]): boolean {
  const owned = new Set(scopeOf(left))
  if (owned.size === 0) return false
  return scopeOf(right).some((file) => owned.has(file))
}

interface Waiter {
  files: string[]
  start: () => void
}

export class SubagentPool {
  private readonly limit: number
  private readonly active: string[][] = []
  private readonly queue: Waiter[] = []

  constructor(limit: number = DEFAULT_PARALLEL_SUBAGENTS) {
    this.limit = Number.isFinite(limit)
      ? Math.min(MAX_PARALLEL_SUBAGENTS, Math.max(1, Math.round(limit)))
      : DEFAULT_PARALLEL_SUBAGENTS
  }

  /** Subagents currently running. */
  get running(): number {
    return this.active.length
  }

  /** Subagents waiting for a slot or for their files. */
  get waiting(): number {
    return this.queue.length
  }

  get size(): number {
    return this.limit
  }

  async run<T>(files: string[], task: () => Promise<T>): Promise<T> {
    const scope = scopeOf(files)
    await this.acquire(scope)
    try {
      return await task()
    } finally {
      this.release(scope)
    }
  }

  private canStart(files: string[]): boolean {
    if (this.active.length >= this.limit) return false
    return !this.active.some((running) => scopesOverlap(running, files))
  }

  private acquire(files: string[]): Promise<void> {
    if (this.canStart(files)) {
      this.active.push(files)
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.queue.push({
        files,
        start: () => {
          this.active.push(files)
          resolve()
        }
      })
    })
  }

  private release(files: string[]): void {
    const index = this.active.indexOf(files)
    if (index >= 0) this.active.splice(index, 1)
    this.drain()
  }

  /**
   * Starts every waiter that now fits, in arrival order. Draining the whole
   * queue (not just the first entry) keeps a blocked file from stalling a slot
   * that another task could use.
   */
  private drain(): void {
    for (let index = 0; index < this.queue.length; index += 1) {
      const waiter = this.queue[index]
      if (!waiter || !this.canStart(waiter.files)) continue
      this.queue.splice(index, 1)
      index -= 1
      waiter.start()
    }
  }
}
