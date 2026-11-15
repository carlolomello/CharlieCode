import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * The "setup advisor" plugin: read the project, then suggest the boring things
 * that make an agent effective — the exact test command, an `AGENTS.md`, which
 * commands are safe to auto-approve, which skills are worth writing.
 *
 * Pure heuristics on purpose: no model call, no network, instant answer.
 */

const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'release',
  '.next',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.turbo'
])

const MAX_SCAN_FILES = 800

interface Scan {
  files: string[]
  truncated: boolean
  byExtension: Map<string, number>
}

async function scanFiles(root: string): Promise<Scan> {
  const files: string[] = []
  const byExtension = new Map<string, number>()
  let truncated = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > 6) return
    let entries: Dirent[] = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) {
        truncated = true
        return
      }
      if (entry.name.startsWith('.') && entry.name !== '.charliecode') continue
      if (IGNORED.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      files.push(full.slice(root.length + 1))
      const dot = entry.name.lastIndexOf('.')
      if (dot > 0) {
        const ext = entry.name.slice(dot + 1).toLowerCase()
        byExtension.set(ext, (byExtension.get(ext) ?? 0) + 1)
      }
    }
  }

  await walk(root, 0)
  return { files, truncated, byExtension }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  packageManager?: string
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript (React)',
  js: 'JavaScript',
  jsx: 'JavaScript (React)',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  kt: 'Kotlin',
  rb: 'Ruby',
  php: 'PHP',
  cs: 'C#',
  swift: 'Swift',
  c: 'C',
  cpp: 'C++',
  h: 'C/C++ header',
  vue: 'Vue',
  svelte: 'Svelte',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  sql: 'SQL',
  sh: 'Shell'
}

const SKILL_IDEAS: Record<string, { name: string; why: string }[]> = {
  'TypeScript': [
    { name: 'typecheck', why: '`tsc --noEmit` prima di ogni consegna: evita errori che i test non vedono' }
  ],
  'Python': [
    { name: 'venv-test', why: 'attivare il virtualenv giusto e lanciare pytest nello stesso modo ogni volta' }
  ],
  'Rust': [{ name: 'cargo-check', why: '`cargo check` + `clippy` come verifica standard' }],
  'Go': [{ name: 'go-test', why: '`go test ./...` con il timeout e i tag corretti' }]
}

function topLanguages(scan: Scan): string[] {
  const counts = new Map<string, number>()
  for (const [ext, count] of scan.byExtension) {
    const language = LANGUAGE_BY_EXT[ext]
    if (!language) continue
    counts.set(language, (counts.get(language) ?? 0) + count)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([language]) => language)
}

function detectCommands(
  root: string,
  pkg: PackageJson | undefined,
  files: string[]
): string[] {
  const commands: string[] = []
  const scripts = pkg?.scripts ?? {}
  const manager = pkg?.packageManager?.startsWith('pnpm')
    ? 'pnpm'
    : existsSync(join(root, 'yarn.lock'))
      ? 'yarn'
      : 'npm'

  for (const name of ['typecheck', 'lint', 'test', 'build', 'format']) {
    if (scripts[name]) commands.push(`${manager} ${name}`)
  }
  if (commands.length === 0 && pkg) commands.push(`${manager} test`)

  if (files.some((f) => f.endsWith('pyproject.toml') || f.endsWith('pytest.ini'))) {
    commands.push('pytest -q')
  }
  if (files.some((f) => f.endsWith('Cargo.toml'))) commands.push('cargo test')
  if (files.some((f) => f.endsWith('go.mod'))) commands.push('go test ./...')
  if (files.some((f) => f.endsWith('Makefile'))) commands.push('make')
  return commands
}

export interface AdvisorReport {
  markdown: string
  /** Commands worth auto-approving, already in the app's prefix format. */
  autoApproveCommands: string[]
}

export async function suggestSetup(workspace: string): Promise<AdvisorReport> {
  const root = workspace
  const scan = await scanFiles(root)
  const pkg = await readJson<PackageJson>(join(root, 'package.json'))
  const languages = topLanguages(scan)
  const commands = detectCommands(root, pkg, scan.files)

  const hasAgents = ['AGENTS.md', 'CHARLIECODE.md', 'CLAUDE.md'].filter((name) =>
    existsSync(join(root, name))
  )
  const hasMemory = existsSync(join(root, '.charliecode', 'memory.md'))
  const hasSkills = ['.charliecode/skills', 'skills'].filter((dir) => existsSync(join(root, dir)))
  const isGit = existsSync(join(root, '.git'))

  const sections: string[] = []
  sections.push(`## Il progetto in breve\n\n- Linguaggi: ${languages.join(', ') || 'non rilevati'}`)
  sections.push(`- File analizzati: ${scan.files.length}${scan.truncated ? ' (scansione troncata)' : ''}`)
  sections.push(`- Git: ${isGit ? 'sì' : 'no'}`)
  sections.push(`- Istruzioni esistenti: ${hasAgents.length > 0 ? hasAgents.join(', ') : 'nessuna'}`)
  sections.push(`- Memoria del progetto: ${hasMemory ? 'presente' : 'non ancora creata'}`)
  sections.push(`- Skill installate: ${hasSkills.length > 0 ? hasSkills.join(', ') : 'nessuna'}`)

  if (commands.length > 0) {
    sections.push(`\n## Comandi verificati\n\n${commands.map((c) => `- \`${c}\``).join('\n')}`)
  }

  const missing: string[] = []
  if (hasAgents.length === 0) missing.push('**AGENTS.md assente.** È il posto giusto per i comandi qui sopra e per le regole del progetto: l’agente lo legge a ogni sessione.')
  if (!hasMemory) missing.push('**Nessuna memoria di progetto.** Il plugin *Memoria del progetto* la crea al primo utilizzo: serve a non rispiegare tutto ogni volta.')
  if (hasSkills.length === 0) missing.push('**Nessuna skill.** Le skill sono procedure riutilizzabili (`SKILL.md`) che l’agente carica solo quando servono.')
  if (missing.length > 0) sections.push(`\n## Cosa manca\n\n${missing.map((m) => `- ${m}`).join('\n')}`)

  const skillIdeas = languages.flatMap((language) => SKILL_IDEAS[language] ?? []).slice(0, 4)
  if (skillIdeas.length > 0) {
    sections.push(
      `\n## Skill consigliate\n\n${skillIdeas.map((idea) => `- \`${idea.name}\` — ${idea.why}`).join('\n')}`
    )
  }

  const autoApprove = commands
    .map((command) => command.split(' ').slice(0, 2).join(' '))
    .filter((prefix, index, all) => all.indexOf(prefix) === index)
  if (autoApprove.length > 0) {
    sections.push(
      `\n## Automatismi consigliati\n\nPuoi auto-approvare (senza chiedere ogni volta):\n` +
        autoApprove.map((prefix) => `- \`${prefix}\` — sola verifica, nessuna scrittura`).join('\n')
    )
  }

  const agentLines = [
    '# AGENTS.md',
    '',
    '## Comandi',
    '',
    ...(commands.length > 0 ? commands.map((c) => `- \`${c}\``) : ['- (aggiungi qui i comandi del progetto)']),
    '',
    '## Regole',
    '',
    '- Prima di modificare un file, leggilo.',
    '- Dopo una modifica, verifica con il comando più stretto disponibile.'
  ]
  sections.push(`\n## AGENTS.md proposto\n\n\`\`\`markdown\n${agentLines.join('\n')}\n\`\`\``)

  return { markdown: sections.join('\n'), autoApproveCommands: autoApprove }
}
