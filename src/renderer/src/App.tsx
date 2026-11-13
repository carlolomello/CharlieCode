import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AppInfo, ChatEventEnvelope } from '../../shared/ipc'
import type { CatalogError, EffortLevel, ModelEntry } from '../../engine/types'

interface ChatItem {
  id: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
  modelKey?: string
  meta?: string
  error?: string
}

const EFFORTS: EffortLevel[] = ['none', 'low', 'high', 'max']

function shortKey(key: string): string {
  return key.length > 42 ? `${key.slice(0, 41)}…` : key
}

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [errors, setErrors] = useState<CatalogError[]>([])
  const [loadingModels, setLoadingModels] = useState(true)
  const [modelKey, setModelKey] = useState<string>('')
  const [effort, setEffort] = useState<EffortLevel>('none')
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const refreshModels = useCallback(async (): Promise<void> => {
    setLoadingModels(true)
    try {
      const response = await window.charliecode.models()
      setModels(response.models)
      setErrors(response.errors)
      setModelKey((current) => {
        if (current && response.models.some((model) => model.key === current)) return current
        const preferred =
          response.models.find((model) => model.caps.tools) ?? response.models[0] ?? undefined
        return preferred ? preferred.key : ''
      })
      setFatal(null)
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingModels(false)
    }
  }, [])

  useEffect(() => {
    void window.charliecode.info().then(setInfo)
    void refreshModels()
  }, [refreshModels])

  useEffect(() => {
    const unsubscribe = window.charliecode.onChatEvent(({ requestId, event }: ChatEventEnvelope) => {
      setItems((previous) =>
        previous.map((item) => {
          if (item.id !== requestId) return item

          switch (event.type) {
            case 'start':
              return {
                ...item,
                modelKey: event.modelKey,
                meta: event.fallbackFrom ? `fallback da ${event.fallbackFrom}` : item.meta
              }
            case 'delta':
              return { ...item, content: item.content + event.text }
            case 'done':
              return {
                ...item,
                pending: false,
                meta: [
                  item.meta,
                  `ttft ${event.ttftMs}ms`,
                  `totale ${event.ms}ms`,
                  event.usage?.outputTokens ? `${event.usage.outputTokens} token` : undefined,
                  event.aborted ? 'interrotto' : undefined
                ]
                  .filter(Boolean)
                  .join(' · ')
              }
            case 'error':
              return { ...item, pending: false, error: event.message }
            default:
              return item
          }
        })
      )

      if (event.type === 'done' || event.type === 'error') {
        setStreamingId((current) => (current === requestId ? null : current))
      }
    })

    return unsubscribe
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [items])

  const selectedModel = useMemo(
    () => models.find((model) => model.key === modelKey),
    [models, modelKey]
  )

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim()
    if (!text || streamingId || !modelKey) return

    const requestId = crypto.randomUUID()
    const history = items
      .filter((item) => item.content.trim().length > 0 && !item.error)
      .slice(-20)
      .map((item) => ({ role: item.role, content: item.content }))

    setItems((previous) => [
      ...previous,
      { id: `${requestId}-user`, role: 'user', content: text },
      { id: requestId, role: 'assistant', content: '', pending: true }
    ])
    setInput('')
    setStreamingId(requestId)
    setFatal(null)

    try {
      const result = await window.charliecode.startChat({
        requestId,
        modelKey,
        effort,
        messages: [...history, { role: 'user', content: text }]
      })
      if (!result.ok) {
        setItems((previous) =>
          previous.map((item) =>
            item.id === requestId
              ? { ...item, pending: false, error: result.error ?? 'avvio fallito' }
              : item
          )
        )
        setStreamingId(null)
      }
    } catch (error) {
      setItems((previous) =>
        previous.map((item) =>
          item.id === requestId
            ? { ...item, pending: false, error: error instanceof Error ? error.message : String(error) }
            : item
        )
      )
      setStreamingId(null)
    }
  }, [effort, input, items, modelKey, streamingId])

  const stop = useCallback(async (): Promise<void> => {
    if (!streamingId) return
    await window.charliecode.stopChat(streamingId)
  }, [streamingId])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const setup = models.length === 0 && !loadingModels

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <div>
            <div className="brand-name">CharlieCode</div>
            <div className="brand-sub">
              phase 0 · {info?.platform ?? '…'} · engine {info?.version ?? ''}
            </div>
          </div>
        </div>

        <div className="controls">
          <select
            className="select model-select"
            value={modelKey}
            onChange={(event) => setModelKey(event.target.value)}
            disabled={models.length === 0}
            title={selectedModel ? `${selectedModel.key} · ${Math.round(selectedModel.caps.contextWindow / 1024)}k` : ''}
          >
            {models.length === 0 && <option value="">nessun modello</option>}
            {models.map((model) => (
              <option key={model.key} value={model.key}>
                {model.caps.tools ? '● ' : '○ '}
                {shortKey(model.key)}
              </option>
            ))}
          </select>

          <select
            className="select effort-select"
            value={effort}
            onChange={(event) => setEffort(event.target.value as EffortLevel)}
            title="Livello di effort (reasoning) passato al provider"
          >
            {EFFORTS.map((level) => (
              <option key={level} value={level}>
                effort: {level}
              </option>
            ))}
          </select>

          <button className="ghost" onClick={() => void refreshModels()} disabled={loadingModels}>
            {loadingModels ? '…' : '↻'}
          </button>
        </div>
      </header>

      {errors.length > 0 && (
        <div className="banner warn">
          {errors.map((error) => (
            <div key={error.providerId}>
              <strong>{error.providerLabel}</strong>: {error.message}
            </div>
          ))}
        </div>
      )}

      {fatal && <div className="banner error">{fatal}</div>}

      <main className="scroll" ref={scrollRef}>
        {setup ? (
          <section className="setup">
            <h1>Nessun modello disponibile</h1>
            <p>
              CharlieCode parla con qualsiasi endpoint OpenAI-compatible. Il default è FreeLLMAPI in
              locale: senza router e senza key non ci sono modelli.
            </p>
            <ol>
              <li>
                Avvia il router: <code>FreeLLMAPI</code> su <code>http://localhost:3001</code>
              </li>
              <li>
                Aggiungi key free nella dashboard (Google AI Studio, Groq, Cerebras, OpenRouter)
              </li>
              <li>
                Salva la unified key in <code>{info?.credentialsPath ?? '~/.charliecode/credentials.json'}</code>
                :
                <pre>{`{ "freellmapi": { "apiKey": "freellmapi-..." } }`}</pre>
              </li>
              <li>
                Riavvia o premi <strong>↻</strong> qui sopra
              </li>
            </ol>
            <div className="setup-actions">
              <button onClick={() => void window.charliecode.openConfigDir()}>Apri cartella config</button>
            </div>
            <p className="muted">
              In alternativa: <code>export FREELLMAPI_KEY=…</code> — oppure verifica da terminale con{' '}
              <code>pnpm charliecode:doctor</code>.
            </p>
          </section>
        ) : items.length === 0 ? (
          <section className="empty">
            <h1>Pronto.</h1>
            <p className="muted">
              {models.length} modelli chat · scrivi un messaggio per collaudare lo streaming.
            </p>
            <div className="hints">
              <button onClick={() => setInput('Presentati in due righe e dimmi che modello sei.')}>
                Chi sei?
              </button>
              <button onClick={() => setInput('Scrivi una funzione TypeScript che valida una email, con test.')}>
                Codice di prova
              </button>
              <button onClick={() => setInput('Rispondi con esattamente 50 parole sul perché i modelli piccoli falliscono nel tool calling.')}>
                Test lunghezza
              </button>
            </div>
          </section>
        ) : (
          <div className="messages">
            {items.map((item) => (
              <article key={item.id} className={`message ${item.role}`}>
                <div className="message-head">
                  <span className="role">{item.role === 'user' ? 'tu' : (item.modelKey ? shortKey(item.modelKey) : 'assistant')}</span>
                  {item.pending && <span className="pulse">sta scrivendo</span>}
                </div>
                <div className="message-body">{item.content || (item.pending ? '' : '—')}</div>
                {item.error && <div className="message-error">{item.error}</div>}
                {item.meta && <div className="message-meta">{item.meta}</div>}
              </article>
            ))}
          </div>
        )}
      </main>

      <footer className="composer">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            modelKey ? 'Scrivi un messaggio…  (Enter invia, Shift+Enter va a capo)' : 'Seleziona un modello…'
          }
          rows={3}
          disabled={!modelKey}
        />
        <div className="composer-actions">
          <span className="muted small">
            {selectedModel
              ? `${selectedModel.caps.tools ? 'tools' : 'no-tools'} · ${selectedModel.caps.vision ? 'vision' : 'testo'} · ${Math.round(selectedModel.caps.contextWindow / 1024)}k ctx`
              : 'nessun modello'}
          </span>
          {streamingId ? (
            <button className="danger" onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            <button className="primary" onClick={() => void send()} disabled={!input.trim() || !modelKey}>
              Invia
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}
