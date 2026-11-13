import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlatform, type Platform } from './platform'
import {
  appendMessage,
  createSession,
  deleteSession,
  deriveTitle,
  listSessions,
  readSession,
  toChatHistory,
  updateSession
} from './sessions'

let home: string
let platform: Platform

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'charliecode-sessions-'))
  platform = createPlatform({ id: 'darwin', env: { HOME: home } })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('deriveTitle', () => {
  it('usa la prima riga piena e la tronca', () => {
    expect(deriveTitle('\n\n  Ciao mondo  \nseconda')).toBe('Ciao mondo')
    expect(deriveTitle('   \n')).toBe('Nuova chat')
    expect(deriveTitle('x'.repeat(80))).toHaveLength(64)
  })
})

describe('sessions', () => {
  it('crea, aggiunge messaggi e rilegge la conversazione', async () => {
    const session = await createSession(platform, { modelKey: 'zen::x', effort: 'high' })
    expect(session.title).toBe('Nuova chat')

    await appendMessage(platform, session.id, {
      id: 'm1',
      role: 'user',
      content: 'Spiegami il progetto',
      createdAt: '2026-01-01T10:00:00.000Z'
    })
    await appendMessage(platform, session.id, {
      id: 'm2',
      role: 'assistant',
      content: 'Certo.',
      createdAt: '2026-01-01T10:00:05.000Z',
      modelKey: 'zen::x'
    })

    const stored = await readSession(platform, session.id)
    expect(stored?.messages).toHaveLength(2)
    expect(stored?.title).toBe('Spiegami il progetto')
    expect(stored?.modelKey).toBe('zen::x')
    expect(stored?.effort).toBe('high')
    expect(stored?.updatedAt).toBe('2026-01-01T10:00:05.000Z')
  })

  it('elenca le sessioni più recenti per prime con anteprima', async () => {
    const first = await createSession(platform, { title: 'Prima' })
    await appendMessage(platform, first.id, {
      id: 'a',
      role: 'user',
      content: 'uno',
      createdAt: '2026-01-01T09:00:00.000Z'
    })
    const second = await createSession(platform, { title: 'Seconda' })
    await appendMessage(platform, second.id, {
      id: 'b',
      role: 'user',
      content: 'due',
      createdAt: '2026-01-02T09:00:00.000Z'
    })

    const list = await listSessions(platform)
    expect(list.map((entry) => entry.title)).toEqual(['Seconda', 'Prima'])
    expect(list[0]?.messageCount).toBe(1)
    expect(list[0]?.preview).toBe('due')
  })

  it('aggiorna titolo, modello ed effort', async () => {
    const session = await createSession(platform)
    const updated = await updateSession(platform, session.id, {
      title: 'Rinominata',
      modelKey: 'freellmapi::auto',
      effort: 'max'
    })
    expect(updated?.title).toBe('Rinominata')
    expect((await readSession(platform, session.id))?.effort).toBe('max')
  })

  it('elimina e sopravvive a un id sconosciuto', async () => {
    const session = await createSession(platform)
    expect(await deleteSession(platform, session.id)).toBe(true)
    expect(await readSession(platform, session.id)).toBeUndefined()
    expect(await deleteSession(platform, 'missing')).toBe(false)
    expect(await updateSession(platform, 'missing', { title: 'x' })).toBeUndefined()
  })

  it('ignora una riga JSONL corrotta senza perdere il resto', async () => {
    const session = await createSession(platform)
    await appendMessage(platform, session.id, {
      id: 'm1',
      role: 'user',
      content: 'ok',
      createdAt: '2026-01-01T10:00:00.000Z'
    })
    const { appendFile } = await import('node:fs/promises')
    await appendFile(platform.configPath('sessions', `${session.id}.jsonl`), '{rotto\n')

    const stored = await readSession(platform, session.id)
    expect(stored?.messages.map((message) => message.content)).toEqual(['ok'])
  })
})

describe('toChatHistory', () => {
  it('scarta errori e turni vuoti, tenendo gli allegati', async () => {
    const session = await createSession(platform)
    const base = { createdAt: '2026-01-01T10:00:00.000Z' }
    const history = toChatHistory({
      ...session,
      messages: [
        { ...base, id: '1', role: 'user', content: 'ciao' },
        { ...base, id: '2', role: 'assistant', content: '', error: 'boom' },
        {
          ...base,
          id: '3',
          role: 'user',
          content: '',
          attachments: [{ id: 'a', name: 'x.png', mime: 'image/png', size: 10, kind: 'image' }]
        }
      ]
    })

    expect(history).toHaveLength(2)
    expect(history[0]?.content).toBe('ciao')
    expect(history[1]?.attachments?.[0]?.name).toBe('x.png')
  })
})
