import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { autoApprovePrefixes, scanProject } from './project-scan'

/**
 * The "setup advisor" plugin: read the project, then suggest the boring things
 * that make an agent effective — the exact test command, an `AGENTS.md`, which
 * commands are safe to auto-approve, which skills are worth writing.
 *
 * Pure heuristics on purpose: no model call, no network, instant answer.
 */

const SKILL_IDEAS: Record<string, { name: string; why: string }[]> = {
  TypeScript: [
    {
      name: 'typecheck',
      why: '`tsc --noEmit` prima di ogni consegna: evita errori che i test non vedono'
    }
  ],
  Python: [
    { name: 'venv-test', why: 'attivare il virtualenv giusto e lanciare pytest nello stesso modo ogni volta' }
  ],
  Rust: [{ name: 'cargo-check', why: '`cargo check` + `clippy` come verifica standard' }],
  Go: [{ name: 'go-test', why: '`go test ./...` con il timeout e i tag corretti' }]
}

export interface AdvisorReport {
  markdown: string
  /**
   * Compact, non-prose version of the same findings, used as tool output.
   * A markdown report gets copied verbatim by weaker models; a fact list is
   * clearly input data.
   */
  facts: string
  /** Commands worth auto-approving, already in the app's prefix format. */
  autoApproveCommands: string[]
}

export async function suggestSetup(workspace: string): Promise<AdvisorReport> {
  const scan = await scanProject(workspace)
  const root = workspace
  const languages = scan.languages
  const commands = scan.commands

  const hasAgents = ['AGENTS.md', 'CHARLIECODE.md', 'CLAUDE.md'].filter((name) =>
    existsSync(join(root, name))
  )
  const hasMemory = scan.hasMemory
  const hasSkills = scan.skillDirs
  const isGit = scan.isGit

  const sections: string[] = []
  sections.push(`## Il progetto in breve\n\n- Linguaggi: ${languages.join(', ') || 'non rilevati'}`)
  sections.push(`- File analizzati: ${scan.files.length}${scan.truncated ? ' (scansione troncata)' : ''}`)
  sections.push(`- Git: ${isGit ? 'sì' : 'no'}`)
  sections.push(`- Istruzioni esistenti: ${hasAgents.length > 0 ? hasAgents.join(', ') : 'nessuna'}`)
  sections.push(`- Memoria del progetto: ${hasMemory ? 'presente' : 'non ancora creata'}`)
  sections.push(`- Skill installate: ${hasSkills.length > 0 ? hasSkills.join(', ') : 'nessuna'}`)

  if (commands.length > 0) {
    sections.push(`\n## Comandi verificati\n\n${commands.map((c) => `- \`${c}\``).join('\n')}`)
  }

  const missing: string[] = []
  if (hasAgents.length === 0) missing.push('**AGENTS.md assente.** È il posto giusto per i comandi qui sopra e per le regole del progetto: l’agente lo legge a ogni sessione.')
  if (!hasMemory) missing.push('**Nessuna memoria di progetto.** Il plugin *Memoria del progetto* la crea al primo utilizzo: serve a non rispiegare tutto ogni volta.')
  if (hasSkills.length === 0) missing.push('**Nessuna skill.** Le skill sono procedure riutilizzabili (`SKILL.md`) che l’agente carica solo quando servono.')
  if (missing.length > 0) sections.push(`\n## Cosa manca\n\n${missing.map((m) => `- ${m}`).join('\n')}`)

  const skillIdeas = languages.flatMap((language) => SKILL_IDEAS[language] ?? []).slice(0, 4)
  if (skillIdeas.length > 0) {
    sections.push(
      `\n## Skill consigliate\n\n${skillIdeas.map((idea) => `- \`${idea.name}\` — ${idea.why}`).join('\n')}`
    )
  }

  const autoApprove = autoApprovePrefixes(commands)
  if (autoApprove.length > 0) {
    sections.push(
      `\n## Automatismi consigliati\n\nPuoi auto-approvare (senza chiedere ogni volta):\n` +
        autoApprove.map((prefix) => `- \`${prefix}\` — sola verifica, nessuna scrittura`).join('\n')
    )
  }

  const agentLines = [
    '# AGENTS.md',
    '',
    '## Comandi',
    '',
    ...(commands.length > 0 ? commands.map((c) => `- \`${c}\``) : ['- (aggiungi qui i comandi del progetto)']),
    '',
    '## Regole',
    '',
    '- Prima di modificare un file, leggilo.',
    '- Dopo una modifica, verifica con il comando più stretto disponibile.'
  ]
  sections.push(`\n## AGENTS.md proposto\n\n\`\`\`markdown\n${agentLines.join('\n')}\n\`\`\``)

  const facts = [
    `linguaggi: ${languages.join(', ') || 'non rilevati'}`,
    `file scansionati: ${scan.files.length}${scan.truncated ? ' (troncato)' : ''}`,
    `git: ${isGit ? 'sì' : 'no'}`,
    `istruzioni: ${hasAgents.length > 0 ? hasAgents.join(', ') : 'nessuna'}`,
    `memoria progetto: ${hasMemory ? 'presente' : 'assente'}`,
    `skill: ${hasSkills.length > 0 ? hasSkills.join(', ') : 'nessuna'}`,
    `comandi: ${commands.length > 0 ? commands.join(' | ') : 'nessuno rilevato'}`,
    `mancante: ${missing.length > 0 ? missing.map((m) => m.replace(/\*\*/g, '')).join(' | ') : 'niente di rilevante'}`,
    `skill consigliate: ${
      skillIdeas.length > 0 ? skillIdeas.map((idea) => `${idea.name} (${idea.why})`).join(' | ') : 'nessuna'
    }`,
    `auto-approvabili: ${autoApprove.length > 0 ? autoApprove.join(' | ') : 'nessuno'}`
  ].join('\n')

  return { markdown: sections.join('\n'), facts, autoApproveCommands: autoApprove }
}
