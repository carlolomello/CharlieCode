import { readFileSync, statSync } from 'node:fs'
import { extname, win32 } from 'node:path'

/**
 * Windows command shims.
 *
 * A CLI installed by npm or pnpm on Windows is a `.cmd` (or `.bat`) shim that
 * hands its arguments to node. Node cannot spawn such a file without a shell,
 * and a shell would re-parse the prompt — `&`, `%VAR%` and quotes would become
 * command syntax. So the shim is read and the JavaScript entry it points at is
 * run directly: argv stays data, exactly like on macOS and Linux.
 */

const SHIM_EXTENSIONS = new Set(['.cmd', '.bat'])

export interface SpawnTarget {
  /** Executable to spawn. */
  file: string
  /** argv, already adjusted when the shim had to be bypassed. */
  args: string[]
  /** Extra environment for the child, when it needs any. */
  env?: Record<string, string>
}

export function isShimPath(path: string): boolean {
  return SHIM_EXTENSIONS.has(extname(path).toLowerCase())
}

/**
 * JavaScript entries a shim lists, in the order it lists them.
 *
 * npm writes `"%dp0%\node_modules\tool\bin\tool"`, pnpm writes
 * `"%~dp0\..\..\node_modules\.bin\tool"`; both are relative to the shim. The
 * `node.exe` the shim may prefer is skipped: it is an interpreter, not the
 * program.
 */
export function shimScriptCandidates(content: string, directory: string): string[] {
  const found: string[] = []
  for (const match of content.matchAll(/"(?:%~dp0|%dp0%)\\([^"]+)"/gi)) {
    const relative = match[1]?.trim()
    if (!relative) continue
    if (/\.(exe|dll|com)$/i.test(relative)) continue
    const path = win32.normalize(win32.join(directory, relative))
    if (!found.includes(path)) found.push(path)
  }
  return found
}

/** The first entry of the shim that exists on disk. */
export function readShimScript(shimPath: string): string | undefined {
  try {
    const content = readFileSync(shimPath, 'utf8').slice(0, 64 * 1024)
    return shimScriptCandidates(content, win32.dirname(shimPath)).find((candidate) => {
      try {
        return statSync(candidate).isFile()
      } catch {
        return false
      }
    })
  } catch {
    return undefined
  }
}

/**
 * What to spawn for a resolved binary.
 *
 * Returns `undefined` when a shim has no JavaScript entry and a shell would be
 * required: probes may fall back to `cmd.exe` (`allowShell`), a real turn never
 * does, because the prompt would be parsed as shell syntax.
 */
export function spawnTarget(
  binary: string,
  args: string[],
  options: { node?: string; allowShell?: boolean } = {}
): SpawnTarget | undefined {
  if (process.platform !== 'win32' || !isShimPath(binary)) return { file: binary, args }

  const script = readShimScript(binary)
  if (script) {
    if (options.node) return { file: options.node, args: [script, ...args] }
    // No node on PATH: Electron's own binary runs as node with this flag.
    return { file: process.execPath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }

  if (!options.allowShell) return undefined
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  return { file: comspec, args: ['/d', '/s', '/c', binary, ...args] }
}
