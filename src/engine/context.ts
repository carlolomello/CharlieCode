import type { ModelMessage } from 'ai'
import type { ContextStats, ModelCaps } from './types'

export type { ContextStats } from './types'

/**
 * Context management for one conversation.
 *
 * A coding agent accumulates tool output fast: a few `read` and `bash` results
 * can fill a 32k window in one turn. The JSONL transcript is the source of
 * truth for the UI; this module decides what the *model* gets to see, so the
 * conversation can keep going on small free models without silently losing the
 * thread.
 *
 * Rules:
 *  - never split a turn: an assistant tool-call and its tool result stay
 *    together, otherwise every provider rejects the request;
 *  - always keep the most recent turns verbatim;
 *  - replace older turns with one extractive summary (requests, work done,
 *    tools used), not with a model call: compaction must work offline;
 *  - trim oversized tool outputs before dropping anything.
 */

export interface CompactOptions {
  budget: number
  /** Turns that are never summarized unless there is no other way. */
  minTurns?: number
  /** A single tool result longer than this is elided. */
  maxToolChars?: number
}

export interface CompactResult {
  messages: ModelMessage[]
  estimatedTokens: number
  droppedMessages: number
  droppedTurns: number
  trimmedToolResults: number
}

const DEFAULT_CONTEXT_WINDOW = 32_768
/** Room for the system prompt, tool schemas and the answer itself. */
const BUDGET_RATIO = 0.7
const MAX_BUDGET = 200_000
const MIN_BUDGET = 2_048
/** Never ask a model for less room than a tool call needs to finish. */
const MIN_OUTPUT_TOKENS = 2_048
/** Ceiling for one answer: a whole file fits, and a runaway answer is stopped. */
const MAX_OUTPUT_TOKENS = 16_384
const DEFAULT_MIN_TURNS = 3
const DEFAULT_TOOL_CHARS = 4_000
const HARD_TOOL_CHARS = 800
const SUMMARY_MAX_CHARS = 1_800
const MESSAGE_OVERHEAD = 4
const IMAGE_TOKENS = 1_000

/** CJK, Hangul and full-width punctuation cost roughly one token per char. */
const WIDE_CHARS = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g

/**
 * Cheap token estimate, good enough to decide when to compact.
 * Latin prose and code average ~4 chars per token; wide scripts do not, so
 * they are counted one per character instead of being underestimated 4x.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const wide = text.match(WIDE_CHARS)?.length ?? 0
  return Math.ceil((text.length - wide) / 4) + wide
}

/**
 * Soft token budget for a model. Leaves 30% for the system prompt, the tool
 * schemas and the answer; a model with a tiny window still gets a usable one.
 */
export function contextBudget(caps?: Partial<Pick<ModelCaps, 'contextWindow'>>): number {
  const window =
    caps?.contextWindow && caps.contextWindow > 0 ? caps.contextWindow : DEFAULT_CONTEXT_WINDOW
  return Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, Math.floor(window * BUDGET_RATIO)))
}

/**
 * Room for one answer, tool call included.
 *
 * A coding turn often writes a whole file in a single `write` call. At 4096
 * tokens the JSON was cut mid-way, the call failed, and the same model looked
 * unable to write code while it wrote the file fine in a CLI. The cap follows
 * the model's window instead of being a constant: big models get room, small
 * ones keep a cap that still fits their context.
 */
export function outputTokenBudget(
  caps?: Partial<Pick<ModelCaps, 'contextWindow'>>
): number {
  const window =
    caps?.contextWindow && caps.contextWindow > 0 ? caps.contextWindow : DEFAULT_CONTEXT_WINDOW
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS, Math.floor(window / 4)))
}

/* ------------------------------- sanitize ------------------------------- */

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

/**
 * Appends the current user turn to the stored context.
 *
 * The sidecar is written at the end of a turn, so it never contains the message
 * that opens the next one. Without this append the model answered the previous
 * request on every turn after the first. An identical retry (same content) is
 * not duplicated.
 */
