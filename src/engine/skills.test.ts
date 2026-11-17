import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  globalSkillsDir,
  installSkillFromGit,
  listSkills,
  parseSkillFile,
  projectSkillsDir,
  readSkill,
  removeSkill,
  skillsSystemPrompt
} from './skills'
import type { Platform } from './platform'

let home: string
let workspace: string

/** `configDir` for our own skills, `homeDir` for the folders of other tools. */
const platform = (): Platform =>
  ({ configDir: join(home, '.charliecode'), homeDir: home }) as unknown as Platform

async function writeSkill(root: string, slug: string, name: string, body: string): Promise<string> {
  const dir = join(root, slug)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Descrizione di ${name}\n---\n\n${body}\n`,
    'utf8'
  )
  return dir
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'charliecode-skills-home-'))
  workspace = await mkdtemp(join(tmpdir(), 'charliecode-skills-proj-'))
})

describe('parseSkillFile', () => {
  it('legge nome e descrizione dal frontmatter', () => {
    const { meta, body } = parseSkillFile(
      '---\nname: typecheck\ndescription: Verifica i tipi\n---\n\nEsegui pnpm typecheck.\n'
    )
    expect(meta.name).toBe('typecheck')
    expect(meta.description).toBe('Verifica i tipi')
    expect(body).toBe('Esegui pnpm typecheck.')
  })

  it('senza frontmatter usa tutto il file come corpo', () => {
    const { meta, body } = parseSkillFile('# Titolo\n\nTesto.')
    expect(meta.name).toBeUndefined()
    expect(body).toBe('# Titolo\n\nTesto.')
  })
})

describe('listSkills', () => {
  it('trova le skill globali e quelle del progetto', async () => {
    await writeSkill(globalSkillsDir(platform()), 'typecheck', 'typecheck', 'globale')
    await writeSkill(projectSkillsDir(workspace), 'deploy', 'deploy', 'progetto')

    const skills = await listSkills(platform(), workspace)
    expect(skills.map((skill) => skill.id).sort()).toEqual(['deploy', 'typecheck'])
    expect(skills.find((skill) => skill.id === 'deploy')?.source).toBe('project')
  })

  it('la skill di progetto vince su quella globale con lo stesso id', async () => {
    await writeSkill(globalSkillsDir(platform()), 'typecheck', 'typecheck', 'globale')
    await writeSkill(projectSkillsDir(workspace), 'typecheck-proj', 'typecheck', 'progetto')

    const skills = await listSkills(platform(), workspace)
    expect(skills).toHaveLength(1)
    expect(skills[0]?.source).toBe('project')
  })

  it('ignora le cartelle senza SKILL.md', async () => {
    await mkdir(join(globalSkillsDir(platform()), 'vuota'), { recursive: true })
    expect(await listSkills(platform(), workspace)).toEqual([])
  })
})

describe('readSkill', () => {
  it('restituisce il corpo, non il frontmatter', async () => {
    await writeSkill(globalSkillsDir(platform()), 'deploy', 'deploy', 'Passi di deploy')
    const skill = await readSkill(platform(), workspace, 'deploy')
    expect(skill?.body).toBe('Passi di deploy')
    expect(skill?.name).toBe('deploy')
  })

  it('restituisce undefined se non esiste', async () => {
    expect(await readSkill(platform(), workspace, 'nope')).toBeUndefined()
  })
})

describe('skillsSystemPrompt', () => {
  it('elenca solo id e descrizione', async () => {
    await writeSkill(globalSkillsDir(platform()), 'deploy', 'deploy', 'CORPO SEGRETO')
    const prompt = await skillsSystemPrompt(platform(), workspace)
    expect(prompt).toContain('deploy: Descrizione di deploy')
    expect(prompt).not.toContain('CORPO SEGRETO')
  })

  it('è vuoto senza skill', async () => {
    expect(await skillsSystemPrompt(platform(), workspace)).toBe('')
  })
})

describe('removeSkill', () => {
  it('elimina la cartella della skill', async () => {
    const dir = await writeSkill(globalSkillsDir(platform()), 'deploy', 'deploy', 'x')
    await removeSkill(platform(), { dir, source: 'global' }, workspace)
    expect(await listSkills(platform(), workspace)).toEqual([])
  })

  it('rifiuta percorsi fuori dalle cartelle delle skill', async () => {
    await expect(
      removeSkill(platform(), { dir: join(home, 'altro'), source: 'global' }, workspace)
    ).rejects.toThrow()
  })

  it('rifiuta una cartella sorella che inizia con lo stesso prefisso', async () => {
    const sibling = `${globalSkillsDir(platform())}-evil`
    await expect(
      removeSkill(platform(), { dir: sibling, source: 'global' }, workspace)
    ).rejects.toThrow(/non valido/)
  })
})

describe('installSkillFromGit', () => {
  it('rifiuta un URL che non è git', async () => {
    await expect(
      installSkillFromGit(platform(), 'ftp://esempio', 'global', workspace)
    ).rejects.toThrow(/URL git/)
  })

  it('rifiuta di installare nel progetto senza progetto aperto', async () => {
    await expect(
      installSkillFromGit(platform(), 'https://github.com/a/b', 'project', undefined)
    ).rejects.toThrow(/progetto/)
  })
})

/**
 * A repository installed for another agent is already on disk in the same open
 * format. Copying it would fork it; reading it where it lives keeps one copy.
 */
describe('skill installate da altri strumenti', () => {
  it('legge .claude/skills e la marca come sola lettura', async () => {
    const dir = await writeSkill(
      join(workspace, '.claude', 'skills'),
      'sf-apex',
      'platform-apex-generate',
      'Istruzioni Apex'
    )

    const found = (await listSkills(platform(), workspace)).find(
      (skill) => skill.id === 'platform-apex-generate'
    )

    expect(found?.origin).toBe('Claude Code')
    expect(found?.readOnly).toBe(true)
    expect(found?.dir).toBe(dir)
  })

  it('legge una collezione annidata, come skills/<repo>/skills/<nome>', async () => {
    await writeSkill(
      join(workspace, 'skills', 'sf-skills', 'skills'),
      'platform-apex-generate',
      'platform-apex-generate',
      'corpo'
    )

    const found = (await listSkills(platform(), workspace)).find(
      (skill) => skill.id === 'platform-apex-generate'
    )
    expect(found?.description).toContain('platform-apex-generate')
  })

  it('la nostra copia vince su quella di un altro strumento', async () => {
    await writeSkill(join(workspace, '.claude', 'skills'), 'deploy', 'deploy', 'di Claude')
    await writeSkill(projectSkillsDir(workspace), 'deploy', 'deploy', 'nostra')

    const found = (await listSkills(platform(), workspace)).find((skill) => skill.id === 'deploy')
    expect(found?.origin).toBeUndefined()
    expect(found?.readOnly).toBeUndefined()
    expect(found?.dir).toBe(join(projectSkillsDir(workspace), 'deploy'))
  })

  it('non cancella una skill di un altro strumento', async () => {
    const dir = await writeSkill(join(workspace, '.claude', 'skills'), 'x', 'x', 'corpo')

    await expect(
      removeSkill(platform(), { dir, source: 'project', readOnly: true }, workspace)
    ).rejects.toThrow(/altro strumento/)
  })
})

describe('frontmatter con blocchi annidati', () => {
  it('un blocco metadata non sovrascrive name e description', () => {
    const { meta } = parseSkillFile(
      '---\nname: vero\ndescription: giusta\nmetadata:\n  version: "1.1"\n  name: falso\n  description: sbagliata\n---\n\ncorpo'
    )
    expect(meta.name).toBe('vero')
    expect(meta.description).toBe('giusta')
  })

  it('legge una descrizione a blocco ripiegato', () => {
    const { meta } = parseSkillFile(
      '---\nname: x\ndescription: >\n  prima riga\n  seconda riga\n---\n\ncorpo'
    )
    expect(meta.description).toBe('prima riga seconda riga')
  })
})
