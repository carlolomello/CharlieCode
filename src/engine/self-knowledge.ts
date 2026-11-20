import { resolvePlugins } from './plugins'
import { globalSkillsDir } from './skills'
import type { Platform } from './platform'
import type { RoutingConfig } from './routing'
import type { CharlieCodeConfig, CliProfile, ModelEntry } from './types'

/**
 * What CharlieCode knows about itself.
 *
 * The app is configurable from inside the conversation: a user can ask "set
 * CharlieCode up for this model" or "make the reviewer cheaper". That only works
 * if the model knows the architecture, the config files and the current state,
 * and if it can change the app through a validated tool instead of guessing.
 *
 * Two consumers:
 *  - `selfKnowledgePrompt` is a compact section of the system prompt, always on;
 *  - `formatAppState` is the exact snapshot returned by `charliecode_config`.
 *
 * Neither ever includes an API key. `providerKeys` is a boolean map.
 */

export interface SelfKnowledgeCliProfile {
  profile: CliProfile
  available: boolean
  path?: string
}

export interface SelfKnowledgeOptions {
  platform: Platform
  /** Model actually answering this turn. */
  modelKey?: string
  workspace?: string
  cliProfiles?: SelfKnowledgeCliProfile[]
  routing?: RoutingConfig
  appVersion?: string
  /** False for CLI backends, which do not have the config tool. */
  canApply: boolean
}

function pluginLine(config: CharlieCodeConfig): string {
  return resolvePlugins(config)
    .map((plugin) => `${plugin.id}=${plugin.enabled ? 'on' : 'off'}`)
    .join(' · ')
}

function routingLine(routing?: RoutingConfig): string {
  if (!routing?.enabled) return 'spento'
  const roles = Object.entries(routing.roles)
    .map(([role, route]) => `${role}→${route?.modelKey}${route?.effort ? ` (${route.effort})` : ''}`)
    .join(', ')
  return roles ? `attivo (${roles})` : 'spento'
}

export function selfKnowledgePrompt(
  config: CharlieCodeConfig,
  options: SelfKnowledgeOptions
): string {
  const { platform } = options
  const configPath = platform.configPath('config.json')
  const credentialsPath = platform.configPath('credentials.json')
  const cliDir = platform.configPath('clis')
  const activeProviders = config.providers.filter((provider) => provider.enabled)
  const cliProfiles = options.cliProfiles ?? []
  const model = options.modelKey ?? config.defaultModel ?? '(nessuno)'
  const workspace = options.workspace ?? '(nessun progetto aperto)'

  const applyInstructions = options.canApply
    ? [
        '1. Chiama `charliecode_config` con action "read": ottieni lo stato esatto e le chiavi modello valide.',
        '2. Proponi la modifica concreta: cosa cambia, perché, effetto atteso. Se ci sono alternative, consiglia la migliore.',
        '3. Applica con action "apply" solo dopo l’ok dell’utente: il tool mostra il diff e chiede permesso. Non inventare chiavi modello.',
        '4. Per il routing puoi creare o modificare `.charliecode/routing.yaml` con write/edit. Formato:',
        '   enabled: true',
        '   roles:',
        '     explorer: { model: provider::model, effort: low }',
        '     implementer: { model: "cli:<profilo>::<modello>" }',
        '5. Chiavi API e nuovi provider: guida l’utente in Impostazioni. Nuovi profili CLI: Impostazioni → CLI esterne (Analizza --help). Non modificare credentials.json.'
      ]
    : [
        'In questo backend non hai il tool `charliecode_config`: guida l’utente con passi e valori esatti (file, campo, valore).',
        'Non inventare chiavi modello, non chiedere chiavi API in chat e non modificare credentials.json.'
      ]

  return [
    '## CharlieCode: conosci te stesso',
    'Sei CharlieCode, un’app desktop Electron per il coding multi-agente: motore TypeScript headless, UI React, IPC tipizzato. Non sei solo il modello: sei l’app che ospita la conversazione.',
    '',
    '### Dove vive la configurazione',
    `- App: ${configPath} — provider OpenAI-compatible, modello predefinito, effort, fallback, override per modello, agenti, plugin, CLI worker.`,
    `- Credenziali: ${credentialsPath} — le scrive solo l’utente. Non leggerle, non stamparle, non proporre di incollarle in chat.`,
    `- CLI esterne: ${cliDir}/<id>.json — profili definiti dall’utente: comando, argv, modelli, effort, output. Non esistono preset di prodotto.`,
    `- Routing subagenti: <progetto>/.charliecode/routing.yaml — explorer, reviewer e implementer, con modello nativo o CLI.`,
    '- Progetto: AGENTS.md / CHARLIECODE.md / CLAUDE.md, .charliecode/memory.md, .charliecode/skills/.',
    `- Skill globali: ${globalSkillsDir(platform)}.`,
    '',
    '### Come sei fatto',
    '- Backend: modelli nativi via API OpenAI-compatible oppure CLI esterne. La conversazione è una sola: cambiando backend il contesto resta (briefing riassunto o resume nativo).',
    '- Tool: read, ls, glob, grep, write, edit, bash, task, skill. I plugin aggiungono remember, suggest_setup, fetch_url.',
    '- Multi-agente: `task` con ruoli explorer (legge), reviewer (analizza), implementer (scrive). Plan mode propaga la sola lettura.',
    '- Contesto: cronologia canonica per sessione, compattazione reversibile, sidecar `.context.json`.',
    '- Permessi: ogni scrittura mostra un diff e chiede conferma; i comandi bash si approvano per prefisso.',
    '',
    '### Stato attuale',
    `- Progetto: ${workspace}`,
    `- Modello richiesto per questo turno: ${model}`,
    `- Modello predefinito: ${config.defaultModel ?? '(nessuno)'}`,
    `- Effort predefinito: ${config.effort} (quello di questa sessione può essere diverso)`,
    `- Provider attivi: ${activeProviders.length} · fallback: ${config.fallbackModels.join(', ') || '(nessuno)'}`,
    `- Plugin: ${pluginLine(config)}`,
    `- CLI esterne: ${cliProfiles.map((entry) => entry.profile.id).join(', ') || '(nessuna)'}`,
    `- Routing subagenti: ${routingLine(options.routing)}`,
    '',
    '### Quando ti chiedono di configurare CharlieCode',
    'Vale per modello predefinito, effort, fallback, override per modello, passi degli agenti, plugin, provider e routing.',
    ...applyInstructions,
    'Le modifiche alla configurazione valgono dal prossimo turno; le nuove chat usano i nuovi default.'
  ].join('\n')
}

