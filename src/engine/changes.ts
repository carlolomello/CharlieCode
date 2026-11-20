import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { createDiff } from './diff'
import { readPackageJson } from './project-scan'
import type { FileDiff } from './types'
import type { ChangeStatus, WorkspaceChange, WorkspaceChanges } from '../shared/ipc'

/**
 * "What changed in this project", as git sees it.
 *
 * The agent writes files all over the repository; without a place that lists
 * them, the only way to know what it did is to trust its own summary. This
 * module reads the working tree directly: no model, no memory, no guessing.
 *
 * Everything goes through `execFile` with an argument array — a path with a
 * space or a `;` is data, never shell syntax.
 */

const run = promisify(execFile)
const MAX_BUFFER = 8 * 1024 * 1024
const MAX_FILES = 300
const MAX_UNTRACKED_BYTES = 512 * 1024

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

async function git(workspace: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', ['-C', workspace, ...args], {
      maxBuffer: MAX_BUFFER,
      windowsHide: true
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    const caught = error as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: caught.stdout ?? '',
      stderr: (caught.stderr ?? caught.message ?? '').trim()
    }
  }
}

/**
 * Resolves a repository-relative path and refuses anything that escapes the
 * workspace. The renderer only sends paths it received from us, but this is the
 * boundary where a mistake becomes a deleted file.
 */
export function workspacePath(workspace: string, relative: string): string {
  const root = resolve(workspace)
  const target = resolve(root, relative)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Percorso fuori dal progetto: ${relative}`)
  }
  return target
}

/** `git status --porcelain` two-letter codes, mapped to something readable. */
function statusOf(x: string, y: string): ChangeStatus {
  if (x === '?' && y === '?') return 'untracked'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A') return 'added'
  return 'modified'
}

interface Numstat {
  added: number
  removed: number
  binary: boolean
}

/** `git diff --numstat`: "12\t3\tpath", or "-\t-\tpath" for binaries. */
function parseNumstat(text: string): Map<string, Numstat> {
  const map = new Map<string, Numstat>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const first = line.indexOf('\t')
    const second = line.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const addedRaw = line.slice(0, first)
    const removedRaw = line.slice(first + 1, second)
    const path = line.slice(second + 1)
    if (!path) continue
    const binary = addedRaw === '-' || removedRaw === '-'
    map.set(path, {
      added: binary ? 0 : Number(addedRaw) || 0,
      removed: binary ? 0 : Number(removedRaw) || 0,
      binary
    })
  }
  return map
}

async function untrackedStats(workspace: string, relative: string): Promise<Numstat> {
  try {
    const buffer = await readFile(join(workspace, relative))
    const head = buffer.subarray(0, Math.min(buffer.length, 8000))
    if (head.includes(0)) return { added: 0, removed: 0, binary: true }
    if (buffer.length > MAX_UNTRACKED_BYTES) {
      return { added: buffer.toString('utf8').split('\n').length, removed: 0, binary: false }
    }
    const text = buffer.toString('utf8')
    const lines = text.length === 0 ? 0 : text.replace(/\n$/, '').split('\n').length
    return { added: lines, removed: 0, binary: false }
  } catch {
    return { added: 0, removed: 0, binary: false }
  }
}

/**
 * Dev scripts and the URL they most likely serve. Heuristics only, and the UI
 * always lets the user type a different URL: a wrong guess must cost one edit,
 * not a broken preview.
 */
function previewHints(
  scripts: Record<string, string>,
  deps: Record<string, string>
): { previewScripts: string[]; previewUrl?: string } {
  const previewScripts = ['dev', 'start', 'preview', 'serve'].filter((name) => scripts[name])

  const fromScript = previewScripts
    .map((name) => /(?:--port[= ]|-p )(\d{2,5})/.exec(scripts[name] ?? '')?.[1])
    .find(Boolean)
  if (fromScript) return { previewScripts, previewUrl: `http://localhost:${fromScript}` }

  const known: [string, number][] = [
    ['next', 3000],
    ['nuxt', 3000],
    ['react-scripts', 3000],
    ['@remix-run/dev', 3000],
    ['vite', 5173],
    ['@sveltejs/kit', 5173],
    ['astro', 4321],
    ['parcel', 1234],
    ['@angular/cli', 4200],
    ['@vue/cli-service', 8080]
  ]
  for (const [dependency, port] of known) {
    if (deps[dependency]) return { previewScripts, previewUrl: `http://localhost:${port}` }
  }

  return { previewScripts }
}

/**
 * Creates a repository in an existing project folder. No commit, no config, no
 * files staged: `git init` only writes `.git`, and the user clicked the button.
 */
export async function initRepository(workspace: string): Promise<WorkspaceChanges> {
  if (!existsSync(workspace)) throw new Error(`La cartella non esiste: ${workspace}`)
  const result = await git(workspace, ['init'])
  if (!result.ok) throw new Error(result.stderr || 'git init non è riuscito')
  return listChanges(workspace)
}

