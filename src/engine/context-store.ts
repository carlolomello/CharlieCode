import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import type { ModelMessage } from 'ai'
import type { Platform } from './platform'

/**
 * The exact model context of a conversation (assistant tool calls and tool
 * results included), stored next to the human-readable JSONL transcript.
 *
 * The JSONL is what the UI shows and what survives a reload; this sidecar is
 * what keeps the model coherent across turns when tools are involved.
 */

const CONTEXT_DIR = 'sessions'
const CONTEXT_SUFFIX = '.context.json'

function contextPath(platform: Platform, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '')
  return platform.configPath(CONTEXT_DIR, `${safe}${CONTEXT_SUFFIX}`)
}

export async function readAgentContext(
  platform: Platform,
  sessionId: string
): Promise<ModelMessage[]> {
  const path = contextPath(platform, sessionId)
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(parsed) ? (parsed as ModelMessage[]) : []
  } catch {
    // A broken sidecar must not block the conversation: fall back to the JSONL.
    return []
  }
}

export async function writeAgentContext(
  platform: Platform,
  sessionId: string,
  messages: ModelMessage[]
): Promise<void> {
  const path = contextPath(platform, sessionId)
  await writeFile(path, `${JSON.stringify(messages)}\n`, 'utf8')
}

export async function deleteAgentContext(platform: Platform, sessionId: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(contextPath(platform, sessionId), { force: true })
}
