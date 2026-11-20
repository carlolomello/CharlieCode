import { streamText, stepCountIs, type ModelMessage, type ToolSet } from 'ai'
import { findModel } from './catalog'
import { providerFor, resolveCandidates } from './client'
import { buildTools, toolTitle, type ToolRuntime } from './tools'
import { sanitizeMessages } from './context-store'
import { runExternalAgent } from './external-agents'
import { parseCliModelKey } from '../shared/cli-key'
import { selfKnowledgePrompt } from './self-knowledge'
import type { AppConfigPatch } from './app-config'
import { enabledPluginIds, pluginSystemPrompt, recordTurn, PLUGIN_READ_TOOLS } from './plugins'
import { skillsSystemPrompt } from './skills'
import type { Platform } from './platform'
import type { RoutingConfig, SubagentRole } from './routing'
import type { CliProfileInfo } from '../shared/ipc'
import type {
  CharlieCodeConfig,
  CliProfile,
  EngineEvent,
  ModelEntry,
  PermissionDecision,
  PermissionRequest,
  StreamRequest,
  TokenUsage
} from './types'

export interface AgentDeps {
  platform: Platform
  config: CharlieCodeConfig
  models: ModelEntry[]
  /** CLI profiles the user defined, with availability, used by the worker and the self tool. */
  cliProfiles?: CliProfileInfo[]
  workspace?: string
  /** Full model context from a previous turn, when available. */
  modelMessages?: ModelMessage[]
  /** Project rules from AGENTS.md, shared with subagents. */
  projectContext?: string
  askPermission: (request: PermissionRequest) => Promise<PermissionDecision>
  emit: (event: EngineEvent) => void
  maxSteps?: number
  subagentMaxSteps?: number
  /** Optional per-role routing read from `.charliecode/routing.yaml`. */
  routing?: RoutingConfig
  /** Version shown by the self-knowledge tool. */
  appVersion?: string
  /** Saves a validated app-config patch; absent for CLI backends. */
  applyConfig?: (patch: AppConfigPatch, validKeys?: string[]) => Promise<{
    config: CharlieCodeConfig
    path: string
    summary: string
  }>
}

export interface AgentResult {
  text: string
  modelKey: string
  /** Full context after this turn (input + new assistant/tool messages). */
  messages: ModelMessage[]
  /** Only the messages produced by this turn, for appending to a sidecar. */
  newMessages: ModelMessage[]
  steps: number
  toolCalls: number
  usage?: TokenUsage
  aborted: boolean
  error?: string
}

const SUBAGENT_PROMPTS: Record<string, string> = {
  explorer:
    'Sei un subagente esploratore. Il tuo compito è leggere il codice e riferire: non modificare file, ' +
    'non eseguire comandi che cambiano lo stato. Cerca con glob/grep, leggi i file rilevanti e ' +
    'restituisci un riassunto strutturato con percorsi e righe.',
  reviewer:
    'Sei un subagente revisore. Analizza il codice indicato e riporta bug, rischi e miglioramenti ' +
    'concreti. Non modificare file. Sii specifico: file, riga, problema, proposta.',
  implementer:
    'Sei un subagente implementatore. Implementa la modifica richiesta nel progetto, con modifiche ' +
    'minime e coerenti con lo stile esistente. Usa i tool, verifica con test/build quando possibile, ' +
    'poi riassumi cosa hai cambiato.'
}

function toolset(runtime: ToolRuntime, allow?: string[]): ToolSet {
  const all = buildTools(runtime) as Record<string, ToolSet[string]>
  if (!allow || allow.length === 0) return all as ToolSet
  return Object.fromEntries(Object.entries(all).filter(([name]) => allow.includes(name))) as ToolSet
}

function toUsage(usage: {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  totalTokens?: number | undefined
}): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'ResponseAbortedError')
}

function toModelMessages(messages: StreamRequest['messages']): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      return { role: 'assistant' as const, content: message.content }
    }
    const images = message.images ?? []
    if (images.length === 0) return { role: 'user' as const, content: message.content }
    return {
      role: 'user' as const,
      content: [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...images.map((image) => ({
          type: 'file' as const,
          mediaType: image.mediaType,
          data: { type: 'data' as const, data: image.data }
        }))
      ]
    }
  })
}

