import { describe, expect, it } from 'vitest'
import { applyChatEvent, type ChatItem } from './useChat'

function message(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('applyChatEvent', () => {
  it('un retry riusa la card del worker invece di aggiungerne una', () => {
    const first = applyChatEvent(
      message({ pending: true }),
      {
        type: 'subagent-start',
        agentId: 'w1',
        name: 'Worker',
        description: 'fa una cosa',
        modelKey: 'm'
      }
    )
    const failed = applyChatEvent(first, {
      type: 'subagent-end',
      agentId: 'w1',
      ok: false,
      summary: 'rate limit',
      ms: 1200
    })
    const retried = applyChatEvent(failed, {
      type: 'subagent-start',
      agentId: 'w1',
      name: 'Worker',
      description: 'fa una cosa',
      modelKey: 'm'
    })

    expect(retried.subagents).toHaveLength(1)
    expect(retried.subagents?.[0]).toMatchObject({ agentId: 'w1', status: 'running' })
    expect(retried.subagents?.[0]?.summary).toBeUndefined()
  })

  it('due worker diversi restano due card', () => {
    const one = applyChatEvent(message(), {
      type: 'subagent-start',
      agentId: 'w1',
      name: 'A',
      description: 'a',
      modelKey: 'm'
    })
    const two = applyChatEvent(one, {
      type: 'subagent-start',
      agentId: 'w2',
      name: 'B',
      description: 'b',
      modelKey: 'm'
    })

    expect(two.subagents?.map((run) => run.agentId)).toEqual(['w1', 'w2'])
  })

  it('i token del worker finiscono sulla sua card', () => {
    const started = applyChatEvent(message(), {
      type: 'subagent-start',
      agentId: 'w1',
      name: 'A',
      description: 'a',
      modelKey: 'm'
    })
    const ended = applyChatEvent(started, {
      type: 'subagent-end',
      agentId: 'w1',
      ok: true,
      summary: 'fatto',
      ms: 900,
      usage: { outputTokens: 320 },
      steps: 4
    })

    expect(ended.subagents?.[0]).toMatchObject({
      status: 'ok',
      usage: { outputTokens: 320 },
      steps: 4
    })
  })

  it('il testo di un subagente non entra nella risposta principale', () => {
    const item = message({ content: 'risposta' })
    const next = applyChatEvent(item, { type: 'delta', text: 'del worker', agentId: 'w1' })

    expect(next.content).toBe('risposta')
  })

  it('done chiude il turno e riassume i numeri', () => {
    const item = message({ pending: true })
    const next = applyChatEvent(item, {
      type: 'done',
      modelKey: 'a::b',
      ms: 2500,
      ttftMs: 300,
      steps: 3,
      toolCalls: 2,
      usage: { outputTokens: 900 }
    })

    expect(next.pending).toBe(false)
    expect(next.meta).toContain('3 step')
    expect(next.meta).toContain('2 tool')
    expect(next.meta).toContain('900 token')
  })
})
