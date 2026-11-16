import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { sanitizeMessages } from './context-store'

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
