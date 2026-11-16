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

/**
 * Assistant text whose only content is "I already did this". A weak model reads
 * it back and continues the refusal instead of working: it is the one message
 * class that must never be replayed.
 */
const META_REFUSAL =
  /(già\s+(stata\s+)?(completata|effettuata|analizzata)|già\s+completato|ho\s+già\s+(analizzato|fatto)|already\s+(completed|analysed|analyzed|done))/i

function isReasoningPart(part: unknown): boolean {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'reasoning'
  )
}

function textOf(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
}

/**
 * Cleans a model context before it is stored or replayed:
 *  - reasoning parts are internal monologue and must never go back to the model;
 *  - an assistant turn with no tool call that only says "already analysed" is
 *    poison: replaying it teaches the model to repeat itself instead of working.
 */
export function sanitizeMessages(messages: ModelMessage[]): ModelMessage[] {
  const cleaned: ModelMessage[] = []

  for (const message of messages) {
    let content = message.content
    if (typeof content !== 'string') {
      const parts = content.filter((part) => !isReasoningPart(part))
      if (parts.length === 0) continue
      content = parts as typeof content
    }

    if (message.role === 'assistant') {
      const text = textOf(content)
      const hasToolCall =
        Array.isArray(content) && content.some((part) => part.type === 'tool-call')
      if (!hasToolCall && text.length < 600 && META_REFUSAL.test(text)) continue
    }

    cleaned.push(
      content === message.content ? message : ({ ...message, content } as ModelMessage)
    )
  }

  return cleaned
}

export async function readAgentContext(
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

export async function writeAgentContext(
  platform: Platform,
  sessionId: string,
  messages: ModelMessage[]
): Promise<void> {
  const path = contextPath(platform, sessionId)
  await writeFile(path, `${JSON.stringify(sanitizeMessages(messages))}\n`, 'utf8')
}

export async function deleteAgentContext(platform: Platform, sessionId: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(contextPath(platform, sessionId), { force: true })
}
