import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Platform } from './platform'
import type { SkillInfo, SkillSource } from '../shared/ipc'

/**
 * Skills: reusable procedures the agent loads only when it needs them.
 *
 * Same idea as Claude Code's `SKILL.md` packages. A skill is a directory with a
 * `SKILL.md` that starts with a small frontmatter block:
 *
 *   ---
 *   name: typecheck
 *   description: Come verificare i tipi prima di consegnare
 *   ---
 *
 *   (istruzioni vere e proprie)
 *
 * They live in two places, project first:
 *   - `<workspace>/.charliecode/skills/<slug>/SKILL.md` (committable, per project)
 *   - `~/.charliecode/skills/<slug>/SKILL.md`        (yours, every project)
 *
 * Skills that another agent already installed are read **where they are**, not
 * copied: `.claude/skills`, `.opencode/skills`, `.agents/skills`, `.cursor/skills`
 * in the project, and the matching folders under the home directory. The format
 * is the same open one (`agentskills.io`), so a repository installed with
 * `npx skills add …` works here without conversion.
 *
 * A skill folder can also carry `scripts/`, `references/` and `assets/`; the
 * `skill` tool returns the folder path so the model can read them.
 *
 * Only the name and description go in the system prompt. The body is read when
 * the model calls the `skill` tool, which is what keeps the context small.
 */

export interface SkillBody extends SkillInfo {
  body: string
}

const SKILL_FILE = 'SKILL.md'
/**
 * Real skills are long: Salesforce's own Apex skill is ~15k characters with
 * tables and templates. Truncating silently at 12k cut the rules in half, so the
 * limit is generous and the cut is always announced.
 */
const MAX_BODY_CHARS = 40_000

/** A directory that may contain skills, and who owns it. */
export interface SkillRoot {
  dir: string
  source: SkillSource
  /** Tool that owns the folder, for the UI. Ours is undefined. */
  origin?: string
  /** Skills found here belong to another tool: read them, never delete them. */
  readOnly?: boolean
}

/** Tools whose skill folders we read as-is, project and home. */
const FOREIGN_TOOLS: { folder: string; label: string }[] = [
  { folder: '.claude', label: 'Claude Code' },
  { folder: '.opencode', label: 'OpenCode' },
  { folder: '.agents', label: 'Agent Skills' },
  { folder: '.cursor', label: 'Cursor' }
]

export function globalSkillsDir(platform: Platform): string {
  return join(platform.configDir, 'skills')
}

export function projectSkillsDir(workspace: string): string {
  return join(workspace, '.charliecode', 'skills')
}

/**
 * Lowest priority first: `listSkills` overwrites by id, so the last root wins.
 * Our own project folder is last on purpose — if the same skill exists both
 * here and in `.claude/skills`, the copy you can edit in CharlieCode wins.
 */
export function projectSkillRoots(workspace: string): SkillRoot[] {
  return [
    ...FOREIGN_TOOLS.map((tool) => ({
      dir: join(workspace, tool.folder, 'skills'),
      source: 'project' as const,
      origin: tool.label,
      readOnly: true
    })),
    { dir: join(workspace, 'skills'), source: 'project' },
    { dir: projectSkillsDir(workspace), source: 'project' }
  ]
}

export function globalSkillRoots(platform: Platform): SkillRoot[] {
  const home = platform.homeDir
  return [
    ...(home
      ? FOREIGN_TOOLS.map((tool) => ({
          dir: join(home, tool.folder, 'skills'),
          source: 'global' as const,
          origin: tool.label,
          readOnly: true
        }))
      : []),
    { dir: globalSkillsDir(platform), source: 'global' }
  ]
}

interface Frontmatter {
  name?: string
  description?: string
}

/** Minimal `key: value` frontmatter parser: no YAML dependency, no surprises. */
export function parseSkillFile(raw: string): { meta: Frontmatter; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---')) return { meta: {}, body: normalized.trim() }

  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: normalized.trim() }

  const head = normalized.slice(3, end)
  const body = normalized.slice(end + 4).replace(/^\n+/, '')

  const meta: Frontmatter = {}
  const headLines = head.split('\n')
  for (let index = 0; index < headLines.length; index += 1) {
    const line = headLines[index] ?? ''
    // Indented lines belong to a nested block (`metadata:` with its own keys).
    // Reading them as top-level keys would let a `version:` shadow `name:`.
    if (/^\s/.test(line)) continue
    const match = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]?.toLowerCase()
    let value = (match[2] ?? '').trim()

    // YAML folded (`>`) and literal (`|`) blocks: the value is on the lines below.
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = []
      while (index + 1 < headLines.length) {
        const next = headLines[index + 1] ?? ''
        if (next.trim() === '' || /^\s/.test(next)) {
          index += 1
          block.push(next.trim())
          continue
        }
        break
      }
      value = block.join(' ').trim()
    }

    value = value.replace(/^["']|["']$/g, '').trim()
    if (!value) continue
    if (key === 'name') meta.name = value
    if (key === 'description') meta.description = value
  }
  return { meta, body: body.trim() }
}

