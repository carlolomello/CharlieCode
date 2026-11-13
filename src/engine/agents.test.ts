import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTEXT_FILENAMES, globalAgentsPath, loadProjectContext } from './agents'
import { createPlatform, type Platform } from './platform'

let home: string
let project: string
let platform: Platform

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'charliecode-agents-'))
  project = join(home, 'progetto')
  await mkdir(project, { recursive: true })
  platform = createPlatform({ id: 'darwin', env: { HOME: home } })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('loadProjectContext', () => {
  it('senza file non produce nessun system prompt', async () => {
    const context = await loadProjectContext(platform, project)
    expect(context.system).toBe('')
    expect(context.sources).toEqual([])
  })

  it('mette le istruzioni globali prima di quelle del progetto', async () => {
    await mkdir(platform.configDir, { recursive: true })
    await writeFile(globalAgentsPath(platform), 'Rispondi in italiano.', 'utf8')
    await writeFile(join(project, 'AGENTS.md'), 'Usa TypeScript.', 'utf8')

    const context = await loadProjectContext(platform, project)
    const globalIndex = context.system.indexOf('Rispondi in italiano.')
    const projectIndex = context.system.indexOf('Usa TypeScript.')

    expect(globalIndex).toBeGreaterThan(-1)
    expect(projectIndex).toBeGreaterThan(globalIndex)
    expect(context.sources.map((source) => source.scope)).toEqual(['global', 'project'])
  })

  it('legge tutti i nomi supportati, in ordine', async () => {
    for (const name of CONTEXT_FILENAMES) {
      await writeFile(join(project, name), `regola da ${name}`, 'utf8')
    }

    const context = await loadProjectContext(platform, project)
    expect(context.sources).toHaveLength(CONTEXT_FILENAMES.length)

    let previous = -1
    for (const name of CONTEXT_FILENAMES) {
      const index = context.system.indexOf(`regola da ${name}`)
      expect(index).toBeGreaterThan(previous)
      previous = index
    }
  })

  it('ignora file vuoti e cartelle con lo stesso nome', async () => {
    await writeFile(join(project, 'AGENTS.md'), '   \n', 'utf8')
    await mkdir(join(project, 'CLAUDE.md'))

    const context = await loadProjectContext(platform, project)
    expect(context.system).toBe('')
  })

  it('funziona anche senza un progetto aperto', async () => {
    await mkdir(platform.configDir, { recursive: true })
    await writeFile(globalAgentsPath(platform), 'Solo globale.', 'utf8')

    const context = await loadProjectContext(platform)
    expect(context.system).toContain('Solo globale.')
    expect(context.sources).toHaveLength(1)
  })
})
