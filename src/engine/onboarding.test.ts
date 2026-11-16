import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlatform } from './platform'
import {
  applyOnboarding,
  draftAgentsMd,
  inspectProject,
  isOnboarded,
  planOnboarding,
  skipOnboarding
} from './onboarding'
import { scanProject } from './project-scan'

/**
 * The wizard writes into a user's project, so the tests are mostly about what
 * it must *not* do: overwrite instructions that already exist, accept a path
 * from the renderer, or claim commands the project cannot run.
 */
describe('onboarding', () => {
  let workspace: string
  let platform: ReturnType<typeof createPlatform>

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'charliecode-onboarding-'))
    workspace = join(root, 'progetto')
    await mkdir(workspace, { recursive: true })
    platform = createPlatform({
      id: 'darwin',
      env: { HOME: root, CHARLIECODE_CONFIG_DIR: join(root, 'config') }
    })
  })

  afterEach(() => {
    // mkdtemp leaves the directory behind on purpose: it is in tmpdir().
  })

  async function writeJson(path: string, value: unknown): Promise<void> {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }

  it('drafts an AGENTS.md from detected facts only', async () => {
    await writeJson(join(workspace, 'package.json'), {
      name: 'progetto',
      scripts: { test: 'vitest run', build: 'tsc' },
      packageManager: 'pnpm@9.0.0'
    })
    await writeFile(join(workspace, 'src.ts'), 'export const a = 1\n', 'utf8')

    const scan = await scanProject(workspace)
    const draft = draftAgentsMd(scan, { summary: 'Un servizio di preventivi.', kinds: ['api'] })

    expect(draft).toContain('# progetto')
    expect(draft).toContain('Un servizio di preventivi.')
    expect(draft).toContain('Tipo: API / backend.')
    expect(draft).toContain('TypeScript')
    expect(draft).toContain('pnpm test')
    expect(draft).toContain('pnpm build')
    // Nothing invented: no command the project does not have.
    expect(draft).not.toContain('pnpm lint')
  })

  it('never invents a test command when the project has none', async () => {
    const scan = await scanProject(workspace)
    const draft = draftAgentsMd(scan, { summary: '', kinds: [] })

    expect(draft).toContain('nessun comando rilevato')
    expect(draft).not.toContain('npm test')
  })

  it('keeps existing instructions and appends only the new lines', async () => {
    await writeJson(join(workspace, 'package.json'), {
      name: 'progetto',
      scripts: { test: 'vitest run' }
    })
    await writeFile(join(workspace, 'AGENTS.md'), '# Regole di casa\n\n- Non toccare `vendor/`.\n', 'utf8')

    const plan = await planOnboarding(platform, workspace, { summary: 'Gestionale.', kinds: ['web'] })

    expect(plan.agentsMdExists).toBe(true)
    expect(plan.agentsMdPath).toBe(join(workspace, 'AGENTS.md'))
    expect(plan.agentsMd).toContain('Non toccare `vendor/`.')
    expect(plan.agentsMd).toContain('Gestionale.')
    expect(plan.agentsMd).toContain('<!-- aggiunto dal wizard di CharlieCode -->')
  })

  it('applies only the files it listed, and only after the user says yes', async () => {
    await writeJson(join(workspace, 'package.json'), {
      name: 'progetto',
      scripts: { test: 'vitest run' }
    })

    const answers = { summary: 'Un gestionale.', kinds: ['web'] }
    const plan = await planOnboarding(platform, workspace, answers)

    const result = await applyOnboarding(platform, workspace, {
      answers,
      writeAgentsMd: false,
      agentsMd: plan.agentsMd,
      skillIds: plan.skills.slice(0, 1).map((skill) => skill.id),
      autoApproveCommands: plan.autoApproveCommands
    })

    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false)
    expect(result.written).toHaveLength(1)
    const written = result.written[0]
    if (!written) throw new Error('doveva scrivere la skill scelta')
    expect(written).toContain(join('.charliecode', 'skills'))
    expect(existsSync(written)).toBe(true)
    expect(await isOnboarded(workspace)).toBe(true)
  })

  it('ignores skill ids the renderer made up', async () => {
    const answers = { summary: '', kinds: [] }
    const result = await applyOnboarding(platform, workspace, {
      answers,
      writeAgentsMd: false,
      agentsMd: '',
      skillIds: ['../../../etc/passwd', 'non-esiste'],
      autoApproveCommands: ['rm -rf']
    })

    expect(result.written).toHaveLength(0)
    expect(result.skipped).toEqual(['../../../etc/passwd', 'non-esiste'])
    // An auto-approve prefix that is not a real project command is dropped.
    expect(result.autoApprove).toEqual([])
    expect(existsSync(join(workspace, '..', '..', 'etc', 'passwd'))).toBe(false)
  })

  it('regenerates skill bodies engine-side, so edited text cannot leak in', async () => {
    await writeJson(join(workspace, 'package.json'), {
      name: 'progetto',
      scripts: { test: 'vitest run' }
    })
    const answers = { summary: '', kinds: ['web'] }
    const plan = await planOnboarding(platform, workspace, answers)
    const skill = plan.skills[0]
    if (!skill) throw new Error('il wizard doveva proporre almeno una skill')

    const result = await applyOnboarding(platform, workspace, {
      answers,
      writeAgentsMd: false,
      agentsMd: '',
      skillIds: [skill.id],
      autoApproveCommands: []
    })

    const path = result.written[0]
    if (!path) throw new Error('doveva scrivere la skill scelta')
    const content = await readFile(path, 'utf8')
    expect(content).toContain(`name: ${skill.name}`)
    expect(content).toContain(skill.body.split('\n')[0])
  })

  it('asks for onboarding once, then respects the skip marker', async () => {
    const first = await inspectProject(platform, workspace)
    expect(first.needsOnboarding).toBe(true)

    await skipOnboarding(workspace)
    const second = await inspectProject(platform, workspace)
    expect(second.needsOnboarding).toBe(false)
  })

  it('does not ask when the project already has instructions', async () => {
    await writeFile(join(workspace, 'CLAUDE.md'), '# Istruzioni\n', 'utf8')
    const facts = await inspectProject(platform, workspace)
    expect(facts.agentsFile).toBe('CLAUDE.md')
    expect(facts.needsOnboarding).toBe(false)
  })
})