/** Last user text in the context, used for the memory diary line. */
function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.role !== 'user') continue
    if (typeof message.content === 'string') return message.content
    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ')
    if (text) return text
  }
  return ''
}

const PLAN_PROMPT = [
  'MODALITÀ PIANO (sola lettura).',
  'Hai a disposizione solo read, ls, glob, grep, `charliecode_config` in sola lettura e i tool di sola lettura dei plugin: non puoi scrivere file né eseguire comandi.',
  'Rispondi alla domanda dell’utente, non descrivere il progetto.',
  '- Se chiede bug, problemi o migliorie: elenca i problemi concreti che hai visto, ognuno con file:riga, perché è un problema e la correzione proposta. Ordina per impatto.',
  '- Se chiede un piano di implementazione: passi in ordine, file toccati, rischi.',
  'Non aprire con un riassunto di cosa fa il progetto: parti dalla risposta.',
  'Non affermare di aver modificato qualcosa. Il piano verrà approvato prima dell’esecuzione.'
].join('\n')

/**
 * Runs one agent turn: streams text, executes tools, lets the model iterate,
 * and (when it calls `task`) spawns isolated subagents that run the same loop
 * with their own context and tool subset.
 */
export async function runAgent(
  request: StreamRequest,
  deps: AgentDeps,
  options: {
    depth?: number
    agentId?: string
    agentName?: string
    allow?: string[]
    system?: string
    modelKey?: string
  } = {}
): Promise<AgentResult> {
  const depth = options.depth ?? 0
  const modelKey = options.modelKey ?? request.modelKey
  if (!deps.workspace) {
    // Falling back to `process.cwd()` made the agent operate on the Electron
    // app directory (or the CLI's home) without telling anyone.
    const message = 'Nessun progetto aperto: scegli una cartella prima di usare l’agente.'
    deps.emit({ type: 'error', message })
    return {
      text: '',
      modelKey,
      messages: [],
      newMessages: [],
      steps: 0,
      toolCalls: 0,
      aborted: false,
      error: message
    }
  }
  const workspace = deps.workspace
  const planMode = (request.mode ?? 'build') === 'plan'
  const plugins = enabledPluginIds(deps.config)
  // Plan mode never gets a writing tool, even if a caller passes one.
  const allow = planMode
    ? ['read', 'ls', 'glob', 'grep', 'task', 'skill', 'charliecode_config', ...PLUGIN_READ_TOOLS]
    : options.allow
  const pluginPrompt = await pluginSystemPrompt(deps.config, deps.workspace)
  const skillsPrompt = await skillsSystemPrompt(deps.platform, deps.workspace)
  // The main agent always knows what app it is running in. Subagents are scoped
  // to a piece of work and do not pay for this section.
  const selfPrompt =
    depth === 0
      ? selfKnowledgePrompt(deps.config, {
          platform: deps.platform,
          ...(modelKey ? { modelKey } : {}),
          ...(deps.workspace ? { workspace: deps.workspace } : {}),
          ...(deps.cliProfiles ? { cliProfiles: deps.cliProfiles } : {}),
          ...(deps.routing ? { routing: deps.routing } : {}),
          ...(deps.appVersion ? { appVersion: deps.appVersion } : {}),
          canApply: Boolean(deps.applyConfig)
        })
      : ''
  const systemPrompt = [
    options.system ?? request.system,
    // Project rules are part of the main prompt already; a subagent starts from
    // a clean context, so it needs them too.
    depth > 0 ? deps.projectContext ?? '' : '',
    selfPrompt,
    pluginPrompt,
    skillsPrompt,
    planMode ? PLAN_PROMPT : '',
    // A team turn is a user decision, not a model preference: say it plainly and
    // make the split concrete, so a weak model still delegates instead of
    // answering "fatto" after one read.
    request.team && depth === 0 && !planMode
      ? [
          'Modalità squadra attiva: questa richiesta va divisa tra subagenti.',
          '- Apri il turno con una `task` per ogni area indipendente (almeno 2, massimo 4), con ruoli distinti: esplorazione, implementazione, verifica.',
          '- Dai a ogni subagente un prompt autosufficiente: cosa creare o cambiare, file esatti, nomi esatti, cosa riportare.',
          '- Parallelizza solo ciò che non condivide niente: un file appartiene a un solo subagente, e due worker non devono scrivere lo stesso file.',
          '- Rispetta le dipendenze: se B usa l’API di A (una classe e il suo test, un campo e il codice che lo legge), prima A, poi B.',
          '- I comandi con effetti fuori dal progetto — deploy, validate, publish, push, migrate — li esegui tu, una volta sola, dopo i worker. Mai in parallelo tra subagenti.',
          '- Aspetta i risultati, poi integra tu: le modifiche finali sono tue, non dei subagenti.',
          '- Non delegare la stessa cosa a due subagenti e non delegare una singola lettura.'
        ].join('\n')
      : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  const { candidates, error } = resolveCandidates({ ...request, modelKey }, {
    platform: deps.platform,
    config: deps.config,
    models: deps.models
  })

  if (error || candidates.length === 0) {
    const message = error ?? 'Nessun modello disponibile.'
    deps.emit({ type: 'error', message })
    return { text: '', modelKey, messages: [], newMessages: [], steps: 0, toolCalls: 0, aborted: false, error: message }
  }

  const inputMessages = deps.modelMessages?.length
    ? deps.modelMessages
    : toModelMessages(request.messages)

  /**
   * The memory plugin keeps a diary entry per turn. Fire-and-forget: a failed
   * write must never fail the answer.
   */
  const rememberTurn = (): void => {
    if (depth !== 0 || !deps.workspace || !plugins.includes('memory')) return
    void recordTurn(deps.workspace, {
      request: lastUserText(inputMessages),
      files: [...touched],
      ...(planMode ? { mode: 'plan' as const } : {})
    }).catch(() => undefined)
  }

  let lastError: string | undefined
  /** Files this turn wrote or edited, for the project memory plugin. */
  const touched = new Set<string>()

  for (const candidate of candidates) {
    const { provider, model } = candidate
    let produced = false
    let text = ''
    let toolCalls = 0
    let startedAt = Date.now()
    let firstTokenAt: number | undefined
    let streamError: unknown

    const emit = (event: EngineEvent): void => {
      if (event.type === 'delta' || event.type === 'tool-call') produced = true
      if (event.type === 'tool-call' && (event.name === 'write' || event.name === 'edit')) {
        const path = (event.input as { path?: unknown } | undefined)?.path
        if (typeof path === 'string') touched.add(path)
      }
      deps.emit(event)
    }

    const runtime: ToolRuntime = {
      platform: deps.platform,
      workspace,
      signal: request.signal,
      depth,
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.agentName ? { agentName: options.agentName } : {}),
      autoApprove: deps.config.agents.autoApprove,
      autoApproveCommands: deps.config.agents.autoApproveCommands,
      plugins,
      config: deps.config,
      models: deps.models,
      modelKey,
      ...(deps.cliProfiles ? { cliProfiles: deps.cliProfiles } : {}),
      ...(deps.routing ? { routing: deps.routing } : {}),
      ...(deps.appVersion ? { appVersion: deps.appVersion } : {}),
      ...(deps.applyConfig ? { applyConfig: deps.applyConfig } : {}),
      ...(planMode ? { readOnly: true } : {}),
      askPermission: deps.askPermission,
      emit,
      runSubagent: async (sub) => {
        const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const name = sub.description.slice(0, 60)
        const role = (sub.agent ?? 'explorer') as SubagentRole
        const profiles = deps.cliProfiles ?? []
        const profileOf = (id: string): CliProfile | undefined =>
          profiles.find((entry) => entry.profile.id === id)?.profile
        const worker = deps.config.external
        const workerProfile = worker?.id ? profileOf(worker.id) : undefined

        // Backend precedence: an explicit model on the task, then the role
        // route, then the configured CLI worker, then the default subagent
        // model. A route that points at a missing model is ignored.
        const route = deps.routing?.enabled ? deps.routing.roles[role] : undefined
        const explicit = sub.model?.trim()
        const explicitCli = explicit ? parseCliModelKey(explicit) : undefined
        const explicitProfile = explicitCli ? profileOf(explicitCli.profileId) : undefined
        const explicitNative =
          explicit && !explicitCli && deps.models.some((model) => model.key === explicit)
            ? explicit
            : undefined

        const routeCli = route ? parseCliModelKey(route.modelKey) : undefined
        const routeProfile = routeCli ? profileOf(routeCli.profileId) : undefined
        const routeNative =
          route && !routeCli && deps.models.some((model) => model.key === route.modelKey)
            ? route.modelKey
            : undefined

        const target:
          | { kind: 'cli'; profile: CliProfile; model?: string; auto: boolean }
          | { kind: 'native'; modelKey: string } =
          explicitCli && explicitProfile
            ? {
                kind: 'cli',
                profile: explicitProfile,
                ...(explicitCli.model ? { model: explicitCli.model } : {}),
                auto: false
              }
            : explicitNative
              ? { kind: 'native', modelKey: explicitNative }
              : routeProfile
                ? {
                    kind: 'cli',
                    profile: routeProfile,
                    ...(routeCli?.model ? { model: routeCli.model } : {}),
                    auto: worker?.id === routeProfile.id && worker.auto === true
                  }
                : routeNative
                  ? { kind: 'native', modelKey: routeNative }
                  : workerProfile
                    ? {
                        kind: 'cli',
                        profile: workerProfile,
                        ...(worker?.model ? { model: worker.model } : {}),
                        auto: worker?.auto === true
                      }
                    : {
                        kind: 'native',
                        modelKey: deps.config.agents.subagentModel ?? modelKey
                      }

        // A route can pin the effort; otherwise the turn's effort carries.
        const subEffort = route?.effort ?? request.effort

        deps.emit({
          type: 'subagent-start',
          agentId,
          name,
          description: sub.prompt.slice(0, 200),
          modelKey:
            target.kind === 'cli'
              ? `${target.profile.label}${target.model ? ` · ${target.model}` : ''}`
              : target.modelKey
        })

        const allow =
          role === 'explorer' || role === 'reviewer'
            ? ['read', 'ls', 'glob', 'grep', 'skill']
            : undefined

        const started = Date.now()

        if (target.kind === 'cli') {
          // The model calls happen inside the CLI, with its auth, quota and
          // logs. We only orchestrate.
          try {
            const result = await runExternalAgent(
              target.profile,
              {
                prompt: sub.prompt,
                ...(target.model ? { model: target.model } : {}),
                ...(subEffort ? { effort: subEffort } : {}),
                // Reading is always allowed; writing only for an implementer.
                ...(planMode || role !== 'implementer' ? { plan: true } : {}),
                auto: target.auto && !planMode && role === 'implementer',
                workspace
              },
              {
                home: deps.platform.homeDir,
                stateDir: deps.platform.configDir,
                ...(request.signal ? { signal: request.signal } : {}),
                onText: (chunk) => deps.emit({ type: 'delta', text: chunk, agentId })
              }
            )
            const text = result.text || result.error || 'La CLI non ha prodotto output.'
            const ok = result.code === 0 && !result.aborted && !result.timedOut
            deps.emit({
              type: 'subagent-end',
              agentId,
              name,
              ok,
              summary: text.slice(0, 200),
              ms: Date.now() - started
            })
            return { ok, text, summary: text.slice(0, 200) }
          } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught)
            deps.emit({
              type: 'subagent-end',
              agentId,
              name,
              ok: false,
              summary: message,
              ms: Date.now() - started
            })
            return { ok: false, text: `Subagente fallito: ${message}`, summary: message }
          }
        }

        try {
          const result = await runAgent(
            {
              modelKey: target.modelKey,
              messages: [{ role: 'user', content: sub.prompt }],
              ...(subEffort ? { effort: subEffort } : {}),
              signal: request.signal,
              // Plan mode propagates: a subagent can never write either.
              ...(planMode ? { mode: 'plan' as const } : {})
            },
            {
              ...deps,
              maxSteps: deps.subagentMaxSteps ?? deps.config.agents.subagentMaxSteps,
              // The subagent starts from a clean context: that is the whole point.
              modelMessages: undefined
            },
            {
              depth: depth + 1,
              agentId,
              agentName: name,
              ...(allow ? { allow } : {}),
              system: `${SUBAGENT_PROMPTS[role] ?? SUBAGENT_PROMPTS.explorer!}\n\nProgetto: ${
                workspace
              }${deps.projectContext ? `\n\n${deps.projectContext}` : ''}`
            }
          )

          deps.emit({
            type: 'subagent-end',
            agentId,
            name,
            ok: !result.error,
            summary: result.text.slice(0, 400) || result.error || 'nessun output',
            ms: Date.now() - started
          })

          return {
            ok: !result.error,
            text: result.text || result.error || 'Il subagente non ha prodotto output.',
            summary: result.text.slice(0, 200)
          }
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught)
          deps.emit({ type: 'subagent-end', agentId, name, ok: false, summary: message, ms: Date.now() - started })
          return { ok: false, text: `Subagente fallito: ${message}`, summary: message }
        }
      }
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      startedAt = Date.now()
      firstTokenAt = undefined
      produced = false
      text = ''
      toolCalls = 0

      try {
        const compat = await providerFor(deps.platform, provider)
        const effort = request.effort ?? model.effort ?? deps.config.effort
        const providerOptions =
          effort !== 'none' ? { [provider.id]: { reasoningEffort: effort } } : undefined

        const result = streamText({
          model: compat.chatModel(model.id),
          system: systemPrompt,
          messages: inputMessages,
          tools: toolset(runtime, allow),
          stopWhen: stepCountIs(deps.maxSteps ?? deps.config.agents.maxSteps),
          maxOutputTokens: request.maxOutputTokens ?? 4096,
          abortSignal: request.signal,
          maxRetries: 0,
          onError: ({ error: caught }) => {
            streamError = caught
          },
          ...(providerOptions ? { providerOptions } : {})
        })

        for await (const part of result.fullStream) {
          if (request.signal?.aborted) break

          switch (part.type) {
            case 'text-delta': {
              if (!part.text) break
              if (!firstTokenAt) {
                firstTokenAt = Date.now()
                deps.emit({
                  type: 'start',
                  modelKey: model.key,
                  label: model.label,
                  ...(depth > 0 ? { fallbackFrom: undefined } : {})
                })
              }
              text += part.text
              emit({ type: 'delta', text: part.text, ...(options.agentId ? { agentId: options.agentId } : {}) })
              break
            }
            case 'reasoning-delta': {
              // A reasoning model talks to itself before answering. Showing it is
              // what makes a slow first token readable instead of a frozen app;
              // it stays out of `text`, so it never enters the session.
              if (!part.text) break
              emit({
                type: 'thinking',
                text: part.text,
                ...(options.agentId ? { agentId: options.agentId } : {})
              })
              break
            }
            case 'start-step': {
              emit({ type: 'step', index: toolCalls, ...(options.agentId ? { agentId: options.agentId } : {}) })
              break
            }
            case 'tool-call': {
              toolCalls++
              break
            }
            case 'error': {
              streamError = part.error
              break
            }
            default:
              break
          }
        }

        const steps = await result.steps
        const usage = await result.totalUsage
        // `response.messages` carries the provider's reasoning parts. Storing
        // them would feed the model its own monologue on the next turn, which is
        // how a weak model ends up repeating "ho già analizzato" forever.
        const newMessages: ModelMessage[] = sanitizeMessages(
          steps.flatMap((step) => step.response.messages)
        )
        const messages: ModelMessage[] = [...inputMessages, ...newMessages]

        deps.emit({
          type: 'done',
          modelKey: model.key,
          ms: Date.now() - startedAt,
          ttftMs: firstTokenAt ? firstTokenAt - startedAt : Date.now() - startedAt,
          usage: toUsage(usage),
          steps: steps.length,
          toolCalls,
          ...(request.signal?.aborted ? { aborted: true } : {})
        })

        rememberTurn()

        return {
          text,
          modelKey: model.key,
          messages,
          newMessages,
          steps: steps.length,
          toolCalls,
          usage: toUsage(usage),
          aborted: Boolean(request.signal?.aborted)
        }
      } catch (caught) {
        if (isAbort(streamError ?? caught)) {
          deps.emit({
            type: 'done',
            modelKey: model.key,
            ms: Date.now() - startedAt,
            ttftMs: 0,
            aborted: true
          })
          return {
            text,
            modelKey: model.key,
            messages: [], newMessages: [],
            steps: 0,
            toolCalls,
            aborted: true
          }
        }

        // Side effects already happened (tool ran, text shown): never retry
        // behind the user's back.
        if (produced) {
          const message = caught instanceof Error ? caught.message : String(caught)
          deps.emit({ type: 'error', message, modelKey: model.key })
          return {
            text,
            modelKey: model.key,
            messages: [], newMessages: [],
            steps: 0,
            toolCalls,
            aborted: false,
            error: message
          }
        }

        lastError = caught instanceof Error ? caught.message : String(caught)
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 600))
          continue
        }
        break
      }
    }
  }

  const message = lastError
    ? `Tutti i modelli hanno fallito. Ultimo errore: ${lastError}`
    : 'Nessun modello ha prodotto una risposta.'
  deps.emit({ type: 'error', message })
  return { text: '', modelKey, messages: [], newMessages: [], steps: 0, toolCalls: 0, aborted: false, error: message }
}

