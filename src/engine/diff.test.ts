import { describe, expect, it } from 'vitest'
import { createDiff, diffSummary } from './diff'

describe('createDiff', () => {
  it('marca un file nuovo e conta le righe aggiunte', () => {
    const diff = createDiff('src/a.ts', '', 'riga uno\nriga due\n')
    expect(diff.created).toBe(true)
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(0)
    expect(diff.unified).toContain('+riga uno')
  })

  it('produce un diff unificato con aggiunte e rimozioni', () => {
    const diff = createDiff('src/b.ts', 'const a = 1\nconst b = 2\n', 'const a = 1\nconst b = 3\n')
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.unified).toContain('-const b = 2')
    expect(diff.unified).toContain('+const b = 3')
    expect(diff.created).toBe(false)
  })

  it('non esplode su file enormi (usa il diff grossolano)', () => {
    const before = Array.from({ length: 1200 }, (_, index) => `riga ${index}`).join('\n')
    const after = `${before}\nriga nuova`
    const diff = createDiff('big.txt', before, after)
    expect(diff.added).toBeGreaterThan(0)
    expect(diff.unified.length).toBeGreaterThan(0)
  })

  it('riporta nessuna differenza quando i contenuti coincidono', () => {
    const diff = createDiff('same.txt', 'x\ny', 'x\ny')
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(0)
    expect(diff.unified).toBe('Nessuna differenza.')
  })
})

describe('diffSummary', () => {
  it('riassume creazione, sola aggiunta, sola rimozione e mista', () => {
    expect(diffSummary(createDiff('a', '', 'x'))).toContain('nuovo file')
    expect(diffSummary(createDiff('a', 'x', 'x\ny'))).toContain('+1')
    expect(diffSummary(createDiff('a', 'x\ny', 'x'))).toContain('-1')
    expect(diffSummary(createDiff('a', 'x', 'y'))).toContain('+1 / -1')
  })
})
