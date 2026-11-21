import { describe, expect, it } from 'vitest'
import { SubagentPool, scopesOverlap } from './subagent-pool'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Lets every already-resolved promise callback run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('scopesOverlap', () => {
  it('compares paths the way a file system does', () => {
    expect(scopesOverlap(['src/a.ts'], ['SRC/A.TS'])).toBe(true)
    expect(scopesOverlap(['./src/a.ts'], ['src/a.ts'])).toBe(true)
    expect(scopesOverlap(['src\\a.ts'], ['src/a.ts'])).toBe(true)
    expect(scopesOverlap(['src/a.ts'], ['src/b.ts'])).toBe(false)
  })

  it('treats an empty scope as independent', () => {
    expect(scopesOverlap([], ['src/a.ts'])).toBe(false)
    expect(scopesOverlap(['src/a.ts'], [])).toBe(false)
  })
})

describe('SubagentPool', () => {
  it('runs at most `limit` subagents at once and starts the next when one ends', async () => {
    const pool = new SubagentPool(2)
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
    const started: number[] = []

    const runs = gates.map((gate, index) =>
      pool.run([`file-${index}.ts`], async () => {
        started.push(index)
        await gate.promise
        return index
      })
    )

    await tick()
    expect(started).toEqual([0, 1])
    expect(pool.running).toBe(2)
    expect(pool.waiting).toBe(1)

    gates[0]!.resolve()
    await tick()
    expect(started).toEqual([0, 1, 2])

    gates[1]!.resolve()
    gates[2]!.resolve()
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2])
    expect(pool.running).toBe(0)
  })

  it('never runs two subagents on the same file, even with a free slot', async () => {
    const pool = new SubagentPool(3)
    const first = deferred<void>()
    const second = deferred<void>()
    const started: string[] = []

    const a = pool.run(['src/app.tsx'], async () => {
      started.push('a')
      await first.promise
    })
    const b = pool.run(['SRC/APP.TSX'], async () => {
      started.push('b')
      await second.promise
    })
    const c = pool.run(['src/other.ts'], async () => {
      started.push('c')
    })

    await tick()
    expect(started).toEqual(['a', 'c'])
    expect(pool.waiting).toBe(1)

    first.resolve()
    await tick()
    expect(started).toEqual(['a', 'c', 'b'])

    second.resolve()
    await Promise.all([a, b, c])
  })

  it('frees the slot when the task throws', async () => {
    const pool = new SubagentPool(1)
    await expect(pool.run([], async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(pool.run([], async () => 'after')).resolves.toBe('after')
    expect(pool.running).toBe(0)
  })

  it('clamps the limit to a usable number', async () => {
    expect(new SubagentPool(0).size).toBe(1)
    expect(new SubagentPool(99).size).toBe(8)
    expect(new SubagentPool(Number.NaN).size).toBe(3)

    const serial = new SubagentPool(1)
    const gate = deferred<void>()
    const started: number[] = []
    const first = serial.run([], async () => {
      started.push(1)
      await gate.promise
    })
    const second = serial.run([], async () => {
      started.push(2)
    })
    await tick()
    expect(started).toEqual([1])
    gate.resolve()
    await Promise.all([first, second])
    expect(started).toEqual([1, 2])
  })
})