/** Builds the system prompt: identity, tools, multi-agent rules, project context. */
export function buildSystemPrompt(projectContext: string, workspace?: string): string {
  return [
    `Sei CharlieCode, un agente di coding che lavora dentro un progetto locale.`,
    workspace ? `Progetto aperto: ${workspace}` : 'Nessun progetto aperto: chiedi all’utente di sceglierne uno prima di modificare file.',
    '',
    'Regole:',
    '- Prima di modificare un file, leggilo. Usa glob/grep per orientarti, non indovinare i percorsi.',
    '- Preferisci modifiche minime e coerenti con lo stile del progetto.',
    '- Dopo una modifica, se possibile verifica con test, typecheck o build.',
    '- Non inventare output di comandi: se non lo hai eseguito, dillo.',
    '- Non dire di aver letto o esplorato file se non hai chiamato read/ls/glob/grep. Se non hai letto niente, non fingere: leggi, oppure dichiara i limiti della risposta.',
    '- Rispondi nella lingua dell’utente.',
    '',
    'Come rispondere:',
    '- Rispondi alla domanda. Non raccontare cosa fa il progetto se non te lo chiedono.',
    '- Se ti chiedono bug, problemi o migliorie, produci un elenco concreto: cosa non va, file:riga, perché, come si corregge. Niente panoramiche, niente tabelle riassuntive.',
    '- Parti dalla risposta: niente preamboli su cosa stai per fare o su cosa hai già fatto.',
    '- Non ripetere la risposta precedente. Se l’utente dice che non hai risposto, cambia approccio: fai una cosa diversa, non riscrivere lo stesso testo.',
    '- Non rispondere che il progetto è già stato analizzato e non rimandare la domanda: se ti serve contesto, chiama i tool adesso, in questo turno.',
    '- Se un tool restituisce dati, usali per ragionare. Non incollare l’output del tool nella risposta.',
    '',
    'Multi-agente:',
    '- Usa il tool `task` per delegare esplorazione, review o implementazioni indipendenti.',
    '- `explorer` e `reviewer` sono in sola lettura; `implementer` può scrivere.',
    '- Puoi lanciare più `task` nello stesso turno: girano in parallelo.',
    '- Non delegare lavori che richiedono il contesto di questa conversazione: il subagente non lo vede.',
    '',
    'Tool disponibili: read, ls, glob, grep, write, edit, bash, task, skill, charliecode_config (configura l’app, non il progetto), più quelli aggiunti dai plugin attivi.',
    projectContext ? `\n${projectContext}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export { toolTitle, findModel }
