import { useCallback, useEffect, useState } from 'react'
import type { ProviderStatus, RoutersStatus } from '../../../shared/ipc'
import { ExternalCliPanel } from './ExternalCliPanel'

type Path = 'openrouter' | 'freellmapi' | 'local' | 'custom' | 'cli'

interface SetupWizardProps {
  providers: ProviderStatus[]
  onSetKey: (providerId: string, key: string) => Promise<void>
  onToggleProvider: (providerId: string, enabled: boolean) => Promise<void>
  onAddProvider: (payload: {
    id: string
    label: string
    baseUrl: string
    kind: 'direct' | 'router'
  }) => Promise<void>
  onClose: () => void
}

const PATHS: { id: Path; label: string; tag: string; blurb: string }[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    tag: 'gratis',
    blurb: 'Un’unica key per centinaia di modelli, molti con suffisso :free.'
  },
  {
    id: 'freellmapi',
    label: 'FreeLLMAPI',
    tag: 'locale',
    blurb: 'Router locale che aggrega i provider gratuiti dietro una sola chiave.'
  },
  {
    id: 'local',
    label: 'Ollama / container',
    tag: 'offline',
    blurb: 'Modelli sul tuo computer o in un container: nessun dato esce.'
  },
  {
    id: 'custom',
    label: 'API personalizzata',
    tag: 'pro',
    blurb: 'Qualsiasi endpoint OpenAI-compatible: LM Studio, vLLM, gateway aziendale.'
  },
  {
    id: 'cli',
    label: 'CLI esistente',
    tag: 'azienda',
    blurb: 'Claude Code, Cline, Gaia o OpenCode già installati: nessuna chiave da incollare.'
  }
]

function CopyRow({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="copy-row">
      <code>{command}</code>
      <button
        className="ghost small"
        onClick={() => {
          void navigator.clipboard.writeText(command)
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        }}
      >
        {copied ? 'copiato' : 'copia'}
      </button>
    </div>
  )
}

