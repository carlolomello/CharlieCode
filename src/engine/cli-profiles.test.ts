import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cliProfilePath,
  deleteCliProfile,
  listCliProfiles,
  readCliProfile,
  saveCliProfile,
  slugifyProfileId,
  validateCliProfile
} from './cli-profiles'
import { createPlatform, type Platform } from './platform'

let home: string
let platform: Platform

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'charliecode-clis-'))
  platform = createPlatform({ id: 'darwin', env: { HOME: home } })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('validateCliProfile', () => {
  it('normalizza un profilo minimo', () => {
    const profile = validateCliProfile({ label: 'La mia CLI', command: 'agent' })
    expect(profile.id).toBe('la-mia-cli')
    expect(profile.args).toEqual([])
    expect(profile.promptMode).toBeUndefined()
    expect(profile.output).toBeUndefined()
  })

  it('rifiuta nome e comando mancanti', () => {
    expect(() => validateCliProfile({ command: 'agent' })).toThrow(/nome/i)
    expect(() => validateCliProfile({ label: 'x' })).toThrow(/comando/i)
    expect(() => validateCliProfile(null)).toThrow(/oggetto JSON/i)
  })

  it('rifiuta formati sconosciuti', () => {
    expect(() =>
      validateCliProfile({ label: 'x', command: 'y', output: 'xml' })
    ).toThrow(/output/)
    expect(() =>
      validateCliProfile({ label: 'x', command: 'y', promptMode: 'file' })
    ).toThrow(/promptMode/)
    expect(() =>
      validateCliProfile({ label: 'x', command: 'y', modelsFormat: 'yaml' })
    ).toThrow(/modelsFormat/)
  })

  it('tiene gli argomenti come lista e rifiuta le stringhe', () => {
    const profile = validateCliProfile({
      label: 'x',
      command: 'y',
      args: ['run', '--format', 'json']
    })
    expect(profile.args).toEqual(['run', '--format', 'json'])

    expect(() =>
      validateCliProfile({ label: 'x', command: 'y', args: ['run', 3] })
    ).toThrow(/non è testo/)
    expect(() =>
      validateCliProfile({ label: 'x', command: 'y', args: 'run --format json' })
    ).toThrow(/lista di stringhe/)
  })

  it('limita il timeout a un intervallo sensato', () => {
    expect(validateCliProfile({ label: 'x', command: 'y', timeoutSeconds: 1 }).timeoutSeconds).toBe(5)
    expect(
      validateCliProfile({ label: 'x', command: 'y', timeoutSeconds: 99_999 }).timeoutSeconds
    ).toBe(3_600)
  })

  it('conserva un id esistente, normalizzato', () => {
    const profile = validateCliProfile({ id: 'Mio Profilo!', label: 'x', command: 'y' })
    expect(profile.id).toBe('mio-profilo')
  })
})

describe('slugifyProfileId', () => {
  it('produce un nome di file sicuro', () => {
    expect(slugifyProfileId('  CLI Aziendale / v2  ')).toBe('cli-aziendale-v2')
    expect(slugifyProfileId('Caffè')).toBe('caffe')
    expect(slugifyProfileId('***')).toBe('')
  })
})

describe('archivio dei profili', () => {
  const profile = {
    label: 'CLI di prova',
    command: 'agent',
    args: ['run', '{prompt}'],
    output: 'json-lines' as const
  }

  it('salva, rilegge, elenca ed elimina', async () => {
    const saved = await saveCliProfile(platform, profile)
    expect(saved.id).toBe('cli-di-prova')
    expect(await readCliProfile(platform, saved.id)).toEqual(saved)

    const listed = await listCliProfiles(platform)
    expect(listed.errors).toEqual([])
    expect(listed.profiles).toHaveLength(1)

    expect(await deleteCliProfile(platform, saved.id)).toBe(true)
    expect(await readCliProfile(platform, saved.id)).toBeUndefined()
    expect(await deleteCliProfile(platform, saved.id)).toBe(false)
  })

  it('un file rotto viene segnalato, non cancellato', async () => {
    await mkdir(platform.configPath('clis'), { recursive: true })
    await writeFile(platform.configPath('clis', 'rotto.json'), '{ non json')
    await writeFile(
      platform.configPath('clis', 'invalido.json'),
      JSON.stringify({ label: '', command: '' })
    )
    await saveCliProfile(platform, profile)

    const listed = await listCliProfiles(platform)
    expect(listed.profiles).toHaveLength(1)
    expect(listed.errors.map((entry) => entry.file).sort()).toEqual([
      'invalido.json',
      'rotto.json'
    ])
  })

  it('scrive un file per profilo, con nome derivato dall’id', async () => {
    const saved = await saveCliProfile(platform, profile)
    expect(cliProfilePath(platform, saved.id).endsWith('cli-di-prova.json')).toBe(true)
  })
})
