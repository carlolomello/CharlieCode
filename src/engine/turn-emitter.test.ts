import { describe, expect, it } from 'vitest'
import { nestedTurnEmit, TurnEmitter } from './turn-emitter'
import type { EngineEvent } from './types'

function setup(maxActivity?: number): { events: EngineEvent[]; turn: TurnEmitter } {
  const events: EngineEvent[] = []
  const turn = new TurnEmitter({
    emit: (event) => events.push(event),
    idPrefix: 'cli',
    ...(maxActivity !== undefined ? { maxActivity } : {})
  })
  return { events, turn }
}

describe('TurnEmitter', () => {
  it('attribuisce delta e ragionamento al subagente che li produce', () => {
    const { events, turn } = setup()

    turn.delta('ciao', { id: 'agent-1', name: 'Esploratore' })
    turn.delta('senza padrone')
    turn.thinking('penso', { id: 'agent-1', name: 'Esploratore' })

    expect(events[0]).toEqual({ type: 'delta', text: 'ciao', agentId: 'agent-1' })
    expect(events[1]).toEqual({ type: 'delta', text: 'senza padrone' })
    expect(events[2]).toEqual({ type: 'thinking', text: 'penso', agentId: 'agent-1' })
  })

  it('non emette delta vuoti', () => {
    const { events, turn } = setup()
    turn.delta('')
    expect(events).toHaveLength(0)
  })

  it('ferma le righe di avanzamento al tetto e le conta come tool', () => {
    const { events, turn } = setup(3)

    expect(turn.activity('prima')).toBe(true)
    expect(turn.activity('seconda')).toBe(true)
    expect(turn.activity('terza')).toBe(true)
    expect(turn.activity('quarta')).toBe(false)
    expect(turn.saturated).toBe(true)

    expect(events.filter((event) => event.type === 'tool-call')).toHaveLength(3)
    expect(turn.toolCalls).toBe(3)
  })

  it('usa id distinti e riconoscibili per attività e note', () => {
    const { events, turn } = setup()

    turn.activity('leggo')
    turn.warning('il modello non è stato applicato')
    turn.activity('scrivo')

    const ids = events
      .filter((event) => event.type === 'tool-call')
      .map((event) => (event.type === 'tool-call' ? event.id : ''))

    expect(new Set(ids).size).toBe(3)
    expect(ids[0]).toBe('cli-activity-1')
    expect(ids[1]).toBe('cli-warning-2')
  })

  it('una nota della CLI non conta come lavoro svolto', () => {
    const { events, turn } = setup()
    turn.warning('nota')

    expect(turn.toolCalls).toBe(0)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ type: 'tool-result', name: 'cli-warning', ok: true })
  })

  it('una scrittura della CLI è una riga con il suo diff', () => {
    const { events, turn } = setup()
    turn.fileWrite({
      path: 'src/a.ts',
      title: 'Scrittura tramite CLI: src/a.ts',
      summary: '2 aggiunte, 1 rimosse',
      diff: { path: 'src/a.ts', displayPath: 'src/a.ts', added: 2, removed: 1, unified: '' }
    })

    expect(turn.toolCalls).toBe(1)
    expect(events[0]).toMatchObject({ type: 'tool-call', id: 'cli-write-src/a.ts' })
    expect(events[1]).toMatchObject({
      type: 'tool-result',
      name: 'cli-write',
      summary: '2 aggiunte, 1 rimosse',
      diff: { path: 'src/a.ts' }
    })
  })

  it('riporta token e step del worker solo quando ci sono', () => {
    const { events, turn } = setup()

    turn.subagentEnd({ agentId: 'a', name: 'A', ok: true, summary: 'fatto', ms: 10 })
    turn.subagentEnd({
      agentId: 'b',
      name: 'B',
      ok: true,
      summary: 'fatto',
      ms: 20,
      usage: { outputTokens: 120 },
      steps: 3
    })

    expect(events[0]).not.toHaveProperty('usage')
    expect(events[0]).not.toHaveProperty('steps')
    expect(events[1]).toMatchObject({ usage: { outputTokens: 120 }, steps: 3 })
  })

  it('un subagente non può chiudere il turno del padre', () => {
    const events: EngineEvent[] = []
    const emit = nestedTurnEmit((event) => events.push(event))

    emit({ type: 'delta', text: 'ciao', agentId: 'a' })
    emit({ type: 'start', modelKey: 'p::m', label: 'M' })
    emit({ type: 'done', modelKey: 'p::m', ms: 10, ttftMs: 1, steps: 2, toolCalls: 1 })
    emit({ type: 'error', message: 'rate limit' })
    emit({ type: 'tool-call', id: 't1', name: 'read', title: 'Leggo', agentId: 'a' })
    emit({ type: 'subagent-start', agentId: 'b', name: 'B', description: 'd', modelKey: 'm' })

    expect(events.map((event) => event.type)).toEqual(['delta', 'tool-call', 'subagent-start'])
  })

  it('una chiamata della CLI diventa una riga sola, con comando e output', () => {
    const { events, turn } = setup()

    turn.tool({
      id: 'cli-tool-1',
      name: 'bash',
      title: 'ls -1 .',
      status: 'ok',
      input: { command: 'ls -1 .' },
      output: 'a.txt\nb.txt',
      ms: 12
    })

    expect(turn.toolCalls).toBe(1)
    expect(events[0]).toMatchObject({
      type: 'tool-call',
      id: 'cli-tool-1',
      name: 'bash',
      title: 'ls -1 .',
      input: { command: 'ls -1 .' }
    })
    expect(events[1]).toMatchObject({
      type: 'tool-result',
      ok: true,
      summary: 'a.txt',
      output: 'a.txt\nb.txt',
      ms: 12
    })
  })

  it('una chiamata in corso resta aperta e si chiude una volta sola', () => {
    const { events, turn } = setup()

    turn.tool({ id: 't1', name: 'bash', title: 'sleep 3', status: 'running' })
    turn.tool({ id: 't1', name: 'bash', title: 'sleep 3', status: 'ok', output: 'fatto' })
    turn.tool({ id: 't1', name: 'bash', title: 'sleep 3', status: 'ok', output: 'fatto' })

    expect(events.filter((event) => event.type === 'tool-call')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'tool-result')).toHaveLength(1)
    expect(turn.toolCalls).toBe(1)
  })

  it('un risultato senza nome usa quello della chiamata', () => {
    const { events, turn } = setup()

    turn.tool({ id: 't1', name: 'read', title: 'a.txt', status: 'running' })
    turn.tool({ id: 't1', name: '', title: '', status: 'error', output: 'permesso negato' })

    expect(events[1]).toMatchObject({
      type: 'tool-result',
      name: 'read',
      ok: false,
      summary: 'permesso negato'
    })
  })

  it('marca il turno interrotto solo quando lo è', () => {
    const { events, turn } = setup()

    turn.done({ modelKey: 'cli:uno', ms: 5, ttftMs: 1, steps: 1, toolCalls: 0 })
    turn.done({ modelKey: 'cli:uno', ms: 5, ttftMs: 1, aborted: true })

    expect(events[0]).not.toHaveProperty('aborted')
    expect(events[1]).toMatchObject({ type: 'done', aborted: true })
  })
})
