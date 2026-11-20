import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parse } from 'yaml'
import type { EffortLevel } from './types'

/**
 * Optional per-role routing for `task` subagents.
 *
 * The file is opt-in and lives in the project (`.charliecode/routing.yaml`) or,
 * as a fallback, in `~/.charliecode/routing.yaml`. No model call, no guessing:
 * a role either has a valid route or it does not. Invalid entries are reported
 * and ignored; they never break a turn.
 */

export type SubagentRole = 'explorer' | 'reviewer' | 'implementer'

export const SUBAGENT_ROLES: SubagentRole[] = ['explorer', 'reviewer', 'implementer']

export const ROUTING_DIR = '.charliecode'
export const ROUTING_FILE = 'routing.yaml'

export interface RoleRoute {
  /** A native model key (`provider::model`) or a CLI key (`cli:<profile>`). */
  modelKey: string
  effort?: EffortLevel
}

export interface RoutingConfig {
  enabled: boolean
  roles: Partial<Record<SubagentRole, RoleRoute>>
  /** Absolute path of the file that was read. */
  source?: string
  /** Parse or validation problem, shown in the UI. Routing stays off. */
  error?: string
}

const EFFORTS: EffortLevel[] = ['none', 'low', 'high', 'max']

export const EMPTY_ROUTING: RoutingConfig = { enabled: false, roles: {} }

export const ROUTING_TEMPLATE = `# Routing opzionale dei subagenti di CharlieCode.
# Senza questo file, ogni subagente usa il modello principale (o la CLI worker).
# Il modello può essere un modello nativo ("provider::model") o una CLI
# ("cli:<profilo>" oppure "cli:<profilo>::<modello>").
enabled: false

roles:
  explorer:
    # Modello economico per cercare nel codice.
    # model: provider::model
    # effort: low
  reviewer:
    # model: provider::model
  implementer:
    # model: provider::model
    # effort: high
`

function routingPath(workspace: string | undefined, home: string): string {
  if (workspace) return join(workspace, ROUTING_DIR, ROUTING_FILE)
  return join(home, ROUTING_DIR, ROUTING_FILE)
}

/** Reads the first routing file that exists; a missing file is not an error. */
export async function readRouting(
  workspace: string | undefined,
  home: string
): Promise<RoutingConfig> {
  const candidates = [
    workspace ? join(workspace, ROUTING_DIR, ROUTING_FILE) : undefined,
    join(home, ROUTING_DIR, ROUTING_FILE)
  ].filter((entry): entry is string => Boolean(entry))

  for (const path of candidates) {
    if (!existsSync(path)) continue
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      return {
        enabled: false,
        roles: {},
        source: path,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    return parseRouting(source, path)
  }

  return { ...EMPTY_ROUTING }
}

/** Pure parser: exported so the rules are testable without touching disk. */
export function parseRouting(source: string, path = ROUTING_FILE): RoutingConfig {
  let data: unknown
  try {
    data = parse(source)
  } catch (error) {
    return {
      enabled: false,
      roles: {},
      source: path,
      error: `YAML non valido: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (!data || typeof data !== 'object') {
    return { enabled: false, roles: {}, source: path, error: 'Il file non contiene una mappa YAML.' }
  }

  const root = data as Record<string, unknown>
  const enabled = root.enabled === true
  const roles: Partial<Record<SubagentRole, RoleRoute>> = {}
  const problems: string[] = []
  const rawRoles = root.roles

  if (rawRoles !== undefined && (typeof rawRoles !== 'object' || rawRoles === null)) {
    problems.push('"roles" deve essere una mappa.')
  } else if (rawRoles) {
    for (const [name, value] of Object.entries(rawRoles as Record<string, unknown>)) {
      if (!SUBAGENT_ROLES.includes(name as SubagentRole)) {
        problems.push(`Ruolo sconosciuto: "${name}".`)
        continue
      }
      if (!value || typeof value !== 'object') {
        problems.push(`Il ruolo "${name}" deve essere una mappa.`)
        continue
      }

      const entry = value as Record<string, unknown>
      const modelKey = typeof entry.model === 'string' ? entry.model.trim() : ''
      if (!modelKey) {
        problems.push(`Il ruolo "${name}" non ha un campo "model".`)
        continue
      }

      let effort: EffortLevel | undefined
      if (entry.effort !== undefined) {
        if (typeof entry.effort === 'string' && EFFORTS.includes(entry.effort as EffortLevel)) {
          effort = entry.effort as EffortLevel
        } else {
          problems.push(
            `Il ruolo "${name}" ha effort "${String(entry.effort)}"; usa none, low, high o max.`
          )
          continue
        }
      }

      roles[name as SubagentRole] = { modelKey, ...(effort ? { effort } : {}) }
    }
  }

  return {
    enabled: enabled && Object.keys(roles).length > 0,
    roles,
    source: path,
    ...(problems.length > 0 ? { error: problems.join(' ') } : {})
  }
}

/**
 * Creates the template on first use. Returns the file path; never overwrites a
 * file the user already edited.
 */
export async function ensureRoutingFile(
  workspace: string | undefined,
  home: string
): Promise<string> {
  const path = routingPath(workspace, home)
  if (existsSync(path)) return path
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, ROUTING_TEMPLATE, 'utf8')
  return path
}
