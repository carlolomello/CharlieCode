import { BUILTIN_PLUGINS } from './plugins'
import type { AgentSettings, CharlieCodeConfig, EffortLevel, ModelOverride } from './types'

/**
 * The app's own configuration is part of the product surface: the agent may be
 * asked to "configure CharlieCode for this model" or "make subagents cheaper".
 *
 * This module is the only place that turns such a request into a config change.
 * It is pure and validated, so the tool can preview a diff, the permission gate
 * can show it, and main can persist exactly what the user approved.
 *
 * It never touches credentials: API keys are set by the user in the drawer and
 * stay out of the model's context.
 */

export const EFFORT_LEVELS: EffortLevel[] = ['none', 'low', 'high', 'max']

/**
 * Tools that always need an explicit confirmation. A model-writable setting
 * must never be able to turn off the gate on writes or commands: that is the
 * difference between "configure the app" and "give me a permanent backdoor".
 */
const ALWAYS_CONFIRM_TOOLS = new Set(['bash', 'write', 'edit', 'config', 'remember'])

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith('fe80') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  )
}

export interface AppConfigPatch {
  /** Native model key (`provider::model`); null clears the default. */
  defaultModel?: string | null
  effort?: EffortLevel
  fallbackModels?: string[]
  /** Only the effort-related fields; labels and capabilities stay as they are. */
  modelOverrides?: Record<string, { effort?: EffortLevel; efforts?: EffortLevel[] }>
  agents?: {
    maxSteps?: number
    subagentMaxSteps?: number
    /** Native model key; null clears it. */
    subagentModel?: string | null
    autoApprove?: string[]
    autoApproveCommands?: string[]
  }
  plugins?: Record<string, { enabled: boolean }>
  providers?: Array<{
    id: string
    enabled?: boolean
    baseUrl?: string
    showAllModels?: boolean
  }>
}

export interface AppConfigPatchResult {
  config: CharlieCodeConfig
  /** Human-readable changes, shown before the write and in the tool output. */
  changes: string[]
}

function isEffort(value: unknown): value is EffortLevel {
  return typeof value === 'string' && EFFORT_LEVELS.includes(value as EffortLevel)
}

function requireEffort(value: unknown, field: string): EffortLevel {
  if (!isEffort(value)) {
    throw new Error(`${field}: effort non valido "${String(value)}". Usa none, low, high o max.`)
  }
  return value
}

function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} deve essere un intero tra ${min} e ${max}.`)
  }
  return value
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} deve essere una lista di stringhe.`)
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error(`${field} deve essere una lista di stringhe.`)
    const trimmed = entry.trim()
    if (trimmed && !result.includes(trimmed)) result.push(trimmed)
  }
  return result
}

function showList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(nessuno)'
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

/**
 * Applies a validated patch. `validModelKeys` is the catalog the turn was built
 * with: when provided, an invented model key is rejected instead of silently
 * becoming a default that never resolves.
 */
