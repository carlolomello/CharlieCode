import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import type { Platform } from './platform'
import type { CliOutputFormat, CliProfile } from './types'

/**
 * User-defined CLI profiles.
 *
 * One JSON file per CLI in `<config>/clis/<id>.json`. The app ships no
 * product presets: a corporate CLI is a command with arguments, and a profile
 * is the smallest thing that describes it without teaching CharlieCode the
 * name of anybody's vendor.
 */

export const CLI_PROFILES_DIR = 'clis'

export function cliProfilesDir(platform: Platform): string {
  return platform.configPath(CLI_PROFILES_DIR)
}

export function cliProfilePath(platform: Platform, id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '')
  return platform.configPath(CLI_PROFILES_DIR, `${safe}.json`)
}

export function slugifyProfileId(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64)
}

const OUTPUT_FORMATS: CliOutputFormat[] = [
  'auto',
  'text',
  'json-lines',
  'run-result',
  'stream-json'
]

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  label: string
): string[] {
  const value = record[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} deve essere una lista di stringhe.`)
  if (value.length > 64) throw new Error(`${label}: massimo 64 voci.`)

  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new Error(`${label}: la voce ${index + 1} non è testo.`)
    }
    if (entry.length > 4_000) {
      throw new Error(`${label}: la voce ${index + 1} è troppo lunga.`)
    }
    return entry
  })
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  max: number
): string | undefined {
  const value = record[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${key} deve essere testo.`)
  if (value.length > max) throw new Error(`${key} è troppo lungo (max ${max}).`)
  return value
}

/**
 * Validates and normalizes a profile. Throws a message meant for the user:
 * this is the only gate between a hand-edited JSON file and `spawn`.
 */
export function validateCliProfile(value: unknown, fallbackId?: string): CliProfile {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Profilo non valido: atteso un oggetto JSON.')
  }
  const record = value as Record<string, unknown>

  const label = typeof record.label === 'string' ? record.label.trim() : ''
  if (!label) throw new Error('Il nome del profilo è obbligatorio.')
  if (label.length > 80) throw new Error('Il nome del profilo è troppo lungo (max 80).')

  const command = typeof record.command === 'string' ? record.command.trim() : ''
  if (!command) throw new Error('Il comando è obbligatorio.')
  if (command.length > 500) throw new Error('Il comando è troppo lungo (max 500).')

  const rawId = typeof record.id === 'string' && record.id.trim() ? record.id : fallbackId
  const id = slugifyProfileId(rawId ?? label)
  if (!id) throw new Error('Id del profilo non valido.')

  const args = readStringArray(record, 'args', 'Gli argomenti')
  const promptMode =
    record.promptMode === undefined
      ? undefined
      : record.promptMode === 'arg' || record.promptMode === 'stdin'
        ? record.promptMode
        : (() => {
            throw new Error('promptMode deve essere "arg" o "stdin".')
          })()

  const output =
    record.output === undefined
      ? undefined
      : OUTPUT_FORMATS.includes(record.output as CliOutputFormat)
        ? (record.output as CliOutputFormat)
        : (() => {
            throw new Error(`output deve essere uno di: ${OUTPUT_FORMATS.join(', ')}.`)
          })()

  const modelsFormat =
    record.modelsFormat === undefined
      ? undefined
      : record.modelsFormat === 'lines' || record.modelsFormat === 'json'
        ? record.modelsFormat
        : (() => {
            throw new Error('modelsFormat deve essere "lines" o "json".')
          })()

  const timeoutRaw = record.timeoutSeconds
  let timeoutSeconds: number | undefined
  if (timeoutRaw !== undefined && timeoutRaw !== null) {
    if (typeof timeoutRaw !== 'number' || !Number.isFinite(timeoutRaw)) {
      throw new Error('timeoutSeconds deve essere un numero.')
    }
    timeoutSeconds = Math.min(3_600, Math.max(5, Math.round(timeoutRaw)))
  }

  return {
    id,
    label,
    command,
    args,
    ...(promptMode ? { promptMode } : {}),
    ...(output ? { output } : {}),
    ...(readStringArray(record, 'modelArgs', 'Gli argomenti del modello').length
      ? { modelArgs: readStringArray(record, 'modelArgs', 'Gli argomenti del modello') }
      : {}),
    ...(readStringArray(record, 'planArgs', 'Gli argomenti di sola lettura').length
      ? { planArgs: readStringArray(record, 'planArgs', 'Gli argomenti di sola lettura') }
      : {}),
    ...(readStringArray(record, 'autoArgs', 'Gli argomenti di scrittura automatica').length
      ? { autoArgs: readStringArray(record, 'autoArgs', 'Gli argomenti di scrittura automatica') }
      : {}),
    ...(readStringArray(record, 'modelsArgs', 'Il comando modelli').length
      ? { modelsArgs: readStringArray(record, 'modelsArgs', 'Il comando modelli') }
      : {}),
    ...(modelsFormat ? { modelsFormat } : {}),
    ...(() => {
      const textPath = readOptionalString(record, 'textPath', 200)
      return textPath ? { textPath } : {}
    })(),
    ...(() => {
      const activityPath = readOptionalString(record, 'activityPath', 200)
      return activityPath ? { activityPath } : {}
    })(),
    ...(() => {
      const modelsPath = readOptionalString(record, 'modelsPath', 200)
      return modelsPath ? { modelsPath } : {}
    })(),
    ...(() => {
      const notes = readOptionalString(record, 'notes', 500)
      return notes ? { notes } : {}
    })(),
    ...(timeoutSeconds ? { timeoutSeconds } : {})
  }
}

export interface CliProfilesLoadResult {
  profiles: CliProfile[]
  errors: { file: string; message: string }[]
}

/** Reads every profile. A broken file is reported, never silently deleted. */
export async function listCliProfiles(platform: Platform): Promise<CliProfilesLoadResult> {
  const dir = cliProfilesDir(platform)
  if (!existsSync(dir)) return { profiles: [], errors: [] }

  const entries = await readdir(dir)
  const profiles: CliProfile[] = []
  const errors: { file: string; message: string }[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const id = entry.slice(0, -'.json'.length)
    try {
      const parsed: unknown = JSON.parse(await readFile(platform.configPath(CLI_PROFILES_DIR, entry), 'utf8'))
      profiles.push(validateCliProfile(parsed, id))
    } catch (cause) {
      errors.push({
        file: entry,
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }
  }

  profiles.sort((a, b) => a.label.localeCompare(b.label))
  return { profiles, errors }
}

export async function readCliProfile(
  platform: Platform,
  id: string
): Promise<CliProfile | undefined> {
  const path = cliProfilePath(platform, id)
  if (!existsSync(path)) return undefined
  try {
    return validateCliProfile(JSON.parse(await readFile(path, 'utf8')), id)
  } catch {
    return undefined
  }
}

export async function saveCliProfile(platform: Platform, input: unknown): Promise<CliProfile> {
  const profile = validateCliProfile(input)
  await mkdir(cliProfilesDir(platform), { recursive: true })
  const path = cliProfilePath(platform, profile.id)
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
  return profile
}

export async function deleteCliProfile(platform: Platform, id: string): Promise<boolean> {
  const path = cliProfilePath(platform, id)
  if (!existsSync(path)) return false
  await rm(path, { force: true })
  return true
}