function slugFromDir(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Folders inside a skill root that never contain other skills. */
const NESTED_IGNORED = new Set([
  'node_modules',
  'references',
  'assets',
  'scripts',
  'docs',
  'samples',
  'templates',
  'tests',
  'test'
])

/**
 * A repository can ship one skill at its root or many under `skills/`, which is
 * how `sf-skills` and most collections are laid out. Walking a couple of levels
 * is cheaper than asking the user to move folders around.
 */
async function findSkillFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 3 || !existsSync(dir)) return []
  const own = join(dir, SKILL_FILE)
  if (existsSync(own)) return [own]

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || NESTED_IGNORED.has(entry.name)) continue
    found.push(...(await findSkillFiles(join(dir, entry.name), depth + 1)))
  }
  return found
}

async function readSkillsIn(root: SkillRoot): Promise<SkillInfo[]> {
  const paths = await findSkillFiles(root.dir)
  const skills: SkillInfo[] = []

  for (const path of paths) {
    const raw = await readFile(path, 'utf8').catch(() => '')
    if (!raw) continue
    const { meta, body } = parseSkillFile(raw)
    const folder = path.slice(0, -SKILL_FILE.length - 1)
    const folderName = folder.split(sep).pop() ?? ''
    const id = slugFromDir(meta.name ?? folderName)
    if (!id) continue
    skills.push({
      id,
      name: meta.name ?? folderName,
      description: meta.description ?? firstLine(body) ?? 'Nessuna descrizione.',
      source: root.source,
      path,
      dir: folder,
      ...(root.origin ? { origin: root.origin } : {}),
      ...(root.readOnly ? { readOnly: true } : {})
    })
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

function firstLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((value) => value.replace(/^#+\s*/, '').trim())
    .find((value) => value.length > 0)
  return line ? line.slice(0, 160) : undefined
}

/**
 * Project skills win over global ones, and our own folders win over another
 * tool's copy with the same id: the one you can edit here is the one that runs.
 */
export async function listSkills(platform: Platform, workspace?: string): Promise<SkillInfo[]> {
  const roots = [
    ...globalSkillRoots(platform),
    ...(workspace ? projectSkillRoots(workspace) : [])
  ]

  const merged = new Map<string, SkillInfo>()
  for (const root of roots) {
    for (const skill of await readSkillsIn(root)) merged.set(skill.id, skill)
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function readSkill(
  platform: Platform,
  workspace: string | undefined,
  id: string
): Promise<SkillBody | undefined> {
  const skills = await listSkills(platform, workspace)
  const found =
    skills.find((skill) => skill.id === id) ??
    skills.find((skill) => skill.name.toLowerCase() === id.toLowerCase()) ??
    skills.find((skill) => skill.id.includes(id.toLowerCase()))
  if (!found) return undefined

  const raw = await readFile(found.path, 'utf8').catch(() => '')
  if (!raw) return undefined
  const { body } = parseSkillFile(raw)
  const truncated = body.length > MAX_BODY_CHARS
  return {
    ...found,
    body: truncated
      ? `${body.slice(0, MAX_BODY_CHARS)}\n\n[troncata a ${MAX_BODY_CHARS} caratteri. Il testo completo è in ${found.path}]`
      : body
  }
}

/**
 * The skill slice of the system prompt: names and descriptions only, so the
 * model knows what exists without paying for the full text.
 */
export async function skillsSystemPrompt(
  platform: Platform,
  workspace?: string
): Promise<string> {
  const skills = await listSkills(platform, workspace)
  if (skills.length === 0) return ''

  return [
    'Skill disponibili (procedure riutilizzabili). Quando una è pertinente alla richiesta,',
    'caricala con il tool `skill` prima di improvvisare: contiene i passi già verificati.',
    'Il tool restituisce anche la cartella della skill: se cita file in `assets/`,',
    '`references/` o `scripts/`, leggili con `read` invece di inventarli.',
    ...skills.map((skill) => `- ${skill.id}: ${skill.description}`)
  ].join('\n')
}
const execFileAsync = promisify(execFile)

export interface InstallSkillResult {
  installed: SkillInfo[]
  directory: string
}

/**
 * Installs skills from a git URL, Claude-Code style: clone into
 * `~/.charliecode/skills/<slug>` and keep it if a SKILL.md is found (at the root
 * or in a single top-level folder). A repo can therefore ship several skills.
 */
export async function installSkillFromGit(
  platform: Platform,
  url: string,
  target: 'global' | 'project',
  workspace?: string
): Promise<InstallSkillResult> {
  const trimmed = url.trim()
  if (!/^(https?:\/\/|git@)/.test(trimmed)) {
    throw new Error('Serve un URL git (https://… oppure git@…).')
  }
  if (target === 'project' && !workspace) throw new Error('Apri prima un progetto.')

  const dir = target === 'project' ? projectSkillsDir(workspace as string) : globalSkillsDir(platform)
  await mkdir(dir, { recursive: true })

  const base = slugFromDir(
    trimmed
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .filter(Boolean)
      .slice(-2)
      .join('-')
  )
  if (!base) throw new Error('Non riesco a ricavare un nome da questo URL.')

  const destination = join(dir, base)
  await rm(destination, { recursive: true, force: true })

  try {
    await execFileAsync('git', ['clone', '--depth', '1', trimmed, destination], {
      timeout: 120_000
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`git clone fallito: ${message.split('\n')[0]}`)
  }

  // One repository can ship one skill at its root or many under `skills/`, which
  // is the layout of every collection published with `npx skills add`.
  const installed = await readSkillsIn({
    dir: destination,
    source: target === 'project' ? 'project' : 'global'
  })
  if (installed.length === 0) {
    await rm(destination, { recursive: true, force: true })
    throw new Error('Il repository non contiene nessun SKILL.md.')
  }

  return { installed, directory: destination }
}

export interface LocalSkillDraft {
  id: string
  name: string
  description: string
  body: string
}

/**
 * Writes a skill that was generated locally (the onboarding wizard) instead of
 * cloned from a repository. Never overwrites: an existing folder means the user
 * already has it, possibly edited by hand.
 */
export async function writeLocalSkill(
  platform: Platform,
  workspace: string | undefined,
  draft: LocalSkillDraft,
  target: SkillSource
): Promise<{ skill: SkillInfo; created: boolean }> {
  if (target === 'project' && !workspace) throw new Error('Apri prima un progetto.')

  const root = target === 'project' ? projectSkillsDir(workspace as string) : globalSkillsDir(platform)
  const slug = slugFromDir(draft.id)
  if (!slug) throw new Error('Id skill non valido.')

  const dir = join(root, slug)
  const path = join(dir, SKILL_FILE)
  if (existsSync(path)) {
    const existing = (await readSkillsIn({ dir: root, source: target })).find(
      (skill) => skill.id === slug
    )
    if (existing) return { skill: existing, created: false }
  }

  await mkdir(dir, { recursive: true })
  const content = `---\nname: ${draft.name}\ndescription: ${draft.description}\n---\n\n${draft.body.trim()}\n`
  await writeFile(path, content, 'utf8')

  return {
    created: true,
    skill: {
      id: slug,
      name: draft.name,
      description: draft.description,
      source: target,
      path,
      dir
    }
  }
}

export async function removeSkill(
  platform: Platform,
  skill: Pick<SkillInfo, 'dir' | 'source' | 'readOnly'>,
  workspace?: string
): Promise<void> {
  if (skill.readOnly) {
    throw new Error(
      'Questa skill è installata da un altro strumento: rimuovila da lì, così resta coerente per entrambi.'
    )
  }
  const root = skill.source === 'project' ? projectSkillsDir(workspace ?? '') : globalSkillsDir(platform)
  // Never delete outside the skills directories, whatever the renderer sends.
  // The separator matters: `<skills>-evil` starts with `<skills>` but is not inside it.
  const prefix = root.endsWith(sep) ? root : root + sep
  if (!skill.dir.startsWith(prefix)) throw new Error('Percorso skill non valido.')
  await rm(skill.dir, { recursive: true, force: true })
}
