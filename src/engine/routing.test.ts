import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureRoutingFile,
  parseRouting,
  readRouting,
  ROUTING_FILE,
  ROUTING_TEMPLATE
} from './routing'

describe('routing', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('legge ruoli, modelli e effort', () => {
    const config = parseRouting(
      `enabled: true
roles:
  explorer:
    model: cheap::small
    effort: low
  implementer:
    model: cli:agent-one::fast
    effort: high
`
    )

    expect(config.enabled).toBe(true)
    expect(config.error).toBeUndefined()
    expect(config.roles.explorer).toEqual({ modelKey: 'cheap::small', effort: 'low' })
    expect(config.roles.implementer).toEqual({
      modelKey: 'cli:agent-one::fast',
      effort: 'high'
    })
  })

  it('resta spento se enabled non è true', () => {
    const config = parseRouting('enabled: false\nroles:\n  explorer:\n    model: a::b\n')
    expect(config.enabled).toBe(false)
    expect(config.roles.explorer?.modelKey).toBe('a::b')
  })

  it('segnala YAML non valido senza lanciare', () => {
    const config = parseRouting('roles: [\n  non chiuso')
    expect(config.enabled).toBe(false)
    expect(config.error).toMatch(/YAML non valido/)
  })

  it('scarta i ruoli sconosciuti e gli effort non validi, tenendo i buoni', () => {
    const config = parseRouting(
      `enabled: true
roles:
  architect:
    model: a::b
  explorer:
    model: a::b
    effort: turbo
  reviewer:
    model: a::b
`
    )

    expect(config.enabled).toBe(true)
    expect(Object.keys(config.roles)).toEqual(['reviewer'])
    expect(config.roles.explorer).toBeUndefined()
    expect(config.roles.reviewer?.modelKey).toBe('a::b')
    expect(config.error).toMatch(/Ruolo sconosciuto/)
    expect(config.error).toMatch(/effort "turbo"/)
  })

  it('preferisce il file del progetto e usa quello globale come riserva', async () => {
    root = await mkdtemp(join(tmpdir(), 'charliecode-routing-'))
    const project = join(root, 'project')
    const home = join(root, 'home')
    await mkdir(join(project, '.charliecode'), { recursive: true })
    await mkdir(join(home, '.charliecode'), { recursive: true })

    await writeFile(
      join(home, '.charliecode', ROUTING_FILE),
      'enabled: true\nroles:\n  explorer:\n    model: home::model\n'
    )
    expect((await readRouting(project, home)).roles.explorer?.modelKey).toBe('home::model')

    await writeFile(
      join(project, '.charliecode', ROUTING_FILE),
      'enabled: true\nroles:\n  explorer:\n    model: project::model\n'
    )
    expect((await readRouting(project, home)).roles.explorer?.modelKey).toBe('project::model')
  })

  it('crea il template una volta sola e non sovrascrive le modifiche', async () => {
    root = await mkdtemp(join(tmpdir(), 'charliecode-routing-'))
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })

    const path = await ensureRoutingFile(project, root)
    expect(existsSync(path)).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(ROUTING_TEMPLATE)

    await writeFile(path, 'enabled: true\nroles:\n  reviewer:\n    model: a::b\n')
    await ensureRoutingFile(project, root)
    expect(await readFile(path, 'utf8')).toContain('reviewer')
  })
})
