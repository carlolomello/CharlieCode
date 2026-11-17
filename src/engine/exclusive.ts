/**
 * One-at-a-time for commands with side effects outside the project.
 *
 * Subagents share the working tree and run in parallel. That is fine for
 * writing different files, and wrong for anything that talks to a server: two
 * `sf project deploy start` in parallel either collide on the org lock or leave
 * a half-deployed state, and a `git push` that starts before the other finishes
 * pushes a tree nobody reviewed.
 *
 * So these commands are serialized process-wide: the second waits for the first
 * instead of racing it. The prompt also tells the orchestrator to run them once,
 * after the workers; this is the belt to that braces.
 */

const EXCLUSIVE_PATTERNS: RegExp[] = [
  // Salesforce: deploys, validations and org-level changes.
  // `deploy start|validate|quick|resume|cancel` writes to the org; `deploy report`
  // only reads a status, so it stays parallel.
  /\bsf\s+project\s+deploy(\s+(start|validate|quick|resume|cancel)\b|\s*$)/i,
  /\bsfdx\s+force:source:deploy\b/i,
  /\bsf\s+project\s+retrieve\b/i,
  /\bsf\s+org\s+(create|delete|auth)\b/i,
  // Package registries and releases.
  /\b(npm|pnpm|yarn|bun)\s+publish\b/i,
  /\bgh\s+release\b/i,
  /\bdocker\s+push\b/i,
  // Remotes and infrastructure.
  /\bgit\s+push\b/i,
  /\bterraform\s+apply\b/i,
  /\bprisma\s+migrate\b/i,
  /\balembic\s+upgrade\b/i,
  /\bsupabase\s+db\s+push\b/i
]

export function isExclusiveCommand(command: string): boolean {
  return EXCLUSIVE_PATTERNS.some((pattern) => pattern.test(command))
}

const queues = new Map<string, Promise<unknown>>()

/** Runs `work` after everything already queued under the same key. */
export function withExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  // A rejected task must not break the chain for everyone after it.
  const run = previous.then(work, work)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

/** Only for tests: forget the queues between cases. */
export function resetExclusiveQueues(): void {
  queues.clear()
}
