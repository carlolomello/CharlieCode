import type { ModelMessage } from 'ai'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compactAgentContext,
  readAgentContext,
  readAgentContextRaw,
  sanitizeMessages,
  writeAgentContext
} from './context-store'
import { createPlatform, type Platform } from './platform'

/**
 * The sidecar is what the model sees on the next turn. Two things in it are
 * worse than useless: the provider's reasoning, and an assistant turn that only
 * says "already analysed". Both make a weak model repeat itself instead of
 * working, which is exactly the loop the app was stuck in.
 */
describe('sanitizeMessages', () => {
  it('toglie i reasoning dalle risposte assistente', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'We need to respond. The user keeps asking.' },
          { type: 'text', text: 'Ecco il bug: file.ts:12.' }
        ]
      }
    ] as unknown as ModelMessage[]

    const cleaned = sanitizeMessages(messages)
    expect(JSON.stringify(cleaned)).not.toContain('We need to respond')
    expect(JSON.stringify(cleaned)).toContain('file.ts:12')
  })

  it('scarta un messaggio che resta vuoto dopo il reasoning', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking only' }] }
    ] as unknown as ModelMessage[]

    expect(sanitizeMessages(messages)).toEqual([])
  })

  it('scarta il rifiuto "ho già analizzato" senza tool call', () => {
    const messages = [
      {
        role: 'assistant',
        content: "L'analisi del progetto è già stata completata. Dimmi pure cosa vuoi fare."
      }
    ] as unknown as ModelMessage[]

    expect(sanitizeMessages(messages)).toEqual([])
  })

  it('tiene un messaggio con tool call anche se cita una vecchia analisi', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: "L'analisi è già stata completata, ora controllo i test." },
          { type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: { command: 'ls' } }
        ]
      }
    ] as unknown as ModelMessage[]

    expect(sanitizeMessages(messages)).toHaveLength(1)
  })

  it('lascia intatti i messaggi utente e i tool result', () => {
    const messages = [
      { role: 'user', content: 'analizza il progetto' },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'ls', output: { type: 'text', value: 'a.ts' } }]
      }
    ] as unknown as ModelMessage[]

    expect(sanitizeMessages(messages)).toHaveLength(2)
  })
})

describe('sidecar di contesto', () => {
  let home: string
  let platform: Platform

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'charliecode-context-'))
    platform = createPlatform({ id: 'darwin', env: { HOME: home } })
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  function conversation(turns: number): ModelMessage[] {
    return Array.from({ length: turns }, (_, index) => [
      { role: 'user', content: `Richiesta ${index} ${'x'.repeat(300)}` },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: `Risposta ${index}` },
          { type: 'tool-call', toolCallId: `c${index}`, toolName: 'read', input: { path: `f${index}.ts` } }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: `c${index}`,
            toolName: 'read',
            output: { type: 'text', value: `contenuto ${index} ${'y'.repeat(1_200)}` }
          }
        ]
      }
    ] as unknown as ModelMessage[]).flat()
  }

  it('scrive e rilegge il contesto', async () => {
    const messages = conversation(1)
    await writeAgentContext(platform, 's1', messages)
    expect(await readAgentContextRaw(platform, 's1')).toHaveLength(messages.length)
  })

  it('compatta solo in lettura: il sidecar resta intero', async () => {
    const messages = conversation(8)
    await writeAgentContext(platform, 's1', messages)

    const fitted = await readAgentContext(platform, 's1', 2_500)
    expect(fitted[0]?.role).toBe('system')
    expect(fitted.length).toBeLessThan(messages.length)
    // The stored context is still the full one: compaction is a view.
    expect(await readAgentContextRaw(platform, 's1')).toHaveLength(messages.length)
  })

  it('la compattazione esplicita sostituisce il contesto salvato', async () => {
    const messages = conversation(8)
    await writeAgentContext(platform, 's1', messages)

    const stats = await compactAgentContext(platform, 's1', 2_500)
    expect(stats.compacted).toBe(false)
    expect(stats.tokens).toBeLessThanOrEqual(2_500)
    expect((await readAgentContextRaw(platform, 's1')).length).toBeLessThan(messages.length)
  })

  it('un sidecar rotto non blocca la conversazione', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(platform.configPath('sessions'), { recursive: true })
    await writeFile(platform.configPath('sessions', 's1.context.json'), '{rotto')
    expect(await readAgentContextRaw(platform, 's1')).toEqual([])
  })
})
