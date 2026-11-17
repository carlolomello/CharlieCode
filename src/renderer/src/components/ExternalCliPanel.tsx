import { useCallback, useEffect, useState } from 'react'
import type {
  ExternalAgentsStatus,
  ExternalTestResult
} from '../../../shared/ipc'

/**
 * "Collega una CLI esistente".
 *
 * For a lot of people the approved tool is already installed and already has a
 * good model behind it — Claude Code, Cline, Gaia, OpenCode. This panel does not
 * ask for a key: it finds the binary, proves it answers, and lets the user pick
 * it as the worker for `task` subagents. Model calls then happen inside that
 * CLI, with its own auth and quota; CharlieCode only orchestrates.
 *
 * Everything here is local. A failed test is shown as a failed test, not hidden.
 */
export function ExternalCliPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<ExternalAgentsStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, ExternalTestResult>>({})
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [draft, setDraft] = useState<{ id: string; model: string; auto: boolean } | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const next = await window.charliecode.externalAgents()
      setStatus(next)
      if (next.worker) {
        setDraft({
          id: next.worker.id,
          model: next.worker.model ?? '',
          auto: next.worker.auto === true
        })
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const loadModels = async (id: string): Promise<void> => {
    if (models[id]) return
    try {
      const list = await window.charliecode.externalAgentModels(id)
      setModels((previous) => ({ ...previous, [id]: list }))
    } catch {
      setModels((previous) => ({ ...previous, [id]: [] }))
    }
  }

  const test = async (id: string): Promise<void> => {
    setTesting(id)
    setError(null)
    try {
      const result = await window.charliecode.testExternalAgent({
        id,
        ...(draft?.id === id && draft.model ? { model: draft.model } : {})
      })
      setTests((previous) => ({ ...previous, [id]: result }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTesting(null)
    }
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      const next = await window.charliecode.setExternalWorker({
        id: draft.id,
        ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
        auto: draft.auto
      })
      setStatus(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    setSaving(true)
    try {
      setStatus(await window.charliecode.setExternalWorker(null))
      setDraft(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const worker = status?.worker
  const detected = status?.detected ?? []

  return (
    <div className="cli-panel">
      <h3>Una CLI che hai già</h3>
      <p className="muted small">
        Se in azienda usi Claude Code, Cline, Gaia o OpenCode, CharlieCode può usarla come
        lavoratore: i subagenti girano lì dentro, con la sua autenticazione e la sua quota. Qui non
        si copiano chiavi e non si aggira nessun permesso — si orchestra uno strumento che è già
        approvato.
      </p>

      {worker && (
        <div className="banner ok small">
          Subagenti su{' '}
          <strong>{detected.find((agent) => agent.id === worker.id)?.label ?? worker.id}</strong>
          {worker.model ? ` · modello ${worker.model}` : ' · modello predefinito della CLI'}
          {worker.auto ? ' · scrittura automatica attiva' : ' · sola lettura per esploratori e reviewer'}
          <button className="ghost small" onClick={() => void disconnect()} disabled={saving}>
            scollega
          </button>
        </div>
      )}

      {error && <div className="message-error">{error}</div>}

      {loading && <p className="muted small">Cerco le CLI installate…</p>}

      {!loading && detected.length === 0 && (
        <div className="banner warn small">
          Nessuna CLI trovata nel PATH (cerco <code>claude</code>, <code>cline</code>,{' '}
          <code>gaia</code>, <code>opencode</code>, <code>kiro-cli</code>). Se una c&apos;è ma non
          viene vista, apri CharlieCode dal terminale in cui funziona, oppure installala e premi
          «ricontrolla».
        </div>
      )}

      {detected.map((agent) => {
        const result = tests[agent.id]
        const chosen = draft?.id === agent.id
        return (
          <div key={agent.id} className={`cli-row ${chosen ? 'on' : ''}`}>
            <div className="cli-head">
              <div>
                <div className="cli-name">
                  {agent.label}
                  {agent.version && <span className="cli-version">{agent.version}</span>}
                </div>
                <div className="cli-path">
                  <code>{agent.path}</code>
                </div>
              </div>
              <div className="cli-actions">
                <button
                  className="ghost small"
                  onClick={() => void test(agent.id)}
                  disabled={testing === agent.id}
                >
                  {testing === agent.id ? 'provo…' : 'prova'}
                </button>
                <button
                  className={`ghost small ${chosen ? 'active' : ''}`}
                  onClick={() => {
                    setDraft({ id: agent.id, model: '', auto: false })
                    void loadModels(agent.id)
                  }}
                >
                  {chosen ? 'selezionata' : 'usa per i subagenti'}
                </button>
              </div>
            </div>

            <p className="muted small cli-notes">{agent.notes}</p>

            {result && (
              <div className={`cli-test ${result.ok ? 'ok' : 'bad'}`}>
                {result.ok ? (
                  <>
                    risponde in {(result.ms / 1000).toFixed(1)}s: <code>{result.text}</code>
                  </>
                ) : (
                  <>non ha risposto: {result.error ?? 'output vuoto'}</>
                )}
              </div>
            )}

            {chosen && (
              <div className="cli-config">
                {(models[agent.id]?.length ?? 0) > 0 ? (
                  <select
                    value={draft.model}
                    onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                  >
                    <option value="">modello predefinito della CLI</option>
                    {models[agent.id]?.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    placeholder="modello (vuoto = quello che usa già la CLI)"
                    value={draft.model}
                    onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                  />
                )}

                <label className="provider-toggle small-toggle">
                  <input
                    type="checkbox"
                    checked={draft.auto}
                    onChange={(event) => setDraft({ ...draft, auto: event.target.checked })}
                  />
                  <span>
                    Lascia che la CLI scriva ed esegua senza chiedere
                    <span className="muted small">
                      {' '}
                      — solo per i subagenti «implementer». Se è spento, lavorano in sola lettura.
                    </span>
                  </span>
                </label>

                <div className="cli-save">
                  <button className="primary" onClick={() => void save()} disabled={saving}>
                    {saving ? 'salvo…' : 'Usa questa CLI'}
                  </button>
                  <button className="ghost" onClick={onClose}>
                    Chiudi
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      <div className="cli-foot">
        <button className="ghost small" onClick={() => void load()} disabled={loading}>
          ricontrolla
        </button>
        <span className="muted small">
          Il test manda una sola frase e non tocca il progetto. Nessuna CLI viene installata da
          qui.
        </span>
      </div>
    </div>
  )
}
