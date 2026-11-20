import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from './atomic-write'

describe('writeFileAtomic', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-atomic-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('scrive un file nuovo', async () => {
    const path = join(dir, 'sessione.jsonl')
    await writeFileAtomic(path, 'uno\n')
    expect(await readFile(path, 'utf8')).toBe('uno\n')
  })

  it('sostituisce il contenuto e non lascia file temporanei', async () => {
    const path = join(dir, 'sessione.jsonl')
    await writeFile(path, 'vecchio\n', 'utf8')

    await writeFileAtomic(path, 'nuovo\n')

    expect(await readFile(path, 'utf8')).toBe('nuovo\n')
    expect(await readdir(dir)).toEqual(['sessione.jsonl'])
  })

  // Windows refuses the rename over a read-only destination with EPERM, and
  // that failure aborted the whole chat turn.
  it('riscrive anche un file di destinazione in sola lettura', async () => {
    const folder = join(dir, 'clis')
    await mkdir(folder)
    const path = join(folder, 'profilo.json')
    await writeFile(path, '{}', 'utf8')
    await chmod(path, 0o444)

    await writeFileAtomic(path, '{"id":"x"}')

    expect(await readFile(path, 'utf8')).toBe('{"id":"x"}')
    expect(await readdir(folder)).toEqual(['profilo.json'])
  })
})
