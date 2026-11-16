import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
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
 * Only the name and description go in the system prompt. The body is read when
 * the model calls the `skill` tool, which is what keeps the context small.
 */

export interface SkillBody extends SkillInfo {
  body: string
}

const SKILL_FILE = 'SKILL.md'
const MAX_BODY_CHARS = 12_000

export function globalSkillsDir(platform: Platform): string {
  return join(platform.configDir, 'skills')
}

export function projectSkillsDir(workspace: string): string {
  return join(workspace, '.charliecode', 'skills')
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
  for (const line of head.split('\n')) {
    const match = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) continue
    const key = match[1]?.toLowerCase()
    const value = (match[2] ?? '').trim().replace(/^["']|["']$/g, '')
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

async function readSkillsIn(dir: string, source: SkillSource): Promise<SkillInfo[]> {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const skills: SkillInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name, SKILL_FILE)
    if (!existsSync(path)) continue
    const raw = await readFile(path, 'utf8').catch(() => '')
    if (!raw) continue
    const { meta, body } = parseSkillFile(raw)
    const id = slugFromDir(meta.name ?? entry.name)
    if (!id) continue
    skills.push({
      id,
      name: meta.name ?? entry.name,
      description: meta.description ?? firstLine(body) ?? 'Nessuna descrizione.',
      source,
      path,
      dir: join(dir, entry.name)
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

/** Project skills win over global ones with the same id. */
export async function listSkills(platform: Platform, workspace?: string): Promise<SkillInfo[]> {
  const global = await readSkillsIn(globalSkillsDir(platform), 'global')
  const project = workspace ? await readSkillsIn(projectSkillsDir(workspace), 'project') : []

  const merged = new Map<string, SkillInfo>()
  for (const skill of global) merged.set(skill.id, skill)
  for (const skill of project) merged.set(skill.id, skill)
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
  return { ...found, body: body.slice(0, MAX_BODY_CHARS) }
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

  const installed = await readSkillsIn(destination, target === 'project' ? 'project' : 'global')
  if (installed.length === 0) {
    await rm(destination, { recursive: true, force: true })
    throw new Error('Il repository non contiene nessun SKILL.md.')
  }

  return { installed, directory: destination }
}

export async function removeSkill(
  platform: Platform,
  skill: Pick<SkillInfo, 'dir' | 'source'>,
  workspace?: string
): Promise<void> {
  const root = skill.source === 'project' ? projectSkillsDir(workspace ?? '') : globalSkillsDir(platform)
  // Never delete outside the skills directories, whatever the renderer sends.
  // The separator matters: `<skills>-evil` starts with `<skills>` but is not inside it.
  const prefix = root.endsWith(sep) ? root : root + sep
  if (!skill.dir.startsWith(prefix)) throw new Error('Percorso skill non valido.')
  await rm(skill.dir, { recursive: true, force: true })
}
