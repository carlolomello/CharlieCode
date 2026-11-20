/**
 * "Squadra CLI": one turn split across several processes of the same CLI.
 *
 * A CLI like axet-code or cline works one item at a time, which is slow when
 * the items are independent (ten Salesforce fields, ten metadata files). The
 * app cannot inject subagents into the CLI's own loop, so the split happens
 * outside it:
 *
 *  1. the CLI plans the turn and answers with a JSON list of independent items;
 *  2. the app runs those items as parallel CLI processes, never two on the same
 *     file, capped by the profile's `maxWorkers`;
 *  3. the CLI integrates and verifies once, and its answer is the turn's answer.
 *
 * Everything here is pure except the prompts: no process is spawned, so the
 * rules above are testable without a CLI installed.
 */

export interface CliPlanItem {
  title: string
  /** Workspace-relative paths this item may touch. */
  files: string[]
  instructions: string
}

export interface CliPlan {
  items: CliPlanItem[]
  reason?: string
}

/** More items than this and the plan is noise, not a plan. */
export const MAX_PLAN_ITEMS = 8
export const DEFAULT_MAX_WORKERS = 3
export const MAX_WORKERS = 6

/** Clamps whatever the profile (or an old file) says to a usable number. */
export function maxWorkersOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_WORKERS
  return Math.min(MAX_WORKERS, Math.max(2, Math.round(value)))
}

/**
 * Finds the plan inside whatever the CLI printed: fenced JSON, prose before the
 * object, or a trailing explanation. Only an object with an `items`/`tasks`
 * array counts; anything else means "no plan", and the turn runs normally.
 */
export function parseCliPlan(text: string): CliPlan | undefined {
  const candidates = jsonObjects(text)
  for (const candidate of candidates) {
    const record = candidate as Record<string, unknown>
    const raw = Array.isArray(record.items)
      ? record.items
      : Array.isArray(record.tasks)
        ? record.tasks
        : undefined
    if (!raw) continue

    const items: CliPlanItem[] = []
    const seen = new Set<string>()

    for (const entry of raw.slice(0, MAX_PLAN_ITEMS)) {
      const item = planItem(entry, items.length + 1)
      if (!item) continue
      const key = item.instructions.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }

    if (items.length === 0) continue
    const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, 400) : ''
    return { items, ...(reason ? { reason } : {}) }
  }
  return undefined
}

function planItem(entry: unknown, index: number): CliPlanItem | undefined {
  if (typeof entry === 'string') {
    const instructions = entry.trim()
    return instructions
      ? { title: `Lavoro ${index}`, files: [], instructions: instructions.slice(0, 4_000) }
      : undefined
  }
  if (typeof entry !== 'object' || entry === null) return undefined

  const record = entry as Record<string, unknown>
  const instructions = String(
    record.instructions ?? record.prompt ?? record.description ?? record.task ?? ''
  ).trim()
  if (!instructions) return undefined

  const rawFiles = Array.isArray(record.files)
    ? record.files
    : Array.isArray(record.paths)
      ? record.paths
      : typeof record.file === 'string'
        ? [record.file]
        : []

  const files: string[] = []
  for (const value of rawFiles.slice(0, 20)) {
    if (typeof value !== 'string') continue
    const path = normalizePath(value)
    if (path && !files.includes(path)) files.push(path)
  }

  const title = String(record.title ?? record.name ?? '').trim().slice(0, 80)
  return {
    title: title || `Lavoro ${index}`,
    files,
    instructions: instructions.slice(0, 4_000)
  }
}

/** Relative, no `./`, no escape from the workspace: a scope, not a path. */
function normalizePath(value: string): string | undefined {
  const cleaned = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
  if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:\//.test(cleaned)) return undefined
  if (cleaned.split('/').includes('..')) return undefined
  if (cleaned.length > 300) return undefined
  return cleaned
}

/**
 * Every balanced `{...}` in the text, in order. Cheap and forgiving: a model
 * that wraps JSON in prose still produces a usable plan.
 */
function jsonObjects(text: string): unknown[] {
  const objects: unknown[] = []
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            objects.push(JSON.parse(text.slice(start, index + 1)))
          } catch {
            // Not JSON; the next `{` may still be the plan.
          }
          break
        }
      }
    }
    if (objects.length > 0) return objects
  }
  return objects
}

/**
 * Splits items into waves that can run at the same time: no two items in a
 * wave touch the same file, and a wave never exceeds `maxWorkers`. Items
 * without files are independent by definition.
 */
