import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Platform } from './platform'
import { autoApprovePrefixes, scanProject, type ProjectScan } from './project-scan'
import { listSkills, writeLocalSkill } from './skills'
import type {
  OnboardingAnswers,
  OnboardingApplyPayload,
  OnboardingFacts,
  OnboardingPlan,
  OnboardingResult,
  SkillDraft
} from '../shared/ipc'

/**
 * The new-project wizard: ask what the project is, then build the two things
 * that make an agent useful on day one — an `AGENTS.md` and a couple of skills
 * that use the project's *real* commands.
 *
 * Everything here is local and offline: no model call, no network, no download.
 * That is deliberate. A wizard that needs a working model to explain a project
 * cannot be the first thing a new user meets.
 */

const MARKER = join('.charliecode', 'onboarded.json')
const MAX_AGENTS_CHARS = 32_000

const KINDS: { id: string; label: string; hint: string }[] = [
  { id: 'web', label: 'Web app', hint: 'frontend, componenti, stato' },
  { id: 'api', label: 'API / backend', hint: 'endpoint, database, servizi' },
  { id: 'cli', label: 'CLI / tool', hint: 'comandi, argomenti, output' },
  { id: 'library', label: 'Libreria', hint: 'API pubblica, compatibilità' },
  { id: 'data', label: 'Data / ML', hint: 'dataset, training, notebook' },
  { id: 'mobile', label: 'Mobile', hint: 'iOS, Android, schermate' },
  { id: 'other', label: 'Altro', hint: 'descrivilo tu' }
]

export function onboardingKinds(): typeof KINDS {
  return KINDS
}

function markerPath(workspace: string): string {
  return join(workspace, MARKER)
}

export async function isOnboarded(workspace: string): Promise<boolean> {
  return existsSync(markerPath(workspace))
}

export async function skipOnboarding(workspace: string): Promise<void> {
  await mkdir(join(workspace, '.charliecode'), { recursive: true })
  await writeFile(
    markerPath(workspace),
    `${JSON.stringify({ skipped: true, at: new Date().toISOString() }, null, 2)}\n`,
    'utf8'
  )
}

export async function inspectProject(
  platform: Platform,
  workspace: string
): Promise<OnboardingFacts> {
  const scan = await scanProject(workspace)
  const skills = await listSkills(platform, workspace)
  return {
    workspace,
    languages: scan.languages,
    ...(scan.packageManager ? { packageManager: scan.packageManager } : {}),
    commands: scan.commands,
    files: scan.files.length,
    truncated: scan.truncated,
    isGit: scan.isGit,
    ...(scan.agentsFile ? { agentsFile: scan.agentsFile } : {}),
    hasMemory: scan.hasMemory,
    skillCount: skills.length,
    needsOnboarding: !scan.agentsFile && !(await isOnboarded(workspace))
  }
}

function kindLabels(kinds: string[]): string[] {
  return KINDS.filter((kind) => kinds.includes(kind.id)).map((kind) => kind.label)
}

/**
 * The draft AGENTS.md. Only facts that were actually detected: an instruction
 * file full of guesses teaches the model to guess.
 */
