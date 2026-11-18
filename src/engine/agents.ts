import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { Platform } from './platform'

/**
 * Project instructions: plain markdown the user drops in a repo to steer the
 * agent, plus the `AGENTS.md` convention already used by other coding tools.
 *
 * Layering, highest priority last (so later text can override earlier rules):
 *   1. global  ~/.charliecode/AGENTS.md
 *   2. project <workspace>/AGENTS.md, CHARLIECODE.md, CLAUDE.md
 */

export const CONTEXT_FILENAMES = ['AGENTS.md', 'CHARLIECODE.md', 'CLAUDE.md'] as const

export interface ContextSource {
  path: string
  scope: 'global' | 'project'
  bytes: number
}

export interface ProjectContext {
  /** Ready to be used as the system prompt suffix; empty when nothing was found. */
  system: string
  sources: ContextSource[]
}

const MAX_PER_FILE = 24_000
const MAX_TOTAL = 48_000

async function readCapped(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return undefined
    const raw = await readFile(path, 'utf8')
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    return trimmed.length > MAX_PER_FILE
      ? `${trimmed.slice(0, MAX_PER_FILE)}\n\n[…troncato: ${path}]`
      : trimmed
  } catch {
    return undefined
  }
}

async function firstExisting(
  dir: string,
  sep: string,
  name: string
): Promise<string | undefined> {
  const path = `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
  return existsSync(path) ? path : undefined
}

async function firstContextFile(
  dir: string,
  sep: string
): Promise<string | undefined> {
  for (const name of CONTEXT_FILENAMES) {
    const path = await firstExisting(dir, sep, name)
    if (path) return path
  }
  return undefined
}

export async function loadProjectContext(
  platform: Platform,
  workspacePath?: string
): Promise<ProjectContext> {
  const sections: { source: ContextSource; text: string }[] = []

  const globalPath = await firstContextFile(platform.configDir, platform.pathSep)
  if (globalPath) {
    const text = await readCapped(globalPath)
    if (text) {
      sections.push({
        source: { path: globalPath, scope: 'global', bytes: text.length },
        text
      })
    }
  }

  if (workspacePath) {
    for (const name of CONTEXT_FILENAMES) {
      const path = `${workspacePath.replace(/[\\/]+$/, '')}${platform.pathSep}${name}`
      if (!existsSync(path)) continue
      const text = await readCapped(path)
      if (!text) continue
      sections.push({
        source: { path, scope: 'project', bytes: text.length },
        text
      })
    }
  }

  let total = 0
  const blocks: string[] = []
  for (const section of sections) {
    if (total >= MAX_TOTAL) break
    const remaining = MAX_TOTAL - total
    const body = section.text.length > remaining ? section.text.slice(0, remaining) : section.text
    total += body.length
    const label = section.source.scope === 'global' ? 'istruzioni globali' : 'istruzioni del progetto'
    blocks.push(`## ${label} — ${section.source.path}\n\n${body}`)
  }

  return {
    system:
      blocks.length > 0
        ? `# Istruzioni dell'utente\n\n${blocks.join('\n\n---\n\n')}`
        : '',
    sources: sections.map((section) => section.source)
  }
}

/** Creates the global AGENTS.md the first time the app runs, so it is editable. */
export function globalAgentsPath(platform: Platform): string {
  return platform.configPath('AGENTS.md')
}
