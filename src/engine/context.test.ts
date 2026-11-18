import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  buildSummary,
  compactMessages,
  contextBudget,
  contextStats,
  estimateMessagesTokens,
  estimateTokens,
  trimToolOutputs
} from './context'

/** One user request, one tool call and its result: the atomic unit. */
function turn(index: number, size = 300): ModelMessage[] {
  return [
    { role: 'user', content: `Richiesta numero ${index} ${'x'.repeat(size)}` },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Risposta ${index}` },
        {
          type: 'tool-call',
          toolCallId: `call-${index}`,
          toolName: 'read',
          input: { path: `src/file${index}.ts` }
        }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `call-${index}`,
          toolName: 'read',
          output: { type: 'text', value: `contenuto ${index} ${'y'.repeat(size * 4)}` }
        }
      ]
    }
  ] as unknown as ModelMessage[]
}

function callIds(messages: ModelMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === 'tool-call') ids.add(part.toolCallId)
    }
  }
  return ids
}

function resultIds(messages: ModelMessage[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === 'tool-result') ids.push(part.toolCallId)
    }
  }
  return ids
}

describe('estimateTokens', () => {
  it('stima il testo latino a circa 4 caratteri per token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('non sottostima le scritture larghe', () => {
    // 100 ideogrammi valgono ~100 token, non 25.
    expect(estimateTokens('漢'.repeat(100))).toBe(100)
  })
})

describe('contextBudget', () => {
  it('lascia il 30% per sistema, tool e risposta', () => {
    expect(contextBudget({ contextWindow: 32_768 })).toBe(Math.floor(32_768 * 0.7))
  })

  it('ha un minimo utilizzabile e un tetto', () => {
    expect(contextBudget({ contextWindow: 1_000 })).toBe(2_048)
    expect(contextBudget({ contextWindow: 1_000_000 })).toBe(200_000)
    expect(contextBudget()).toBe(Math.floor(32_768 * 0.7))
  })
})

describe('compactMessages', () => {
  it('non tocca un contesto che sta nel budget', () => {
    const messages = turn(1, 50)
    const result = compactMessages(messages, { budget: 10_000 })
    expect(result.messages).toEqual(messages)
    expect(result.droppedMessages).toBe(0)
  })

  it('tronca un singolo tool result enorme invece di scartare il turno', () => {
    const messages = turn(1, 1_000)
    const huge = JSON.stringify(messages)
    expect(huge.length).toBeGreaterThan(2_000)

    const result = compactMessages(messages, { budget: 10_000, maxToolChars: 500 })
    expect(result.droppedMessages).toBe(0)
    expect(result.trimmedToolResults).toBe(1)
    expect(JSON.stringify(result.messages)).toContain('caratteri omessi')
  })

  it('sostituisce i turni vecchi con un riepilogo e tiene i recenti', () => {
    const messages = Array.from({ length: 10 }, (_, index) => turn(index)).flat()
    const budget = 2_500
    const result = compactMessages(messages, { budget, minTurns: 2 })

    expect(result.droppedTurns).toBeGreaterThan(0)
    expect(result.messages[0]?.role).toBe('system')
    expect(result.estimatedTokens).toBeLessThanOrEqual(budget)

    const summary =
      typeof result.messages[0]?.content === 'string' ? result.messages[0].content : ''
    expect(summary).toContain('Richieste dell’utente')
    expect(summary).toContain('read src/file0.ts')

    const kept = result.messages.filter((message) => message.role !== 'system')
    expect(kept[0]?.role).toBe('user')
    expect(JSON.stringify(kept)).toContain('Richiesta numero 9')
    expect(JSON.stringify(kept)).not.toContain('Richiesta numero 0')
  })

  it('non lascia mai un tool result senza la sua tool call', () => {
    const messages = Array.from({ length: 8 }, (_, index) => turn(index)).flat()
    const result = compactMessages(messages, { budget: 3_000, minTurns: 2 })

    const calls = callIds(result.messages)
    for (const id of resultIds(result.messages)) {
      expect(calls.has(id)).toBe(true)
    }
  })

  it('con un solo turno enorme tiene almeno la richiesta corrente', () => {
    const messages = turn(0, 2_000)
    const result = compactMessages(messages, { budget: 1_200 })
    expect(result.messages.some((message) => message.role === 'user')).toBe(true)
    expect(result.droppedTurns).toBe(0)
    expect(result.estimatedTokens).toBeLessThanOrEqual(1_200)
  })
})

describe('buildSummary', () => {
  it('riassume richieste, lavoro e tool usati', () => {
    const summary = buildSummary([
      ...turn(3, 10),
      { role: 'assistant', content: 'Ho corretto il bug in src/app.ts.' }
    ] as unknown as ModelMessage[])

    expect(summary).toContain('Richiesta numero 3')
    expect(summary).toContain('Risposta 3')
    expect(summary).toContain('read src/file3.ts')
    expect(summary).toContain('Ho corretto il bug')
  })
})

describe('trimToolOutputs', () => {
  it('taglia solo l’output oltre il limite', () => {
    const messages = turn(1, 100)
    const result = trimToolOutputs(messages, 200)
    expect(result.trimmed).toBe(1)
    expect(JSON.stringify(result.messages)).toContain('caratteri omessi')
  })
})

describe('contextStats', () => {
  it('distingue contesto salvato e contesto inviato', () => {
    const messages = Array.from({ length: 10 }, (_, index) => turn(index)).flat()
    const stats = contextStats(messages, 2_500)

    expect(stats.totalTokens).toBeGreaterThan(stats.tokens)
    expect(stats.tokens).toBeLessThanOrEqual(stats.budget)
    expect(stats.compacted).toBe(true)
    expect(stats.droppedMessages).toBeGreaterThan(0)
  })

  it('un contesto corto non risulta compattato', () => {
    const stats = contextStats(turn(1, 20), 10_000)
    expect(stats.compacted).toBe(false)
    expect(stats.tokens).toBe(stats.totalTokens)
    expect(stats.droppedMessages).toBe(0)
  })
})

describe('estimateMessagesTokens', () => {
  it('conta anche le tool call e gli allegati immagine', () => {
    const plain = estimateMessagesTokens([{ role: 'user', content: 'ciao' }])
    const withImage = estimateMessagesTokens([
      {
        role: 'user',
        content: [{ type: 'file', mediaType: 'image/png', data: 'AAAA' }]
      } as unknown as ModelMessage
    ])
    expect(withImage).toBeGreaterThan(plain)
  })
})