export function appendCurrentUser(
  history: ModelMessage[],
  current: ModelMessage[]
): ModelMessage[] {
  if (current.length === 0) return history
  const last = history[history.length - 1]
  const first = current[0]
  if (
    last &&
    first &&
    last.role === 'user' &&
    first.role === 'user' &&
    JSON.stringify(last.content) === JSON.stringify(first.content)
  ) {
    return history
  }
  return [...history, ...current]
}

/**
 * Removes image parts from a model context.
 *
 * A conversation can move from a vision model to a text-only one. Sending the
 * old images anyway makes the provider reject the whole request, so they are
 * dropped with a short note in their place. The stored sidecar is untouched:
 * switching back to a vision model restores them.
 */
export function stripImages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (typeof message.content === 'string') return message
    const parts = message.content.filter((part) => {
      const candidate = part as { type?: string; mediaType?: string }
      if (candidate.type === 'image') return false
      if (candidate.type === 'file' && candidate.mediaType?.startsWith('image/')) return false
      return true
    })
    if (parts.length === message.content.length) return message
    if (parts.length === 0) {
      return {
        ...message,
        content: '[immagine omessa: il modello in uso non supporta le immagini]'
      } as ModelMessage
    }
    return { ...message, content: parts } as ModelMessage
  })
}

/* ------------------------------- estimates ------------------------------ */

function toolOutputText(output: unknown): string {
  if (typeof output !== 'object' || output === null) return ''
  const record = output as Record<string, unknown>
  switch (record.type) {
    case 'text':
    case 'error-text':
      return String(record.value ?? '')
    case 'json':
    case 'error-json':
      return JSON.stringify(record.value ?? null)
    case 'content':
      if (!Array.isArray(record.value)) return ''
      return record.value
        .map((part) =>
          typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
            ? String((part as { text?: unknown }).text ?? '')
            : ''
        )
        .join('\n')
    default:
      return ''
  }
}

function partTokens(part: unknown): number {
  if (typeof part !== 'object' || part === null) return 0
  const record = part as Record<string, unknown>
  switch (record.type) {
    case 'text':
    case 'reasoning':
      return estimateTokens(String(record.text ?? ''))
    case 'tool-call':
      return 20 + estimateTokens(JSON.stringify(record.input ?? null))
    case 'tool-result':
      return estimateTokens(toolOutputText(record.output))
    case 'file':
    case 'image':
      // Vision tokens depend on the image size, which we do not know here.
      return IMAGE_TOKENS
    default:
      return 8
  }
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += MESSAGE_OVERHEAD
    if (typeof message.content === 'string') {
      total += estimateTokens(message.content)
      continue
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) total += partTokens(part)
    }
  }
  return total
}

/* -------------------------------- trimming ------------------------------- */

function elide(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = Math.max(0, max - head)
  return `${text.slice(0, head)}\n\n[… ${text.length - max} caratteri omessi …]\n\n${text.slice(-tail)}`
}

function trimToolOutput(output: unknown, maxChars: number): unknown {
  if (typeof output !== 'object' || output === null) return output
  const record = output as Record<string, unknown>
  const type = record.type

  if (type === 'text' || type === 'error-text') {
    const value = String(record.value ?? '')
    return value.length > maxChars ? { ...record, value: elide(value, maxChars) } : output
  }

  if (type === 'json' || type === 'error-json') {
    const value = JSON.stringify(record.value ?? null)
    return value.length > maxChars ? { type: 'text', value: elide(value, maxChars) } : output
  }

  if (type === 'content') {
    const value = toolOutputText(output)
    return value.length > maxChars ? { type: 'text', value: elide(value, maxChars) } : output
  }

  return output
}

/**
 * Caps every tool result of the context. Kept separate from `compactMessages`
 * because the store uses it on write: one `bash` dump must not bloat the
 * sidecar for every future turn.
 */
