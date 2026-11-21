import { describe, expect, it } from 'vitest'
import { TurnCancellation } from './turn-cancellation'

describe('TurnCancellation', () => {
  it('ferma un worker senza toccare gli altri', () => {
    const cancellation = new TurnCancellation()
    const parent = new AbortController()

    const first = cancellation.register('agent-1', parent.signal)
    const second = cancellation.register('agent-2', parent.signal)

    expect(cancellation.cancel('agent-1')).toBe(true)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(parent.signal.aborted).toBe(false)
  })

  it('fermare il turno ferma ogni worker', () => {
    const cancellation = new TurnCancellation()
    const parent = new AbortController()

    const lease = cancellation.register('agent-1', parent.signal)
    parent.abort()

    expect(lease.signal.aborted).toBe(true)
  })

  it('un worker già finito non è più fermabile', () => {
    const cancellation = new TurnCancellation()
    const lease = cancellation.register('agent-1')
    lease.release()

    expect(cancellation.cancel('agent-1')).toBe(false)
    expect(cancellation.running).toBe(0)
  })

  it('rilascia il worker anche quando il lavoro lancia', async () => {
    const cancellation = new TurnCancellation()

    await expect(
      cancellation.run('agent-1', undefined, async () => {
        throw new Error('rotto')
      })
    ).rejects.toThrow('rotto')

    expect(cancellation.running).toBe(0)
  })

  it('passa al lavoro il signal del worker', async () => {
    const cancellation = new TurnCancellation()
    let seen: AbortSignal | undefined

    await cancellation.run('agent-1', undefined, async (signal) => {
      seen = signal
      cancellation.cancel('agent-1')
    })

    expect(seen?.aborted).toBe(true)
  })

  it('non riapre un worker cancellato con un rilascio tardivo', () => {
    const cancellation = new TurnCancellation()
    const lease = cancellation.register('agent-1')

    cancellation.cancel('agent-1')
    lease.release()

    expect(cancellation.running).toBe(0)
  })
})
