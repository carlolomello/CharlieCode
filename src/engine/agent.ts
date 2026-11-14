import { streamText, stepCountIs, type ModelMessage, type ToolSet } from 'ai'
import { findModel } from './catalog'
import { providerFor, resolveCandidates } from './client'
import { buildTools, toolTitle, type ToolRuntime } from './tools'
import type { Platform } from './platform'
import type {
  CharlieCodeConfig,
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
  workspace?: string
  /** Full model context from a previous turn, when available. */
  modelMessages?: ModelMessage[]
  askPermission: (request: PermissionRequest) => Promise<PermissionDecision>
  emit: (event: EngineEvent) => void
  maxSteps?: number
  subagentMaxSteps?: number
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

  let lastError: string | undefined

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
      deps.emit(event)
    }

    const runtime: ToolRuntime = {
      platform: deps.platform,
      workspace: deps.workspace ?? process.cwd(),
      signal: request.signal,
      depth,
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.agentName ? { agentName: options.agentName } : {}),
      autoApprove: deps.config.agents.autoApprove,
      autoApproveCommands: deps.config.agents.autoApproveCommands,
      askPermission: deps.askPermission,
      emit,
      runSubagent: async (sub) => {
        const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const name = sub.description.slice(0, 60)
        const role = sub.agent ?? 'explorer'
        const subModel =
          sub.model ??
          deps.config.agents.subagentModel ??
          modelKey

        deps.emit({
          type: 'subagent-start',
          agentId,
          name,
          description: sub.prompt.slice(0, 200),
          modelKey: subModel
        })

        const allow =
          role === 'explorer'
            ? ['read', 'ls', 'glob', 'grep']
            : role === 'reviewer'
              ? ['read', 'ls', 'glob', 'grep', 'bash']
              : undefined

        const started = Date.now()
        try {
          const result = await runAgent(
            {
              modelKey: subModel,
              messages: [{ role: 'user', content: sub.prompt }],
              effort: request.effort,
              signal: request.signal
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
                deps.workspace ?? '(nessuna cartella)'
              }`
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
          system: options.system ?? request.system,
          messages: inputMessages,
          tools: toolset(runtime, options.allow),
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
        const newMessages: ModelMessage[] = steps.flatMap((step) => step.response.messages)
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
    '- Rispondi nella lingua dell’utente.',
    '',
    'Multi-agente:',
    '- Usa il tool `task` per delegare esplorazione, review o implementazioni indipendenti.',
    '- `explorer` e `reviewer` sono in sola lettura; `implementer` può scrivere.',
    '- Puoi lanciare più `task` nello stesso turno: girano in parallelo.',
    '- Non delegare lavori che richiedono il contesto di questa conversazione: il subagente non lo vede.',
    '',
    'Tool disponibili: read, ls, glob, grep, write, edit, bash, task.',
    projectContext ? `\n${projectContext}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export { toolTitle, findModel }