export function trimToolOutputs(
  messages: ModelMessage[],
  maxChars = 20_000
): { messages: ModelMessage[]; trimmed: number } {
  let trimmed = 0

  const output = messages.map((message) => {
    if (message.role !== 'tool' || typeof message.content === 'string') return message
    let changed = false
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part
      const next = trimToolOutput(part.output, maxChars)
      if (next === part.output) return part
      changed = true
      trimmed++
      return { ...part, output: next } as typeof part
    })
    return changed ? ({ ...message, content } as ModelMessage) : message
  })

  return { messages: output, trimmed }
}

/* --------------------------------- turns -------------------------------- */

function groupTurns(messages: ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = []
  for (const message of messages) {
    // A user message opens a turn; assistant and tool messages belong to it.
    // Dropping whole turns is the only safe unit: a tool result without its
    // call is rejected by every provider.
    if (message.role === 'user' || turns.length === 0) turns.push([message])
    else turns[turns.length - 1]!.push(message)
  }
  return turns
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function describeToolCall(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) return undefined
  const record = part as Record<string, unknown>
  if (record.type !== 'tool-call') return undefined
  const name = String(record.toolName ?? 'tool')
  const input = (record.input ?? {}) as Record<string, unknown>
  const detail =
    (typeof input.path === 'string' && input.path) ||
    (typeof input.pattern === 'string' && input.pattern) ||
    (typeof input.command === 'string' && input.command.slice(0, 60)) ||
    (typeof input.description === 'string' && input.description.slice(0, 60)) ||
    ''
  return detail ? `${name} ${detail}` : name
}

/** Keeps first and last entries when a list is too long: both matter. */
function sample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const head = Math.ceil(max / 2)
  const tail = max - head
  return [...items.slice(0, head), ...items.slice(items.length - tail)]
}

/**
 * Extractive summary of the turns being dropped. No model call: compaction
 * must work before any provider is configured, and must never fail a turn.
 */
export function buildSummary(messages: ModelMessage[], maxChars = SUMMARY_MAX_CHARS): string {
  const requests: string[] = []
  const work: string[] = []
  const previous: string[] = []
  const tools: string[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      const text = textOf(message.content)
      if (text.trim()) previous.push(oneLine(text, 400))
      continue
    }

    if (message.role === 'user') {
      const text = textOf(message.content)
      if (text.trim()) requests.push(oneLine(text, 180))
      continue
    }

    if (message.role === 'assistant') {
      const text = textOf(message.content)
      if (text.trim()) work.push(oneLine(text, 180))
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          const description = describeToolCall(part)
          if (description && !tools.includes(description)) tools.push(description)
        }
      }
    }
  }

  const lines = [
    '[Riepilogo automatico dei turni precedenti, compattati per restare nel limite del modello. Il transcript completo resta nella chat.]'
  ]

  if (previous.length > 0) {
    lines.push('Riepiloghi precedenti:')
    for (const entry of sample(previous, 3)) lines.push(`- ${entry}`)
  }
  if (requests.length > 0) {
    lines.push('Richieste dell’utente:')
    for (const entry of sample(requests, 6)) lines.push(`- ${entry}`)
  }
  if (work.length > 0) {
    lines.push('Lavoro svolto:')
    for (const entry of sample(work, 6)) lines.push(`- ${entry}`)
  }
  if (tools.length > 0) {
    lines.push(`Tool usati: ${sample(tools, 12).join(', ')}`)
  }

  return elide(lines.join('\n'), maxChars)
}

function summaryMessage(text: string): ModelMessage {
  return { role: 'system', content: text }
}

/* ------------------------------- compaction ------------------------------ */

