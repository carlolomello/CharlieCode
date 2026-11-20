import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * One read-only pass over a project, shared by the setup advisor and the
 * onboarding wizard. Pure heuristics on purpose: no model call, no network,
 * instant answer, and the same facts in both places.
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
const MAX_DEPTH = 6

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

export interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  packageManager?: string
}

export interface ProjectScan {
  root: string
  /** Paths relative to the root. */
  files: string[]
  truncated: boolean
  byExtension: Map<string, number>
  /** Most common languages first, at most three. */
  languages: string[]
  /** Verification commands that actually exist in this project. */
  commands: string[]
  packageManager?: string
  isGit: boolean
  /** First existing instructions file, if any. */
  agentsFile?: string
  hasMemory: boolean
  skillDirs: string[]
}

const CONTEXT_FILES = ['AGENTS.md', 'CHARLIECODE.md', 'CLAUDE.md']

async function walk(
  root: string,
  dir: string,
  depth: number,
  files: string[],
  byExtension: Map<string, number>
): Promise<boolean> {
  if (depth > MAX_DEPTH) return false
  let entries: Dirent[] = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }

  for (const entry of entries) {
    if (files.length >= MAX_SCAN_FILES) return true
    if (entry.name.startsWith('.') && entry.name !== '.charliecode') continue
    if (IGNORED.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (await walk(root, full, depth + 1, files, byExtension)) return true
      continue
    }
    files.push(full.slice(root.length + 1))
    const dot = entry.name.lastIndexOf('.')
    if (dot > 0) {
      const ext = entry.name.slice(dot + 1).toLowerCase()
      byExtension.set(ext, (byExtension.get(ext) ?? 0) + 1)
    }
  }
  return false
}

export function topLanguages(byExtension: Map<string, number>): string[] {
  const counts = new Map<string, number>()
  for (const [ext, count] of byExtension) {
    const language = LANGUAGE_BY_EXT[ext]
    if (!language) continue
    counts.set(language, (counts.get(language) ?? 0) + count)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([language]) => language)
}

export async function readPackageJson(root: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return undefined
  }
}

/** Package manager inferred from the lockfile, falling back to the manifest field. */
export function packageManagerFor(root: string, pkg: PackageJson | undefined): string | undefined {
  if (pkg?.packageManager?.startsWith('pnpm')) return 'pnpm'
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun'
  if (existsSync(join(root, 'package-lock.json')) || pkg) return 'npm'
  return undefined
}

/**
 * Only commands the project can actually run: a `pnpm typecheck` invented for a
 * repo without that script is worse than no suggestion at all.
 */
export function detectCommands(
  root: string,
  pkg: PackageJson | undefined,
  files: string[]
): string[] {
  const commands: string[] = []
  const scripts = pkg?.scripts ?? {}
  const manager = packageManagerFor(root, pkg) ?? 'npm'

  for (const name of ['typecheck', 'lint', 'test', 'build', 'format']) {
    if (scripts[name]) commands.push(`${manager} ${name}`)
  }
  // A package.json without a test script cannot run `npm test`: suggesting it
  // was worse than suggesting nothing at all.

  if (files.some((f) => f.endsWith('pyproject.toml') || f.endsWith('pytest.ini'))) {
    commands.push('pytest -q')
  }
  if (files.some((f) => f.endsWith('Cargo.toml'))) commands.push('cargo test')
  if (files.some((f) => f.endsWith('go.mod'))) commands.push('go test ./...')
  if (files.some((f) => f.endsWith('Makefile'))) commands.push('make')
  return commands
}

export async function scanProject(root: string): Promise<ProjectScan> {
  const files: string[] = []
  const byExtension = new Map<string, number>()
  const truncated = await walk(root, root, 0, files, byExtension)
  const pkg = await readPackageJson(root)

  return {
    root,
    files,
    truncated,
    byExtension,
    languages: topLanguages(byExtension),
    commands: detectCommands(root, pkg, files),
    packageManager: packageManagerFor(root, pkg),
    isGit: existsSync(join(root, '.git')),
    agentsFile: CONTEXT_FILES.find((name) => existsSync(join(root, name))),
    hasMemory: existsSync(join(root, '.charliecode', 'memory.md')),
    skillDirs: ['.charliecode/skills', 'skills'].filter((dir) => existsSync(join(root, dir)))
  }
}

/** Prefixes worth auto-approving: verification only, no writes. */
export function autoApprovePrefixes(commands: string[]): string[] {
  return commands
    .map((command) => command.split(' ').slice(0, 2).join(' '))
    .filter((prefix, index, all) => all.indexOf(prefix) === index)
}
