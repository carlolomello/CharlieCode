import { describe, expect, it } from 'vitest'
import { isExclusiveCommand, resetExclusiveQueues, withExclusive } from './exclusive'

/**
 * Parallel subagents are the reason this exists: two deploys to the same org in
 * parallel do not "go faster", they collide.
 */
describe('exclusive commands', () => {
  it('recognises the commands that must not run twice at once', () => {
    expect(isExclusiveCommand('sf project deploy start -o prod')).toBe(true)
    expect(isExclusiveCommand('sf project deploy validate -o prod')).toBe(true)
    expect(isExclusiveCommand('pnpm publish')).toBe(true)
    expect(isExclusiveCommand('git push origin main')).toBe(true)
    expect(isExclusiveCommand('prisma migrate deploy')).toBe(true)
  })

  it('leaves normal work parallel', () => {
    expect(isExclusiveCommand('pnpm test')).toBe(false)
    expect(isExclusiveCommand('sf apex run test -o dev')).toBe(false)
    expect(isExclusiveCommand('git status')).toBe(false)
    expect(isExclusiveCommand('sf project deploy report')).toBe(false)
  })

  it('runs queued work one at a time, in order', async () => {
    resetExclusiveQueues()
    const log: string[] = []

    const slow = (name: string, ms: number): Promise<void> =>
      withExclusive('exclusive', async () => {
        log.push(`${name}:start`)
        await new Promise((resolve) => setTimeout(resolve, ms))
        log.push(`${name}:end`)
      })

    await Promise.all([slow('a', 30), slow('b', 5), slow('c', 1)])

    expect(log).toEqual([
      'a:start',
      'a:end',
      'b:start',
      'b:end',
      'c:start',
      'c:end'
    ])
  })

  it('a failing task does not block the ones after it', async () => {
    resetExclusiveQueues()
    const done: string[] = []

    const failing = withExclusive('exclusive', async () => {
      throw new Error('deploy rotto')
    })
    await expect(failing).rejects.toThrow('deploy rotto')

    await withExclusive('exclusive', async () => {
      done.push('dopo')
    })
    expect(done).toEqual(['dopo'])
  })
})