function trimAll(
  messages: ModelMessage[],
  maxChars: number
): { messages: ModelMessage[]; trimmed: number } {
  let trimmed = 0
  const output = messages.map((message) => {
    if (message.role !== 'tool' || typeof message.content === 'string') return message
    let changed = false
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part
      const next = trimToolOutput(part.output, maxChars)
      if (next === part.output) return part
      changed = true
      trimmed++
      return { ...part, output: next } as typeof part
    })
    return changed ? ({ ...message, content } as ModelMessage) : message
  })
  return { messages: output, trimmed }
}

/**
 * Fits a model context into `budget`.
 *
 * Order of sacrifice: oversized tool outputs first, then the oldest turns
 * (replaced by a summary), then tool outputs again with a harder cap. The last
 * turn is never dropped: without the current request there is nothing to
 * answer.
 */
export function compactMessages(
  messages: ModelMessage[],
  options: CompactOptions
): CompactResult {
  const budget = Math.max(1_024, Math.floor(options.budget))
  const minTurns = Math.max(1, options.minTurns ?? DEFAULT_MIN_TURNS)
  const maxToolChars = Math.max(400, options.maxToolChars ?? DEFAULT_TOOL_CHARS)

  const sanitized = sanitizeMessages(messages)
  const light = trimAll(sanitized, maxToolChars)
  const lightTokens = estimateMessagesTokens(light.messages)

  if (lightTokens <= budget) {
    return {
      messages: light.messages,
      estimatedTokens: lightTokens,
      droppedMessages: 0,
      droppedTurns: 0,
      trimmedToolResults: light.trimmed
    }
  }

  const turns = groupTurns(light.messages)
  const softMaxDrop = Math.max(0, turns.length - minTurns)

  for (let drop = 1; drop <= softMaxDrop; drop++) {
    const dropped = turns.slice(0, drop).flat()
    const kept = turns.slice(drop).flat()
    const candidate = [summaryMessage(buildSummary(dropped)), ...kept]
    const tokens = estimateMessagesTokens(candidate)
    if (tokens <= budget) {
      return {
        messages: candidate,
        estimatedTokens: tokens,
        droppedMessages: dropped.length,
        droppedTurns: drop,
        trimmedToolResults: light.trimmed
      }
    }
  }

  // Even the last `minTurns` are too big: trim tool outputs harder and allow
  // dropping turns one by one, keeping at least the current request.
  const hard = trimAll(sanitized, Math.min(maxToolChars, HARD_TOOL_CHARS))
  const hardTurns = groupTurns(hard.messages)

  for (let drop = 0; drop < hardTurns.length; drop++) {
    const kept = hardTurns.slice(drop).flat()
    const candidate = drop === 0 ? kept : [summaryMessage(buildSummary(hardTurns.slice(0, drop).flat())), ...kept]
    const tokens = estimateMessagesTokens(candidate)
    if (tokens <= budget) {
      return {
        messages: candidate,
        estimatedTokens: tokens,
        droppedMessages: hardTurns.slice(0, drop).flat().length,
        droppedTurns: drop,
        trimmedToolResults: hard.trimmed
      }
    }
  }

  // A single turn bigger than the whole window (huge paste): keep it as is.
  // Truncating the user's own request would answer the wrong question.
  const last = hardTurns[hardTurns.length - 1] ?? []
  return {
    messages: last,
    estimatedTokens: estimateMessagesTokens(last),
    droppedMessages: Math.max(0, hard.messages.length - last.length),
    droppedTurns: Math.max(0, hardTurns.length - 1),
    trimmedToolResults: hard.trimmed
  }
}

export function contextStats(messages: ModelMessage[], budget: number): ContextStats {
  const sanitized = sanitizeMessages(messages)
  const totalTokens = estimateMessagesTokens(sanitized)
  const compacted = compactMessages(sanitized, { budget })

  return {
    tokens: compacted.estimatedTokens,
    totalTokens,
    budget,
    messages: sanitized.length,
    droppedMessages: compacted.droppedMessages,
    compacted: compacted.estimatedTokens < totalTokens
  }
}
