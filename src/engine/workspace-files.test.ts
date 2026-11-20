import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_FILE_BYTES, listWorkspaceDir, readWorkspaceFile } from './workspace-files'

describe('workspace files', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'charliecode-files-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}\n', 'utf8')
    await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1\n', 'utf8')
    await writeFile(join(root, 'node_modules', 'x', 'index.js'), 'noise\n', 'utf8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('elenca cartelle e file, cartelle prima, senza rumore', async () => {
    const listing = await listWorkspaceDir(root)
    expect(listing.entries.map((entry) => entry.path)).toEqual(['src', 'package.json'])
    expect(listing.entries[0]?.dir).toBe(true)
  })

  it('scende in una sottocartella', async () => {
    const listing = await listWorkspaceDir(root, 'src')
    expect(listing.entries.map((entry) => entry.path)).toEqual(['src/index.ts'])
  })

  it('rifiuta un percorso che esce dal progetto', async () => {
    await expect(listWorkspaceDir(root, '..')).rejects.toThrow(/fuori dal progetto/)
    await expect(readWorkspaceFile(root, '../segreto.txt')).rejects.toThrow(/fuori dal progetto/)
    await expect(readWorkspaceFile(root, '/etc/passwd')).rejects.toThrow(/fuori dal progetto/)
  })

  it('legge un file di testo', async () => {
    const file = await readWorkspaceFile(root, 'src/index.ts')
    expect(file.text).toBe('export const x = 1\n')
    expect(file.binary).toBeUndefined()
    expect(file.truncated).toBeUndefined()
  })

  it('dice che un file è binario invece di stamparlo', async () => {
    await writeFile(join(root, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    const file = await readWorkspaceFile(root, 'logo.bin')
    expect(file.binary).toBe(true)
    expect(file.text).toBe('')
  })

  it('taglia un file enorme invece di caricarlo tutto', async () => {
    await writeFile(join(root, 'big.txt'), 'a'.repeat(MAX_FILE_BYTES + 1_024))
    const file = await readWorkspaceFile(root, 'big.txt')
    expect(file.truncated).toBe(true)
    expect(file.text.length).toBe(MAX_FILE_BYTES)
  })

  it('non elenca un file che non esiste', async () => {
    await expect(readWorkspaceFile(root, 'manca.txt')).rejects.toThrow(/non trovato/)
  })
})
