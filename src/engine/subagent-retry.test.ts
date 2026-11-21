import { describe, expect, it } from 'vitest'
import { SubagentRetries } from './subagent-retry'

describe('SubagentRetries', () => {
  it('esegue il worker registrato, con lo stesso id', async () => {
    const retries = new SubagentRetries()
    const calls: string[] = []

    retries.register('w1', async () => {
      calls.push('w1')
    })

    expect(await retries.run('w1')).toBe(true)
    expect(calls).toEqual(['w1'])
  })

  it('un id sconosciuto è un click tardivo, non un errore', async () => {
    const retries = new SubagentRetries()
    expect(await retries.run('mai-esistito')).toBe(false)
  })

  it('non lancia due volte lo stesso worker', async () => {
    const retries = new SubagentRetries()
    let running = 0
    let peak = 0

    retries.register('w1', async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 10))
      running -= 1
    })

    const [first, second] = await Promise.all([retries.run('w1'), retries.run('w1')])

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(peak).toBe(1)
  })

  it('un worker riuscito non si riprova più', async () => {
    const retries = new SubagentRetries()
    let calls = 0
    retries.register('w1', async () => {
      calls += 1
    })
    retries.release('w1')

    expect(await retries.run('w1')).toBe(false)
    expect(calls).toBe(0)
  })

  it('la registrazione più recente sostituisce la precedente', async () => {
    const retries = new SubagentRetries()
    const calls: string[] = []
    retries.register('w1', async () => {
      calls.push('prima')
    })
    retries.register('w1', async () => {
      calls.push('seconda')
    })

    await retries.run('w1')
    expect(calls).toEqual(['seconda'])
  })

  it('la fine del turno cancella i retry', async () => {
    const retries = new SubagentRetries()
    let calls = 0
    retries.register('w1', async () => {
      calls += 1
    })
    retries.clear()

    expect(await retries.run('w1')).toBe(false)
    expect(calls).toBe(0)
  })
})