export async function listChanges(workspace: string): Promise<WorkspaceChanges> {
  const inside = await git(workspace, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { workspace, git: false, changes: [], ...(await preview(workspace)) }
  }

  const branch = (await git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const status = await git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!status.ok) throw new Error(status.stderr || 'git status non è riuscito')

  // numstat against HEAD covers staged and unstaged changes at once. In a repo
  // with no commits yet HEAD does not exist, so fall back to index + worktree.
  let numstat = parseNumstat((await git(workspace, ['diff', '--numstat', 'HEAD'])).stdout)
  if (numstat.size === 0) {
    numstat = parseNumstat((await git(workspace, ['diff', '--numstat'])).stdout)
    for (const [path, stats] of parseNumstat(
      (await git(workspace, ['diff', '--numstat', '--cached'])).stdout
    )) {
      if (!numstat.has(path)) numstat.set(path, stats)
    }
  }

  const entries = status.stdout.split('\0')
  const changes: WorkspaceChange[] = []
  let truncated = false

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (!entry || entry.length < 4) continue

    const x = entry[0] ?? ' '
    const y = entry[1] ?? ' '
    const path = entry.slice(3)
    const status = statusOf(x, y)
    let from: string | undefined
    if (status === 'renamed') {
      // Porcelain -z puts the original path in the following NUL-separated field.
      from = entries[index + 1] || undefined
      index++
    }

    if (changes.length >= MAX_FILES) {
      truncated = true
      break
    }

    const stats =
      status === 'untracked'
        ? await untrackedStats(workspace, path)
        : (numstat.get(path) ?? { added: 0, removed: 0, binary: false })

    changes.push({
      path,
      displayPath: path,
      status,
      added: stats.added,
      removed: stats.removed,
      staged: x !== ' ' && x !== '?',
      ...(from ? { from } : {}),
      ...(stats.binary ? { binary: true } : {})
    })
  }

  changes.sort((a, b) => a.path.localeCompare(b.path))
  return {
    workspace,
    git: true,
    ...(branch && branch !== 'HEAD' ? { branch } : {}),
    changes,
    ...(truncated ? { truncated: true } : {}),
    ...(await preview(workspace))
  }
}

async function preview(
  workspace: string
): Promise<{ previewScripts: string[]; previewUrl?: string }> {
  const pkg = await readPackageJson(workspace)
  if (!pkg) return { previewScripts: [] }
  return previewHints(pkg.scripts ?? {}, { ...pkg.dependencies, ...pkg.devDependencies })
}

/** The full diff for one file, as the viewer expects it. */
export async function changeDiff(workspace: string, relative: string): Promise<FileDiff> {
  const absolute = workspacePath(workspace, relative)

  const tracked = (await git(workspace, ['ls-files', '--error-unmatch', '--', relative])).ok
  if (tracked) {
    const diff = await git(workspace, ['diff', 'HEAD', '--', relative])
    if (diff.ok && diff.stdout.trim()) return fromUnified(relative, diff.stdout)
    const cached = await git(workspace, ['diff', '--cached', '--', relative])
    if (cached.ok && cached.stdout.trim()) return fromUnified(relative, cached.stdout)
  }

  // Untracked (or a repo with no commits): show the whole file as added.
  if (!existsSync(absolute)) {
    return {
      path: relative,
      displayPath: relative,
      added: 0,
      removed: 0,
      deleted: true,
      unified: 'Il file non esiste più.'
    }
  }
  const content = await readFile(absolute, 'utf8').catch(() => '')
  return createDiff(absolute, '', content, relative)
}

/** `git diff` output is already unified; only the counts need computing. */
function fromUnified(relative: string, unified: string): FileDiff {
  let added = 0
  let removed = 0
  for (const line of unified.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  const created = /^---\s+\/dev\/null/m.test(unified)
  const deleted = /^\+\+\+\s+\/dev\/null/m.test(unified)
  return {
    path: relative,
    displayPath: relative,
    added,
    removed,
    ...(created ? { created: true } : {}),
    ...(deleted ? { deleted: true } : {}),
    unified
  }
}

/**
 * Discards the local changes to one file. New files are removed, tracked files
 * go back to HEAD. Nothing else in the working tree is touched.
 */
export async function revertChange(
  workspace: string,
  change: Pick<WorkspaceChange, 'path' | 'status' | 'from'>
): Promise<void> {
  const absolute = workspacePath(workspace, change.path)

  if (change.status === 'untracked') {
    await rm(absolute, { force: true })
    return
  }

  // A file that only exists in the index has nothing to restore from HEAD: the
  // old code removed it and then fell through to a failing `git restore`, so
  // the UI reported an error even though the file was already gone.
  if (change.status === 'added') {
    await git(workspace, ['restore', '--staged', '--', change.path])
    await rm(absolute, { force: true })
    return
  }

  if (change.status === 'renamed' && change.from) {
    await git(workspace, ['restore', '--staged', '--', change.path])
    const restored = await git(workspace, [
      'restore',
      '--source=HEAD',
      '--staged',
      '--worktree',
      '--',
      change.from
    ])
    if (!restored.ok) throw new Error(restored.stderr || `Non riesco a ripristinare ${change.from}`)
    await rm(absolute, { force: true })
    return
  }

  const result = await git(workspace, [
    'restore',
    '--source=HEAD',
    '--staged',
    '--worktree',
    '--',
    change.path
  ])
  if (!result.ok) throw new Error(result.stderr || `Non riesco a ripristinare ${change.path}`)
}