export function SetupWizard({
  providers,
  onSetKey,
  onToggleProvider,
  onAddProvider,
  onClose
}: SetupWizardProps): React.JSX.Element {
  const [path, setPath] = useState<Path>('openrouter')
  const [routers, setRouters] = useState<RoutersStatus | null>(null)
  const [scanning, setScanning] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [custom, setCustom] = useState({ id: '', label: '', baseUrl: '', key: '' })
  const [customError, setCustomError] = useState<string | null>(null)

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true)
    try {
      // One probe, not two: the app-level refresh happens when the wizard closes.
      setRouters(await window.charliecode.routers())
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void scan()
  }, [scan])

  const openrouter = providers.find((provider) => provider.id === 'openrouter')
  const freellmapi = providers.find((provider) => provider.id === 'freellmapi')
  const ollama = providers.find((provider) => provider.id === 'ollama')

  const saveKey = async (providerId: string, key: string): Promise<void> => {
    setSavingKey(true)
    setKeyError(null)
    try {
      await onSetKey(providerId, key)
      await onToggleProvider(providerId, true)
      setKeyDraft('')
      await scan()
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingKey(false)
    }
  }

  const addCustom = async (): Promise<void> => {
    setCustomError(null)
    try {
      await onAddProvider({
        id: custom.id,
        label: custom.label,
        baseUrl: custom.baseUrl,
        kind: 'direct'
      })
      if (custom.key.trim()) await onSetKey(custom.id.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-'), custom.key)
      setCustom({ id: '', label: '', baseUrl: '', key: '' })
      await scan()
    } catch (error) {
      setCustomError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="overlay wizard-overlay">
      <div className="wizard" role="dialog" aria-modal="true">
        <header className="wizard-head">
          <div>
            <h2>Collega un modello</h2>
            <p className="muted small">
              CharlieCode parla solo con endpoint OpenAI-compatible. Scegli come partire.
            </p>
          </div>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="wizard-body">
          <nav className="wizard-paths">
            {PATHS.map((entry) => (
              <button
                key={entry.id}
                className={`wizard-path ${path === entry.id ? 'active' : ''}`}
                onClick={() => {
                  setPath(entry.id)
                  // A key typed for OpenRouter must not follow the user into
                  // the FreeLLMAPI or custom form.
                  setKeyDraft('')
                  setKeyError(null)
                }}
              >
                <span className="wizard-path-head">
                  <span>{entry.label}</span>
                  <span className={`wizard-tag ${entry.tag}`}>{entry.tag}</span>
                </span>
                <span className="wizard-path-blurb">{entry.blurb}</span>
              </button>
            ))}
          </nav>

          <section className="wizard-panel">
            {path === 'openrouter' && (
              <>
                <h3>OpenRouter — modelli gratuiti</h3>
                <ol className="wizard-steps">
                  <li>
                    Apri{' '}
                    <button
                      className="link"
                      onClick={() => void window.charliecode.openExternal('https://openrouter.ai/keys')}
                    >
                      openrouter.ai/keys
                    </button>{' '}
                    e crea una key (bastano i crediti gratuiti).
                  </li>
                  <li>
                    In alternativa filtra i modelli con suffisso <code>:free</code> su{' '}
                    <button
                      className="link"
                      onClick={() =>
                        void window.charliecode.openExternal('https://openrouter.ai/models?max_price=0')
                      }
                    >
                      openrouter.ai/models
                    </button>
                    .
                  </li>
                  <li>Incolla la key qui sotto: il provider viene attivato subito.</li>
                </ol>
                <div className="key-row">
                  <input
                    type="password"
                    placeholder="sk-or-v1-…"
                    value={keyDraft}
                    onChange={(event) => setKeyDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && keyDraft.trim()) void saveKey('openrouter', keyDraft)
                    }}
                  />
                  <button
                    className="primary"
                    disabled={!keyDraft.trim() || savingKey}
                    onClick={() => void saveKey('openrouter', keyDraft)}
                  >
                    {savingKey ? '…' : 'Salva e attiva'}
                  </button>
                </div>
                <p className="muted small">
                  Stato: {openrouter?.hasKey ? `key salvata (${openrouter.keyHint})` : 'nessuna key'} ·{' '}
                  {openrouter?.enabled ? 'provider attivo' : 'provider spento'}
                </p>
                {keyError && <div className="inline-error">{keyError}</div>}
              </>
            )}

            {path === 'freellmapi' && (
              <>
                <h3>FreeLLMAPI — router locale</h3>
                <div className={`runtime-card ${routers?.freellmapi.running ? 'ok' : ''}`}>
                  <div>
                    <strong>{routers?.freellmapi.running ? 'In esecuzione' : 'Non in esecuzione'}</strong>
                    <span className="muted small"> · {routers?.freellmapi.hint ?? 'verifica…'}</span>
                  </div>
                  <div className="runtime-actions">
                    {!routers?.freellmapi.running && routers?.freellmapi.installed && (
                      <button
                        className="ghost small"
                        onClick={async () => {
                          await window.charliecode.launchRuntime('freellmapi')
                          setTimeout(() => void scan(), 1800)
                        }}
                      >
                        Avvia
                      </button>
                    )}
                    <button className="ghost small" onClick={() => void scan()} disabled={scanning}>
                      {scanning ? '…' : 'Riprova'}
                    </button>
                    {!routers?.freellmapi.installed && (
                      <button
                        className="ghost small"
                        onClick={() => void window.charliecode.openExternal('https://freellmapi.com')}
                      >
                        Scarica
                      </button>
                    )}
                  </div>
                </div>

                <p className="muted small">
                  FreeLLMAPI gira su <code>127.0.0.1:31415</code> (desktop) o <code>3001</code>{' '}
                  (Docker). Apri la sua dashboard, aggiungi le key dei provider gratuiti e incolla
                  qui la unified key.
                </p>
                <div className="key-row">
                  <input
                    type="password"
                    placeholder="unified key di FreeLLMAPI…"
                    value={keyDraft}
                    onChange={(event) => setKeyDraft(event.target.value)}
                  />
                  <button
                    className="primary"
                    disabled={!keyDraft.trim() || savingKey}
                    onClick={() => void saveKey('freellmapi', keyDraft)}
                  >
                    {savingKey ? '…' : 'Salva'}
                  </button>
                </div>
                <p className="muted small">
                  Stato: {freellmapi?.hasKey ? `key salvata (${freellmapi.keyHint})` : 'nessuna key'}
                </p>
                {keyError && <div className="inline-error">{keyError}</div>}
              </>
            )}

            {path === 'local' && (
              <>
                <h3>Ollama e container</h3>
                <div className="runtime-card">
                  <div>
                    <strong>Ollama</strong>
                    <span className="muted small">
                      {' '}
                      · {routers?.ollama.running ? routers.ollama.hint : 'non in ascolto su 11434'}
                    </span>
                  </div>
                  <div className="runtime-actions">
                    {!routers?.ollama.running && (
                      <button
                        className="ghost small"
                        onClick={async () => {
                          await window.charliecode.launchRuntime('ollama')
                          setTimeout(() => void scan(), 1800)
                        }}
                      >
                        Avvia
                      </button>
                    )}
                    {routers?.ollama.running && (
                      <button
                        className="ghost small"
                        onClick={() => void saveKey('ollama', 'ollama')}
                      >
                        Usa Ollama
                      </button>
                    )}
                    <button className="ghost small" onClick={() => void scan()} disabled={scanning}>
                      {scanning ? '…' : 'Riprova'}
                    </button>
                  </div>
                </div>

                {routers && routers.detected.length > 0 ? (
                  <div className="detected-list">
                    <p className="muted small">Endpoint rilevati adesso:</p>
                    {routers.detected.map((entry) => (
                      <div key={entry.id} className="detected">
                        <span className="detected-label">{entry.label}</span>
                        <code>{entry.baseUrl}</code>
                        <span className="muted small">{entry.models ?? '?'} modelli</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted small">
                    Nessun endpoint locale rilevato. Avvia un runtime qui sotto.
                  </p>
                )}

                <h4>Comandi rapidi</h4>
                <CopyRow command="brew install ollama && ollama serve && ollama pull qwen3:8b" />
                <CopyRow command="docker run -d --name ollama -p 11434:11434 -v ollama:/root/.ollama ollama/ollama" />
                <CopyRow command="docker run --gpus all -p 8000:8000 vllm/vllm-openai:latest --model Qwen/Qwen3-8B" />
                <p className="muted small">
                  Docker: {routers?.docker ? 'rilevato' : 'non rilevato'}. Dopo l’avvio, aggiungi
                  l’endpoint come provider personalizzato (es. <code>http://localhost:11434/v1</code>).
                </p>
              </>
            )}

            {path === 'custom' && (
              <>
                <h3>API personalizzata</h3>
                <p className="muted small">
                  Base URL completa di <code>/v1</code>. La key è opzionale per i runtime locali.
                </p>
                <div className="custom-grid">
                  <input
                    placeholder="id (es. lmstudio)"
                    value={custom.id}
                    onChange={(event) => setCustom({ ...custom, id: event.target.value })}
                  />
                  <input
                    placeholder="nome (es. LM Studio)"
                    value={custom.label}
                    onChange={(event) => setCustom({ ...custom, label: event.target.value })}
                  />
                  <input
                    placeholder="http://localhost:1234/v1"
                    value={custom.baseUrl}
                    onChange={(event) => setCustom({ ...custom, baseUrl: event.target.value })}
                  />
                  <input
                    type="password"
                    placeholder="API key (opzionale)"
                    value={custom.key}
                    onChange={(event) => setCustom({ ...custom, key: event.target.value })}
                  />
                </div>
                {customError && <div className="inline-error">{customError}</div>}
                <button
                  className="primary"
                  disabled={!custom.id.trim() || !custom.baseUrl.trim()}
                  onClick={() => void addCustom()}
                >
                  Aggiungi provider
                </button>
              </>
            )}
            {path === 'cli' && <ExternalCliPanel onClose={onClose} />}
          </section>
        </div>

        <footer className="wizard-foot">
          <span className="muted small">
            {ollama?.enabled ? 'Ollama attivo · ' : ''}
            {freellmapi?.enabled ? 'FreeLLMAPI attivo · ' : ''}
            {openrouter?.enabled ? 'OpenRouter attivo' : ''}
          </span>
          <button className="ghost" onClick={onClose}>
            Chiudi
          </button>
        </footer>
      </div>
    </div>
  )
}
