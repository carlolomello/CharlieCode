import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { ModelMessage } from 'ai'
import {
  compactMessages,
  contextStats,
  sanitizeMessages,
  trimToolOutputs,
  type ContextStats
} from './context'
import type { Platform } from './platform'

/**
 * The exact model context of a conversation (assistant tool calls and tool
 * results included), stored next to the human-readable JSONL transcript.
 *
 * The JSONL is what the UI shows and what survives a reload; this sidecar is
 * what keeps the model coherent across turns when tools are involved.
 *
 * Compaction never rewrites the sidecar on read: the full context stays on
 * disk, the model receives a fitted version, and only an explicit "Compatta"
 * from the user replaces the stored context with its summary.
 */

const CONTEXT_DIR = 'sessions'
const CONTEXT_SUFFIX = '.context.json'
/** One pathological tool dump must not make every future write huge. */
const WRITE_TOOL_CHARS = 80_000

export { sanitizeMessages } from './context'
export type { ContextStats } from './context'

function contextPath(platform: Platform, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '')
  return platform.configPath(CONTEXT_DIR, `${safe}${CONTEXT_SUFFIX}`)
}

/** Raw stored context, sanitized but not compacted. */
export async function readAgentContextRaw(
  platform: Platform,
  sessionId: string
): Promise<ModelMessage[]> {
  const path = contextPath(platform, sessionId)
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(parsed) ? sanitizeMessages(parsed as ModelMessage[]) : []
  } catch {
    // A broken sidecar must not block the conversation: fall back to the JSONL.
    return []
  }
}

/**
 * Context for the next turn. With a budget, the oldest turns are replaced by a
 * summary so a small model can keep working; without one, the stored context
 * is returned untouched.
 */
export async function readAgentContext(
  platform: Platform,
  sessionId: string,
  budget?: number
): Promise<ModelMessage[]> {
  const stored = await readAgentContextRaw(platform, sessionId)
  if (!budget || stored.length === 0) return stored
  return compactMessages(stored, { budget }).messages
}

export async function writeAgentContext(
  platform: Platform,
  sessionId: string,
  messages: ModelMessage[]
): Promise<void> {
  const path = contextPath(platform, sessionId)
  const cleaned = trimToolOutputs(sanitizeMessages(messages), WRITE_TOOL_CHARS).messages
  await mkdir(platform.configPath(CONTEXT_DIR), { recursive: true })
  await writeFile(path, `${JSON.stringify(cleaned)}\n`, 'utf8')
}

/**
 * Stats for the badge in the composer. Legacy sessions have no sidecar: the
 * caller passes the history rebuilt from the transcript as a fallback.
 */
export async function readAgentContextStats(
  platform: Platform,
  sessionId: string,
  budget: number,
  fallback: ModelMessage[] = []
): Promise<ContextStats> {
  const stored = await readAgentContextRaw(platform, sessionId)
  return contextStats(stored.length > 0 ? stored : fallback, budget)
}

/**
 * Explicit compaction: replaces the stored context with the fitted version.
 * The JSONL transcript is untouched, so the chat stays readable and the
 * sidecar can always be rebuilt from it.
 */
export async function compactAgentContext(
  platform: Platform,
  sessionId: string,
  budget: number,
  fallback: ModelMessage[] = []
): Promise<ContextStats> {
  const stored = await readAgentContextRaw(platform, sessionId)
  const source = stored.length > 0 ? stored : fallback
  const result = compactMessages(source, { budget })
  const path = contextPath(platform, sessionId)
  const cleaned = trimToolOutputs(result.messages, WRITE_TOOL_CHARS).messages
  await mkdir(platform.configPath(CONTEXT_DIR), { recursive: true })
  await writeFile(path, `${JSON.stringify(cleaned)}\n`, 'utf8')
  return contextStats(cleaned, budget)
}

export async function deleteAgentContext(platform: Platform, sessionId: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(contextPath(platform, sessionId), { force: true })
}