export interface AppStateInput {
  config: CharlieCodeConfig
  configPath: string
  appVersion?: string
  workspace?: string
  modelKey?: string
  /** Native models only: these are the valid keys for default/fallback/subagent. */
  models: ModelEntry[]
  /** Presence only. The key itself never leaves `resolveApiKey`. */
  providerKeys: Record<string, boolean>
  cliProfiles?: SelfKnowledgeCliProfile[]
  routing?: RoutingConfig
  skills?: { id: string; source: string }[]
}

/** Exact snapshot for the `charliecode_config` read action. */
export function formatAppState(input: AppStateInput): string {
  const { config } = input
  const lines: string[] = [
    'CONFIGURAZIONE DI CHARLIECODE (dati; non copiare il blocco nella risposta)',
    `versione: ${input.appVersion ?? '(sconosciuta)'}`,
    `config: ${input.configPath}`,
    `progetto: ${input.workspace ?? '(nessuno)'}`,
    `modello richiesto per questo turno: ${input.modelKey ?? '(sconosciuto)'}`,
    `modello predefinito: ${config.defaultModel ?? '(nessuno)'}`,
    `effort predefinito: ${config.effort}`,
    `fallback: ${config.fallbackModels.join(', ') || '(nessuno)'}`,
    '',
    'provider:'
  ]

  for (const provider of config.providers) {
    lines.push(
      `- ${provider.id} (${provider.label}) · attivo=${provider.enabled ? 'si' : 'no'} · ` +
        `key=${input.providerKeys[provider.id] ? 'si' : 'no'} · tipo=${provider.kind} · url=${provider.baseUrl}` +
        (provider.showAllModels ? ' · mostraTutti=true' : '')
    )
  }

  lines.push('', 'modelli nativi (chiavi valide per defaultModel, fallback e subagentModel):')
  const models = input.models.slice(0, 300)
  for (const model of models) {
    lines.push(`- ${model.key} — ${model.label}`)
  }
  if (input.models.length > models.length) {
    lines.push(`- … altri ${input.models.length - models.length} modelli non elencati`)
  }

  const overrides = Object.entries(config.modelOverrides)
  if (overrides.length > 0) {
    lines.push('', 'override per modello:')
    for (const [key, override] of overrides) {
      lines.push(
        `- ${key}: effort=${override.effort ?? '(default)'}` +
          (override.efforts ? ` · livelli=${override.efforts.join(', ')}` : '')
      )
    }
  }

  lines.push(
    '',
    `plugin: ${pluginLine(config)}`,
    `agenti: maxSteps=${config.agents.maxSteps} · subagentMaxSteps=${config.agents.subagentMaxSteps} · ` +
      `subagentModel=${config.agents.subagentModel ?? '(modello corrente)'}`,
    `autoApprove: ${config.agents.autoApprove.join(', ') || '(nessuno)'}`,
    `autoApproveCommands: ${config.agents.autoApproveCommands.join(', ') || '(nessuno)'}`,
    `CLI worker: ${config.external?.id ?? '(nessuna)'}`
  )

  const cliProfiles = input.cliProfiles ?? []
  lines.push('', 'CLI esterne:')
  if (cliProfiles.length === 0) {
    lines.push('- (nessuna)')
  } else {
    for (const entry of cliProfiles) {
      lines.push(
        `- ${entry.profile.id} (${entry.profile.label}) · disponibile=${entry.available ? 'si' : 'no'} · ` +
          `comando=${entry.profile.command}${entry.path ? ` · percorso=${entry.path}` : ''}`
      )
    }
  }

  lines.push('', `routing subagenti: ${routingLine(input.routing)}`)
  if (input.routing?.source) lines.push(`routing file: ${input.routing.source}`)
  if (input.routing?.error) lines.push(`routing errore: ${input.routing.error}`)

  const skills = input.skills ?? []
  lines.push('', `skill: ${skills.map((skill) => `${skill.id} (${skill.source})`).join(', ') || '(nessuna)'}`)

  return lines.join('\n')
}
