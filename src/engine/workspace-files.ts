import { open, readdir, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { WorkspaceDirListing, WorkspaceEntry, WorkspaceFile } from '../shared/ipc'

/**
 * Read-only browsing of the open project, for the Code tab.
 *
 * The app never writes through this module and never leaves the workspace: a
 * path that resolves outside the project is an error, not a page. Build output
 * and dependency folders are hidden because nobody scrolls through 40k files to
 * find a component.
 */

const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  'coverage',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
  '.idea',
  '.DS_Store'
])

const MAX_ENTRIES = 400
export const MAX_FILE_BYTES = 200 * 1024

function resolveInside(root: string, relativePath: string): string {
  const target = resolve(root, relativePath || '.')
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target) {
    throw new Error('Percorso fuori dal progetto.')
  }
  return target
}

/** One directory, directories first, without the noise. */
export async function listWorkspaceDir(
  root: string,
  relativePath = ''
): Promise<WorkspaceDirListing> {
  const dir = resolveInside(root, relativePath)
  const info = await stat(dir).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error('Cartella non trovata nel progetto.')

  const dirents = await readdir(dir, { withFileTypes: true })
  const entries: WorkspaceEntry[] = []

  for (const dirent of dirents) {
    if (IGNORED.has(dirent.name)) continue
    if (dirent.isSymbolicLink()) continue
    const child = relativePath ? `${relativePath}/${dirent.name}` : dirent.name
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: child, dir: true })
      continue
    }
    if (!dirent.isFile()) continue
    const details = await stat(resolveInside(root, child)).catch(() => undefined)
    entries.push({
      name: dirent.name,
      path: child,
      dir: false,
      ...(details ? { size: details.size } : {})
    })
  }

  entries.sort((a, b) =>
    a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1
  )

  const truncated = entries.length > MAX_ENTRIES
  return { entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, ...(truncated ? { truncated } : {}) }
}

/**
 * One file as text. Binaries are reported as such instead of printing mojibake,
 * and a huge file is cut instead of freezing the panel.
 */
export async function readWorkspaceFile(root: string, relativePath: string): Promise<WorkspaceFile> {
  const target = resolveInside(root, relativePath)
  const info = await stat(target).catch(() => undefined)
  if (!info?.isFile()) throw new Error('File non trovato nel progetto.')

  // Only the first bytes are read: a 1 GB log must not be loaded to show 200 kB.
  const length = Math.min(info.size, MAX_FILE_BYTES)
  const buffer = Buffer.alloc(length)
  const handle = await open(target, 'r')
  try {
    await handle.read(buffer, 0, length, 0)
  } finally {
    await handle.close()
  }

  const binary = buffer.subarray(0, Math.min(buffer.length, 8_000)).includes(0)
  if (binary) {
    return { path: relativePath, text: '', size: info.size, binary: true }
  }

  const truncated = info.size > MAX_FILE_BYTES
  const text = buffer.toString('utf8')
  return {
    path: relativePath,
    text,
    size: info.size,
    ...(truncated ? { truncated } : {})
  }
}