export function draftAgentsMd(scan: ProjectScan, answers: OnboardingAnswers): string {
  const name = basename(scan.root) || 'progetto'
  const summary = answers.summary.trim()
  const kinds = kindLabels(answers.kinds)

  const lines: string[] = [`# ${name}`, '']
  if (summary) lines.push(summary, '')
  if (kinds.length > 0) lines.push(`Tipo: ${kinds.join(', ')}.`, '')

  lines.push('## Stack', '')
  if (scan.languages.length > 0) lines.push(`- Linguaggi: ${scan.languages.join(', ')}`)
  if (scan.packageManager) lines.push(`- Package manager: ${scan.packageManager}`)
  if (scan.isGit) lines.push('- Repository git: sì')
  lines.push('')

  lines.push('## Comandi', '')
  if (scan.commands.length > 0) {
    for (const command of scan.commands) lines.push(`- \`${command}\``)
  } else {
    lines.push('- (nessun comando rilevato: aggiungi qui come si testa il progetto)')
  }
  lines.push('')

  lines.push('## Regole', '')
  lines.push('- Prima di modificare un file, leggilo.')
  lines.push('- Dopo una modifica, verifica con il comando più stretto disponibile.')
  if (scan.commands.some((command) => command.includes('test'))) {
    lines.push('- Non modificare i test per farli passare: correggi il codice.')
  }
  if (scan.isGit) {
    lines.push('- Non fare `git push --force` e non firmare i commit per conto mio.')
  }
  lines.push('')

  lines.push('## Come lavorare', '')
  lines.push('- Cambi piccoli e verificabili, un problema per volta.')
  lines.push('- Se una richiesta è ambigua, fai una domanda invece di indovinare.')
  if (kinds.includes('Web app') || kinds.includes('API / backend')) {
    lines.push('- Rispetta le convenzioni già presenti nel codice invece di introdurne di nuove.')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

const RISKY_COMMAND =
  /(\brm\s+-rf\b|\bsudo\b|\bchmod\s+777\b|--no-verify|\bgit\s+push\s+--force\b|\bcurl\b[^|]*\|\s*(sh|bash))/i

function warningsFor(body: string): string[] {
  const found = new Set<string>()
  for (const line of body.split('\n')) {
    const match = RISKY_COMMAND.exec(line)
    if (match) found.add(match[0].trim())
  }
  return [...found]
}

function skillFromCommand(command: string): SkillDraft | undefined {
  const parts = command.split(' ').filter(Boolean)
  const action = parts[1] ?? parts[0]
  if (!action) return undefined
  const id = action.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()
  if (!id) return undefined

  const body = [
    `# ${action}`,
    '',
    `Esegui \`${command}\` e leggi l'output per intero prima di rispondere.`,
    '',
    '1. Lancia il comando.',
    '2. Se fallisce, correggi la causa nel codice: non disattivare la verifica.',
    '3. Rilancia lo stesso comando finché non passa.',
    '4. Riporta il comando eseguito e l\'esito in una riga.'
  ].join('\n')

  return {
    id: `run-${id}`,
    name: `run-${id}`,
    description: `Come lanciare e interpretare \`${command}\` in questo progetto`,
    body,
    origin: 'generated',
    warnings: warningsFor(body)
  }
}

/**
 * Curated templates: short, opinionated procedures that are worth more than
 * "run the test command". Shipped with the app, so installing one is a local
 * file write, not a download.
 */
function catalogSkills(scan: ProjectScan, answers: OnboardingAnswers): SkillDraft[] {
  const drafts: SkillDraft[] = []
  const kinds = answers.kinds
  const hasTests = scan.commands.some((command) => command.includes('test'))

  if (hasTests || kinds.includes('library') || kinds.includes('api')) {
    const commands = scan.commands.filter((command) =>
      /(test|typecheck|lint)/.test(command)
    )
    const body = [
      '# Prima di consegnare',
      '',
      'Verifica nell\'ordine più stretto, fermandoti al primo errore:',
      '',
      ...(commands.length > 0
        ? commands.map((command) => `- \`${command}\``)
        : ['- il comando di test del progetto']),
      '',
      'Se un test fallisce, leggi il messaggio e correggi la causa. Non commentare il test,',
      'non allentare l\'asserzione, non aggiungere `skip`.'
    ].join('\n')

    drafts.push({
      id: 'verify-before-commit',
      name: 'verify-before-commit',
      description: 'La sequenza di verifica da eseguire prima di dire che una modifica è pronta',
      body,
      origin: 'catalog',
      warnings: warningsFor(body)
    })
  }

  if (scan.isGit) {
    const body = [
      '# Revisione di un diff',
      '',
      '1. `git status` e `git diff` per vedere cosa è cambiato davvero.',
      '2. Per ogni file: la modifica risponde alla richiesta o è rumore?',
      '3. Cerca i casi limite: input vuoto, errore di rete, path relativo, permessi.',
      '4. Elenca i problemi come `file:riga — problema`, dal più grave.',
      '5. Se non trovi problemi, dillo in una riga: non inventare.',
      '',
      'Non fare commit, non fare push, non toccare lo staging: la revisione è sola lettura.'
    ].join('\n')

    drafts.push({
      id: 'review-diff',
      name: 'review-diff',
      description: 'Come rivedere un diff prima di consegnarlo, con i problemi in file:riga',
      body,
      origin: 'catalog',
      warnings: warningsFor(body)
    })
  }

  if (kinds.includes('web') || kinds.includes('mobile')) {
    const body = [
      '# Interfaccia: cosa controllare',
      '',
      '- Gli stati vuoto, caricamento ed errore esistono davvero, o solo quello felice?',
      '- Il testo entra nei contenitori a 320px di larghezza?',
      '- I controlli hanno un nome accessibile (label, aria-label)?',
      '- Il focus resta visibile da tastiera?',
      '',
      'Verifica nel browser o nell\'emulatore, non solo nel codice.'
    ].join('\n')

    drafts.push({
      id: 'ui-checklist',
      name: 'ui-checklist',
      description: 'Controlli minimi prima di dichiarare finita una schermata',
      body,
      origin: 'catalog',
      warnings: warningsFor(body)
    })
  }

  return drafts
}

export function draftSkills(scan: ProjectScan, answers: OnboardingAnswers): SkillDraft[] {
  const seen = new Set<string>()
  const drafts: SkillDraft[] = []

  for (const draft of [...catalogSkills(scan, answers), ...scan.commands.map(skillFromCommand)]) {
    if (!draft || seen.has(draft.id)) continue
    seen.add(draft.id)
    drafts.push(draft)
  }

  return drafts.slice(0, 5)
}

export async function planOnboarding(
  platform: Platform,
  workspace: string,
  answers: OnboardingAnswers
): Promise<OnboardingPlan> {
  const scan = await scanProject(workspace)
  const agentsPath = join(workspace, 'AGENTS.md')
  const existing = scan.agentsFile

  // Never overwrite instructions the project already has: start from them and
  // let the user see the diff before saving.
  let agentsMd = draftAgentsMd(scan, answers)
  if (existing) {
    const path = join(workspace, existing)
    const current = await readFile(path, 'utf8').catch(() => '')
    const additions = agentsMd
      .split('\n')
      .filter((line) => line.trim() && !current.includes(line.trim()))
      .join('\n')
    agentsMd = `${current.trimEnd()}\n\n<!-- aggiunto dal wizard di CharlieCode -->\n${additions}\n`
  }

  return {
    agentsMdPath: existing ? join(workspace, existing) : agentsPath,
    agentsMd,
    agentsMdExists: Boolean(existing),
    skills: draftSkills(scan, answers),
    autoApproveCommands: autoApprovePrefixes(scan.commands)
  }
}

export async function applyOnboarding(
  platform: Platform,
  workspace: string,
  payload: OnboardingApplyPayload
): Promise<OnboardingResult> {
  const scan = await scanProject(workspace)
  const written: string[] = []
  const skipped: string[] = []

  if (payload.writeAgentsMd) {
    const text = payload.agentsMd.slice(0, MAX_AGENTS_CHARS).trimEnd()
    if (text) {
      const target = scan.agentsFile ? join(workspace, scan.agentsFile) : join(workspace, 'AGENTS.md')
      await writeFile(target, `${text}\n`, 'utf8')
      written.push(target)
    }
  }

  // Skill bodies are regenerated here, never taken from the renderer: the UI can
  // only pick ids, so it cannot write arbitrary content into a skill.
  const drafts = new Map(draftSkills(scan, payload.answers).map((draft) => [draft.id, draft]))
  const installed = []
  for (const id of payload.skillIds) {
    const draft = drafts.get(id)
    if (!draft) {
      skipped.push(id)
      continue
    }
    const result = await writeLocalSkill(platform, workspace, draft, 'project')
    if (result.created) {
      written.push(result.skill.path)
      installed.push(result.skill)
    } else {
      skipped.push(`${id} (già presente)`)
    }
  }

  // Only prefixes that exist in this project: auto-approving an invented command
  // would be a permission granted to nothing.
  const allowed = new Set(autoApprovePrefixes(scan.commands))
  const autoApprove = payload.autoApproveCommands.filter((prefix) => allowed.has(prefix))

  await mkdir(join(workspace, '.charliecode'), { recursive: true })
  await writeFile(
    markerPath(workspace),
    `${JSON.stringify(
      { at: new Date().toISOString(), written: written.length, skills: installed.length },
      null,
      2
    )}\n`,
    'utf8'
  )

  return { written, skipped, skills: installed, autoApprove }
}