export function applyConfigPatch(
  config: CharlieCodeConfig,
  patch: AppConfigPatch,
  validModelKeys?: string[]
): AppConfigPatchResult {
  const next = structuredClone(config)
  const changes: string[] = []
  const validKeys = validModelKeys ? new Set(validModelKeys) : undefined

  const modelKey = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${field}: serve una chiave modello.`)
    }
    const key = value.trim()
    if (validKeys && !validKeys.has(key)) {
      throw new Error(
        `${field}: modello sconosciuto "${key}". Usa una delle chiavi elencate da ` +
          '`charliecode_config` con action "read".'
      )
    }
    return key
  }

  if (patch.defaultModel !== undefined) {
    if (
      patch.defaultModel === null ||
      (typeof patch.defaultModel === 'string' && patch.defaultModel.trim() === '')
    ) {
      if (next.defaultModel !== undefined) {
        changes.push(`modello predefinito: ${next.defaultModel} → (nessuno)`)
        delete next.defaultModel
      }
    } else {
      const key = modelKey(patch.defaultModel, 'defaultModel')
      if (next.defaultModel !== key) {
        changes.push(`modello predefinito: ${next.defaultModel ?? '(nessuno)'} → ${key}`)
        next.defaultModel = key
      }
    }
  }

  if (patch.effort !== undefined) {
    const effort = requireEffort(patch.effort, 'effort')
    if (next.effort !== effort) {
      changes.push(`effort predefinito: ${next.effort} → ${effort}`)
      next.effort = effort
    }
  }

  if (patch.fallbackModels !== undefined) {
    const requested = uniqueStrings(patch.fallbackModels, 'fallbackModels').map((key) =>
      modelKey(key, 'fallbackModels')
    )
    const fallback = requested.filter((key) => key !== next.defaultModel)
    if (!sameList(fallback, next.fallbackModels)) {
      changes.push(`fallback: ${showList(next.fallbackModels)} → ${showList(fallback)}`)
      next.fallbackModels = fallback
    }
  }

  if (patch.modelOverrides !== undefined) {
    if (!patch.modelOverrides || typeof patch.modelOverrides !== 'object') {
      throw new Error('modelOverrides deve essere una mappa.')
    }
    for (const [rawKey, rawOverride] of Object.entries(patch.modelOverrides)) {
      const key = modelKey(rawKey, 'modelOverrides')
      if (!rawOverride || typeof rawOverride !== 'object') {
        throw new Error(`modelOverrides["${key}"] deve essere una mappa.`)
      }

      const override = rawOverride as { effort?: unknown; efforts?: unknown }
      const merged: ModelOverride = { ...(next.modelOverrides[key] ?? {}) }
      let touched = false

      if (override.effort !== undefined) {
        merged.effort = requireEffort(override.effort, `modelOverrides["${key}"].effort`)
        touched = true
      }
      if (override.efforts !== undefined) {
        if (!Array.isArray(override.efforts)) {
          throw new Error(`modelOverrides["${key}"].efforts deve essere una lista.`)
        }
        merged.efforts = [
          ...new Set(
            override.efforts.map((value, index) =>
              requireEffort(value, `modelOverrides["${key}"].efforts[${index}]`)
            )
          )
        ]
        touched = true
      }

      if (!touched) continue
      next.modelOverrides[key] = merged
      changes.push(
        `modello ${key}: effort ${merged.effort ?? '(default)'}` +
          (merged.efforts ? ` · livelli ${merged.efforts.join(', ')}` : '')
      )
    }
  }

  if (patch.agents !== undefined) {
    if (!patch.agents || typeof patch.agents !== 'object') {
      throw new Error('agents deve essere una mappa.')
    }
    const agents: AgentSettings = next.agents

    if (patch.agents.maxSteps !== undefined) {
      const value = requireInteger(patch.agents.maxSteps, 'agents.maxSteps', 1, 200)
      if (agents.maxSteps !== value) {
        changes.push(`agenti.maxSteps: ${agents.maxSteps} → ${value}`)
        agents.maxSteps = value
      }
    }

    if (patch.agents.subagentMaxSteps !== undefined) {
      const value = requireInteger(patch.agents.subagentMaxSteps, 'agents.subagentMaxSteps', 1, 200)
      if (agents.subagentMaxSteps !== value) {
        changes.push(`agenti.subagentMaxSteps: ${agents.subagentMaxSteps} → ${value}`)
        agents.subagentMaxSteps = value
      }
    }

    if (patch.agents.subagentModel !== undefined) {
      if (
        patch.agents.subagentModel === null ||
        (typeof patch.agents.subagentModel === 'string' && patch.agents.subagentModel.trim() === '')
      ) {
        if (agents.subagentModel !== undefined) {
          changes.push(`modello dei subagenti: ${agents.subagentModel} → (modello corrente)`)
          delete agents.subagentModel
        }
      } else {
        const key = modelKey(patch.agents.subagentModel, 'agents.subagentModel')
        if (agents.subagentModel !== key) {
          changes.push(`modello dei subagenti: ${agents.subagentModel ?? '(corrente)'} → ${key}`)
          agents.subagentModel = key
        }
      }
    }

    if (patch.agents.autoApprove !== undefined) {
      const requested = uniqueStrings(patch.agents.autoApprove, 'agents.autoApprove')
      const blocked = requested.filter((tool) => ALWAYS_CONFIRM_TOOLS.has(tool))
      const list = requested.filter((tool) => !ALWAYS_CONFIRM_TOOLS.has(tool))
      if (blocked.length > 0) {
        changes.push(
          `⚠ ${blocked.join(', ')} restano sempre confermati: non possono essere auto-approvati dalla configurazione.`
        )
      }
      if (!sameList(list, agents.autoApprove)) {
        changes.push(`tool auto-approvati: ${showList(agents.autoApprove)} → ${showList(list)}`)
        agents.autoApprove = list
      }
    }

    if (patch.agents.autoApproveCommands !== undefined) {
      const list = uniqueStrings(
        patch.agents.autoApproveCommands,
        'agents.autoApproveCommands'
      )
      if (!sameList(list, agents.autoApproveCommands)) {
        changes.push(
          `comandi auto-approvati: ${showList(agents.autoApproveCommands)} → ${showList(list)}`
        )
        agents.autoApproveCommands = list
      }
    }
  }

  if (patch.plugins !== undefined) {
    if (!patch.plugins || typeof patch.plugins !== 'object') {
      throw new Error('plugins deve essere una mappa.')
    }
    const known = new Set(BUILTIN_PLUGINS.map((plugin) => plugin.id))
    for (const [id, state] of Object.entries(patch.plugins)) {
      if (!known.has(id as (typeof BUILTIN_PLUGINS)[number]['id'])) {
        throw new Error(
          `Plugin sconosciuto: "${id}". Disponibili: ${[...known].join(', ')}.`
        )
      }
      if (!state || typeof state.enabled !== 'boolean') {
        throw new Error(`plugins["${id}"].enabled deve essere true o false.`)
      }
      const definition = BUILTIN_PLUGINS.find((plugin) => plugin.id === id)!
      const current = next.plugins?.[id]?.enabled ?? definition.defaultEnabled
      if (current !== state.enabled) {
        changes.push(`plugin ${id}: ${current ? 'on' : 'off'} → ${state.enabled ? 'on' : 'off'}`)
        next.plugins = { ...(next.plugins ?? {}), [id]: { enabled: state.enabled } }
      }
    }
  }

  if (patch.providers !== undefined) {
    if (!Array.isArray(patch.providers)) throw new Error('providers deve essere una lista.')
    for (const entry of patch.providers) {
      if (!entry || typeof entry.id !== 'string') {
        throw new Error('Ogni provider deve avere un id.')
      }
      const provider = next.providers.find((candidate) => candidate.id === entry.id)
      if (!provider) {
        throw new Error(
          `Provider sconosciuto: "${entry.id}". Aggiungilo prima dalle Impostazioni.`
        )
      }

      if (entry.enabled !== undefined) {
        if (typeof entry.enabled !== 'boolean') {
          throw new Error(`providers["${entry.id}"].enabled deve essere true o false.`)
        }
        if (provider.enabled !== entry.enabled) {
          changes.push(`provider ${entry.id}: ${provider.enabled ? 'attivo' : 'spento'} → ${entry.enabled ? 'attivo' : 'spento'}`)
          provider.enabled = entry.enabled
        }
      }

      if (entry.baseUrl !== undefined) {
        if (typeof entry.baseUrl !== 'string' || !/^https?:\/\//i.test(entry.baseUrl.trim())) {
          throw new Error(`providers["${entry.id}"].baseUrl deve iniziare con http:// o https://.`)
        }
        const baseUrl = entry.baseUrl.trim().replace(/\/+$/, '')
        let parsed: URL
        try {
          parsed = new URL(baseUrl)
        } catch {
          throw new Error(`providers["${entry.id}"].baseUrl non è un URL valido.`)
        }
        if (provider.baseUrl !== baseUrl) {
          changes.push(`provider ${entry.id}: base URL ${provider.baseUrl} → ${baseUrl}`)
          if (!isLocalHost(parsed.hostname)) {
            // The saved API key follows the base URL. Moving it to a remote
            // host is a decision the user must see before approving the diff.
            changes.push(
              `⚠ provider ${entry.id}: la nuova base URL è remota (${parsed.hostname}). La API key salvata verrà inviata a quell'host: conferma solo se è il tuo endpoint.`
            )
          }
          provider.baseUrl = baseUrl
        }
      }

      if (entry.showAllModels !== undefined) {
        if (typeof entry.showAllModels !== 'boolean') {
          throw new Error(`providers["${entry.id}"].showAllModels deve essere true o false.`)
        }
        if (Boolean(provider.showAllModels) !== entry.showAllModels) {
          changes.push(
            `provider ${entry.id}: mostra tutti i modelli ${entry.showAllModels ? 'on' : 'off'}`
          )
          provider.showAllModels = entry.showAllModels
        }
      }
    }
  }

  return { config: next, changes }
}