export function scheduleWaves(items: CliPlanItem[], maxWorkers: number): CliPlanItem[][] {
  const limit = Math.min(MAX_WORKERS, Math.max(1, Math.round(maxWorkers)))
  const waves: CliPlanItem[][] = []

  for (const item of items) {
    let placed = false
    for (const wave of waves) {
      if (wave.length >= limit) continue
      const taken = new Set(wave.flatMap((entry) => entry.files))
      if (item.files.some((file) => taken.has(file))) continue
      wave.push(item)
      placed = true
      break
    }
    if (!placed) waves.push([item])
  }

  return waves
}

/* ------------------------------- prompts -------------------------------- */

export function planPrompt(input: {
  prompt: string
  maxWorkers: number
  /** Project rules, already trimmed by the caller. */
  context?: string
}): string {
  return [
    'Stai pianificando un turno di lavoro, non eseguendolo.',
    'Non modificare file, non creare file, non eseguire comandi che scrivono.',
    '',
    'Rispondi SOLO con un oggetto JSON, senza testo prima o dopo:',
    '{"items":[{"title":"...","files":["percorso/relativo"],"instructions":"..."}]}',
    '',
    'Regole:',
    `- una voce per ogni unità di lavoro indipendente, al massimo ${input.maxWorkers};`,
    '- se la richiesta è una sola modifica coerente, una sola voce;',
    '- "files" elenca i file che quella voce toccherà, percorsi relativi al progetto;',
    '- due voci non devono elencare lo stesso file: se lo condividono, sono una voce sola;',
    '- "instructions" deve essere autosufficiente: cosa creare o cambiare, nomi esatti, cosa riportare;',
    '- non pianificare deploy, validate, publish, push o migrate: li esegue il turno finale.',
    input.context ? `\nRegole del progetto:\n${input.context}` : '',
    `\nRichiesta da pianificare:\n${input.prompt}`
  ]
    .filter(Boolean)
    .join('\n')
}

export function workerPrompt(input: {
  item: CliPlanItem
  index: number
  total: number
  workspace: string
  context?: string
}): string {
  const scope =
    input.item.files.length > 0
      ? `File di questo lavoro (sono gli unici che puoi toccare):\n${input.item.files
          .map((file) => `- ${file}`)
          .join('\n')}`
      : 'Nessun file specifico: crea solo i file che questa parte richiede.'

  return [
    `Sei il worker ${input.index} di ${input.total} di un turno diviso tra più processi.`,
    'Gli altri worker stanno lavorando su altre parti in parallelo: non toccare il loro lavoro.',
    '',
    `Lavoro: ${input.item.title}`,
    scope,
    '',
    'Istruzioni:',
    input.item.instructions,
    '',
    'Regole:',
    '- modifica solo i file elencati sopra; se serve un file fuori da questo elenco, dillo e fermati;',
    '- non eseguire deploy, validate, publish, push, migrate: li esegue il turno finale;',
    '- non creare file di riepilogo o di appunti;',
    `- il progetto è ${input.workspace}.`,
    input.context ? `\nRegole del progetto:\n${input.context}` : '',
    '',
    'Alla fine riporta in poche righe: file toccati, cosa hai fatto, cosa resta da verificare.'
  ]
    .filter(Boolean)
    .join('\n')
}

export function integrationPrompt(input: {
  prompt: string
  workers: { item: CliPlanItem; text: string; error?: string }[]
}): string {
  const reports = input.workers
    .map((worker, index) => {
      const outcome = worker.error
        ? `ERRORE: ${worker.error}`
        : worker.text.trim().slice(0, 1_500) || '(nessun rapporto)'
      return `${index + 1}. ${worker.item.title}\n${outcome}`
    })
    .join('\n\n')

  return [
    'Il turno è stato diviso tra più worker che hanno lavorato in parallelo. Ecco i loro rapporti:',
    '',
    reports,
    '',
    `Richiesta originale:\n${input.prompt}`,
    '',
    'Ora chiudi tu il turno:',
    '- leggi i file toccati e verifica che il risultato sia coerente e completo;',
    '- correggi le incoerenze e completa ciò che manca;',
    '- esegui una volta sola le validazioni del progetto, se servono;',
    '- non rifare il lavoro già fatto e non ripetere i rapporti: riporta il risultato.'
  ].join('\n')
}
