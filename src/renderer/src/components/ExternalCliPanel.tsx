import { useCallback, useEffect, useRef, useState } from 'react'
import type { CliProfile, CliOutputFormat } from '../../../engine/types'
import type {
  CliCommandMatch,
  CliConnectReport,
  CliIntrospection,
  CliProfilesStatus,
  CliTestResult
} from '../../../shared/ipc'

/**
 * "CLI esterne".
 *
 * CharlieCode ships no presets and knows no product names: a CLI is a command
 * with arguments and a description of how it prints a turn. The user defines
 * one profile per tool, tests it, and can point `task` subagents at it. Model
 * calls then happen inside that CLI, with its own authentication and quota.
 *
 * Nothing here installs software or copies keys. A failed test is shown as a
 * failed test, with the exact command that was run.
 */

interface Draft {
  /** Present when editing an existing profile. */
  id?: string
  label: string
  command: string
  argsText: string
  promptMode: 'arg' | 'stdin'
  output: CliOutputFormat
  modelArgsText: string
  effortArgsText: string
  effortValuesText: string
  planArgsText: string
  autoArgsText: string
  modelsArgsText: string
  modelsFormat: 'lines' | 'json'
  textPath: string
  activityPath: string
  thinkingPath: string
  modelsPath: string
  notes: string
  timeoutSeconds: string
  maxWorkers: string
}

const EMPTY_DRAFT: Draft = {
  label: '',
  command: '',
  argsText: '',
  promptMode: 'arg',
  output: 'auto',
  modelArgsText: '',
  effortArgsText: '',
  effortValuesText: '',
  planArgsText: '',
  autoArgsText: '',
  modelsArgsText: '',
  modelsFormat: 'lines',
  textPath: '',
  activityPath: '',
  thinkingPath: '',
  modelsPath: '',
  notes: '',
  timeoutSeconds: '',
  maxWorkers: ''
}

const OUTPUT_LABELS: Record<CliOutputFormat, string> = {
  auto: 'automatico (righe di testo o JSON)',
  text: 'testo semplice',
  'json-lines': 'una riga JSON per evento',
  'run-result': 'JSON con riga finale run_result/result',
  'stream-json': 'stream JSON (messaggi e tool)'
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function joinLines(values?: string[]): string {
  return (values ?? []).join('\n')
}

function draftFromProfile(profile: CliProfile): Draft {
  return {
    id: profile.id,
    label: profile.label,
    command: profile.command,
    argsText: joinLines(profile.args),
    promptMode: profile.promptMode ?? 'arg',
    output: profile.output ?? 'auto',
    modelArgsText: joinLines(profile.modelArgs),
    effortArgsText: joinLines(profile.effortArgs),
    effortValuesText: (profile.effortValues ?? []).join(', '),
    planArgsText: joinLines(profile.planArgs),
    autoArgsText: joinLines(profile.autoArgs),
    modelsArgsText: joinLines(profile.modelsArgs),
    modelsFormat: profile.modelsFormat ?? 'lines',
    textPath: profile.textPath ?? '',
    activityPath: profile.activityPath ?? '',
    thinkingPath: profile.thinkingPath ?? '',
    modelsPath: profile.modelsPath ?? '',
    notes: profile.notes ?? '',
    timeoutSeconds: profile.timeoutSeconds ? String(profile.timeoutSeconds) : '',
    maxWorkers: profile.maxWorkers ? String(profile.maxWorkers) : ''
  }
}

function profileFromDraft(draft: Draft): Record<string, unknown> {
  const timeout = Number(draft.timeoutSeconds)
  const workers = Number(draft.maxWorkers)
  return {
    ...(draft.id ? { id: draft.id } : {}),
    label: draft.label.trim(),
    command: draft.command.trim(),
    args: splitLines(draft.argsText),
    promptMode: draft.promptMode,
    output: draft.output,
    ...(splitLines(draft.modelArgsText).length ? { modelArgs: splitLines(draft.modelArgsText) } : {}),
    ...(splitLines(draft.effortArgsText).length
      ? { effortArgs: splitLines(draft.effortArgsText) }
      : {}),
    ...(draft.effortValuesText
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean).length
      ? {
          effortValues: draft.effortValuesText
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        }
      : {}),
    ...(splitLines(draft.planArgsText).length ? { planArgs: splitLines(draft.planArgsText) } : {}),
    ...(splitLines(draft.autoArgsText).length ? { autoArgs: splitLines(draft.autoArgsText) } : {}),
    ...(splitLines(draft.modelsArgsText).length
      ? { modelsArgs: splitLines(draft.modelsArgsText) }
      : {}),
    ...(splitLines(draft.modelsArgsText).length ? { modelsFormat: draft.modelsFormat } : {}),
    ...(draft.textPath.trim() ? { textPath: draft.textPath.trim() } : {}),
    ...(draft.activityPath.trim() ? { activityPath: draft.activityPath.trim() } : {}),
    ...(draft.thinkingPath.trim() ? { thinkingPath: draft.thinkingPath.trim() } : {}),
    ...(draft.modelsPath.trim() ? { modelsPath: draft.modelsPath.trim() } : {}),
    ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutSeconds: timeout } : {}),
    ...(Number.isFinite(workers) && workers > 0 ? { maxWorkers: workers } : {})
  }
}

export function ExternalCliPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<CliProfilesStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, CliTestResult>>({})
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [workerModel, setWorkerModel] = useState('')
  const [workerAuto, setWorkerAuto] = useState(false)
  const [workerBusy, setWorkerBusy] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchResults, setSearchResults] = useState<CliCommandMatch[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [commandProbe, setCommandProbe] = useState<{
    state: 'idle' | 'searching' | 'exact' | 'similar' | 'missing'
    matches: CliCommandMatch[]
  }>({ state: 'idle', matches: [] })
  const [analyzing, setAnalyzing] = useState(false)
  const [analysis, setAnalysis] = useState<CliIntrospection | null>(null)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [connectCommand, setConnectCommand] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectReport, setConnectReport] = useState<CliConnectReport | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const next = await window.charliecode.cliProfiles()
      setStatus(next)
      setWorkerModel(next.worker?.model ?? '')
      setWorkerAuto(next.worker?.auto === true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const loadModels = async (id: string, force = false): Promise<void> => {
    if (models[id] && !force) return
    try {
      const list = await window.charliecode.cliProfileModels(id)
      setModels((previous) => ({ ...previous, [id]: list }))
    } catch {
      setModels((previous) => ({ ...previous, [id]: [] }))
    }
  }

  // The worker's model list is useful immediately, not only after a click.
  useEffect(() => {
    const id = status?.worker?.id
    if (id) void loadModels(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.worker?.id])

  // Search-as-you-type in the dedicated box: one command name, many installs.
  useEffect(() => {
    const query = search.trim()
    if (query.length < 2) {
      setSearchResults([])
      setSearchError(null)
      setSearchBusy(false)
      return
    }

    let cancelled = false
    setSearchBusy(true)
    setSearchError(null)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const matches = await window.charliecode.searchCliCommands(query)
          if (cancelled) return
          setSearchResults(matches)
          setSearchError(matches.length === 0 ? `Nessun comando trovato per “${query}”.` : null)
        } catch (cause) {
          if (!cancelled) {
            setSearchResults([])
            setSearchError(cause instanceof Error ? cause.message : String(cause))
          }
        } finally {
          if (!cancelled) setSearchBusy(false)
        }
      })()
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [search])

  // The command field itself resolves what the user is typing, so a typo or a
  // CLI that is not installed is visible before saving the profile.
  useEffect(() => {
    const command = draft?.command.trim() ?? ''
    if (!draft || command.length < 2) {
      setCommandProbe({ state: 'idle', matches: [] })
      return
    }

    let cancelled = false
    setCommandProbe({ state: 'searching', matches: [] })
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const matches = await window.charliecode.searchCliCommands(command)
          if (cancelled) return
          const lower = command.toLowerCase()
          const exact = matches.find(
            (match) => match.name.toLowerCase() === lower || match.path === command
          )
          if (exact) {
            setCommandProbe({
              state: 'exact',
              matches: [exact, ...matches.filter((match) => match.path !== exact.path)]
            })
          } else {
            setCommandProbe({ state: matches.length > 0 ? 'similar' : 'missing', matches })
          }
        } catch {
          if (!cancelled) setCommandProbe({ state: 'idle', matches: [] })
        }
      })()
    }, 350)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [draft?.command])

  const applyMatch = (match: CliCommandMatch): void => {
    setDraft((previous) => {
      const base = previous ?? { ...EMPTY_DRAFT }
      return {
        ...base,
        // The absolute path keeps working even when the app was launched with
        // a different PATH than the user's shell.
        command: match.path,
        label: base.label.trim() ? base.label : match.name
      }
    })
    setSearch('')
    setSearchResults([])
    setSearchError(null)
  }

  // Opening another profile must not show the previous profile's help analysis.
  const openDraft = (next: Draft | null): void => {
    setAnalysis(null)
    setAnalysisError(null)
    setDraft(next)
  }

  // Reads the CLI's own help and fills the fields it can prove. The proposal
  // is never saved here: the user checks the argv preview and presses Salva.
  const analyze = async (): Promise<void> => {
    if (!draft) return
    const command = draft.command.trim()
    if (!command) {
      setAnalysisError('Scrivi prima il comando della CLI.')
      return
    }

    setAnalyzing(true)
    setAnalysis(null)
    setAnalysisError(null)
    try {
      const result = await window.charliecode.introspectCli(
        command,
        splitLines(draft.argsText)
      )
      setAnalysis(result)
      const proposal = result.proposal
      setDraft((previous) => {
        if (!previous) return previous
        return {
          ...previous,
          ...(proposal.args ? { argsText: joinLines(proposal.args) } : {}),
          ...(proposal.promptMode ? { promptMode: proposal.promptMode } : {}),
          ...(proposal.output ? { output: proposal.output } : {}),
          ...(proposal.modelArgs ? { modelArgsText: joinLines(proposal.modelArgs) } : {}),
          ...(proposal.effortArgs ? { effortArgsText: joinLines(proposal.effortArgs) } : {}),
          ...(proposal.effortValues
            ? { effortValuesText: proposal.effortValues.join(', ') }
            : {}),
          ...(proposal.planArgs ? { planArgsText: joinLines(proposal.planArgs) } : {}),
          ...(proposal.autoArgs ? { autoArgsText: joinLines(proposal.autoArgs) } : {}),
          ...(proposal.modelsArgs ? { modelsArgsText: joinLines(proposal.modelsArgs) } : {}),
          ...(proposal.modelsFormat ? { modelsFormat: proposal.modelsFormat } : {})
        }
      })
    } catch (cause) {
      setAnalysisError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAnalyzing(false)
    }
  }

  /**
   * The one-step path: a command in, a working profile out. The engine reads
   * `--help`, finds the model list and saves the profile, so the user never
   * has to know a flag to get their CLI's models into the picker.
   */
  const connect = async (): Promise<void> => {
    const command = connectCommand.trim()
    if (!command) return

    setConnecting(true)
    setConnectError(null)
    setConnectReport(null)
    try {
      const report = await window.charliecode.connectCli({ command })
      setStatus(report.status)
      setModels((previous) => ({ ...previous, [report.profile.id]: report.models }))
      setConnectReport(report)
      setConnectCommand('')
      setAnalysis(null)
      setAnalysisError(null)
    } catch (cause) {
      setConnectError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setConnecting(false)
    }
  }

  const test = async (id: string, model?: string): Promise<void> => {
    setTesting(id)
    setError(null)
    try {
      const result = await window.charliecode.testCliProfile({
        id,
        ...(model ? { model } : {})
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
    setPreview(null)
    try {
      const next = await window.charliecode.saveCliProfile(profileFromDraft(draft))
      setStatus(next)
      openDraft(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (profile: CliProfile): Promise<void> => {
    if (!window.confirm(`Eliminare il profilo "${profile.label}"?`)) return
    setError(null)
    try {
      setStatus(await window.charliecode.deleteCliProfile(profile.id))
      if (draft?.id === profile.id) openDraft(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const runPreview = async (): Promise<void> => {
    if (!draft) return
    setPreviewError(null)
    setPreview(null)
    try {
      const result = await window.charliecode.previewCliProfile({
        profile: profileFromDraft(draft),
        ...(workerModel.trim() ? { model: workerModel.trim() } : {})
      })
      setPreview(result.display)
    } catch (cause) {
      setPreviewError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const useAsWorker = async (profile: CliProfile, model = workerModel): Promise<void> => {
    setWorkerBusy(true)
    setError(null)
    try {
      setStatus(
        await window.charliecode.setCliWorker({
          id: profile.id,
          ...(model.trim() ? { model: model.trim() } : {}),
          auto: workerAuto
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWorkerBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    setWorkerBusy(true)
    setError(null)
    try {
      setStatus(await window.charliecode.setCliWorker(null))
      setWorkerModel('')
      setWorkerAuto(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWorkerBusy(false)
    }
  }

  const exportProfile = (profile: CliProfile): void => {
    const blob = new Blob([`${JSON.stringify(profile, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${profile.id}.json`
    anchor.click()
    // Revoking synchronously can cancel the download in some Chromium builds.
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  const importFile = async (file: File): Promise<void> => {
    setError(null)
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Il file non contiene un oggetto JSON.')
      }
      openDraft(draftFromProfile(parsed as CliProfile))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const worker = status?.worker
  const profiles = status?.profiles ?? []
  const workerLabel = profiles.find((entry) => entry.profile.id === worker?.id)?.profile.label
  const workerChoices = models[worker?.id ?? ''] ?? []

  return (
    <div className="cli-panel">
      <h3>CLI esterne</h3>
      <p className="muted small">
        CharlieCode non conosce marche: una CLI è un comando con i suoi argomenti. Scrivi il comando
        con cui la avvii e il profilo si compila da solo; i suoi modelli entrano nel selettore. Le
        chiamate restano dentro la CLI, con la sua autenticazione e la sua quota: qui non si copiano
        chiavi.
      </p>

      <div className="cli-connect">
        <h4>Collega una CLI</h4>
        <p className="muted small">
          Il comando che digiti nel terminale, non una marca: <code>opencode</code>,{' '}
          <code>axet-code</code>, il tuo script. Leggo <code>--help</code>, trovo il comando che
          elenca i modelli e salvo il profilo.
        </p>
        <form
          className="cli-connect-row"
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
        >
          <input
            value={connectCommand}
            placeholder="comando, es. opencode"
            spellCheck={false}
            disabled={connecting}
            onChange={(event) => setConnectCommand(event.target.value)}
          />
          <button
            className="primary"
            type="submit"
            disabled={connecting || !connectCommand.trim()}
          >
            {connecting ? 'collego…' : 'Collega'}
          </button>
        </form>

        {connecting && (
          <p className="muted small">Risolvo il comando, leggo l’aiuto e cerco i modelli…</p>
        )}
        {connectError && <div className="message-error">{connectError}</div>}

        {connectReport && (
          <div className="cli-connect-result">
            <p className="small">
              <strong>
                {connectReport.existing ? 'Ricollegata' : 'Collegata'}:{' '}
                {connectReport.profile.label}
              </strong>
              {connectReport.version ? ` · ${connectReport.version}` : ''}
              {connectReport.models.length > 0
                ? ` · ${connectReport.models.length} modelli`
                : ' · nessun elenco modelli'}
            </p>
            <code className="cli-connect-path">{connectReport.path}</code>
            {connectReport.modelsCommand && (
              <p className="muted small">
                Modelli: <code>{connectReport.modelsCommand}</code>
              </p>
            )}
            {connectReport.models.length > 0 && (
              <div className="cli-model-chips">
                {connectReport.models.slice(0, 24).map((model) => (
                  <span key={model} className="cli-model-chip">
                    {model}
                  </span>
                ))}
                {connectReport.models.length > 24 && (
                  <span className="muted small">+{connectReport.models.length - 24}</span>
                )}
              </div>
            )}
            <p className="muted small">
              È nel selettore della barra in alto, sotto «CLI esterne»: scegli il profilo e poi il
              modello. I subagenti <code>task</code> possono usarlo con un click.
            </p>
            {connectReport.warnings.length > 0 && (
              <ul className="cli-warnings muted small">
                {connectReport.warnings.slice(0, 4).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            <div className="cli-connect-actions">
              <button
                className="ghost small"
                onClick={() => void useAsWorker(connectReport.profile, '')}
                disabled={workerBusy}
              >
                usa per i subagenti
              </button>
              <button
                className="ghost small"
                onClick={() => openDraft(draftFromProfile(connectReport.profile))}
              >
                modifica profilo
              </button>
              <button className="ghost small" onClick={() => setConnectReport(null)}>
                chiudi
              </button>
            </div>
          </div>
        )}
      </div>

      {worker && (
        <div className="banner ok small cli-worker">
          <div>
            Subagenti su <strong>{workerLabel ?? worker.id}</strong>
            {worker.model ? ` · modello ${worker.model}` : ' · modello predefinito della CLI'}
            {worker.auto
              ? ' · scrittura automatica per gli implementer'
              : ' · sola lettura per esploratori e reviewer'}
          </div>
          <div className="cli-worker-controls">
            {workerChoices.length > 0 ? (
              <select value={workerModel} onChange={(event) => setWorkerModel(event.target.value)}>
                <option value="">modello predefinito della CLI</option>
                {workerChoices.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : (
              <input
                placeholder="modello (vuoto = quello della CLI)"
                value={workerModel}
                onChange={(event) => setWorkerModel(event.target.value)}
              />
            )}
            <label className="provider-toggle small-toggle">
              <input
                type="checkbox"
                checked={workerAuto}
                onChange={(event) => setWorkerAuto(event.target.checked)}
              />
              <span>scrittura automatica</span>
            </label>
            <button
              className="ghost small"
              disabled={workerBusy}
              onClick={() => {
                const entry = profiles.find((item) => item.profile.id === worker.id)
                if (entry) void useAsWorker(entry.profile)
              }}
            >
              aggiorna
            </button>
            <button className="ghost small" onClick={() => void disconnect()} disabled={workerBusy}>
              scollega
            </button>
          </div>
        </div>
      )}

      {error && <div className="message-error">{error}</div>}

      {status && status.errors.length > 0 && (
        <div className="banner warn small">
          <strong>File di profilo non validi</strong>
          <ul className="cli-errors">
            {status.errors.map((entry) => (
              <li key={entry.file}>
                <code>{entry.file}</code>: {entry.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="cli-toolbar">
        <button className="primary small" onClick={() => openDraft({ ...EMPTY_DRAFT })}>
          + Nuovo profilo
        </button>
        <button className="ghost small" onClick={() => fileInput.current?.click()}>
          Importa JSON
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void importFile(file)
            event.target.value = ''
          }}
        />
        <button className="ghost small" onClick={() => void load()} disabled={loading}>
          ricarica
        </button>
      </div>

      <div className="cli-search">
        <label className="cli-search-box">
          <span className="muted small">Cerca una CLI già installata</span>
          <input
            value={search}
            placeholder="scrivi il nome del comando, es. il tuo agente"
            spellCheck={false}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {searchBusy && <span className="muted small">cerco nel PATH…</span>}
        {searchError && <span className="muted small">{searchError}</span>}
        {searchResults.length > 0 && (
          <div className="cli-search-results">
            {searchResults.map((match) => (
              <button
                key={match.path}
                type="button"
                className="cli-search-hit"
                onClick={() => applyMatch(match)}
              >
                <span className="cli-search-name">
                  {match.name}
                  {match.version && <span className="cli-version">{match.version}</span>}
                </span>
                <code>{match.path}</code>
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && <p className="muted small">Leggo i profili…</p>}

      {!loading && profiles.length === 0 && (
        <div className="banner warn small">
          Nessun profilo. Creane uno con il comando della CLI che usi già: CharlieCode non ne
          installa e non ne presume nessuna.
        </div>
      )}

      {profiles.map(({ profile, path, available }) => {
        const result = tests[profile.id]
        const isWorker = worker?.id === profile.id
        return (
          <div key={profile.id} className={`cli-row ${isWorker ? 'on' : ''}`}>
            <div className="cli-head">
              <div>
                <div className="cli-name">
                  {profile.label}
                  {isWorker && <span className="cli-version">worker</span>}
                </div>
                <div className="cli-path">
                  {available ? (
                    <code>{path}</code>
                  ) : (
                    <span className="muted small">
                      comando non trovato: <code>{profile.command}</code>
                    </span>
                  )}
                </div>
              </div>
              <div className="cli-actions">
                <button
                  className="ghost small"
                  onClick={() => void test(profile.id, isWorker ? workerModel : undefined)}
                  disabled={testing === profile.id}
                >
                  {testing === profile.id ? 'provo…' : 'prova'}
                </button>
                <button
                  className="ghost small"
                  onClick={() => {
                    openDraft(draftFromProfile(profile))
                    setPreview(null)
                    setPreviewError(null)
                  }}
                >
                  modifica
                </button>
                <button className="ghost small" onClick={() => exportProfile(profile)}>
                  esporta
                </button>
                <button className="ghost small" onClick={() => void remove(profile)}>
                  elimina
                </button>
                <button
                  className={`ghost small ${isWorker ? 'active' : ''}`}
                  onClick={() => {
                    void loadModels(profile.id)
                    // A model chosen for another CLI must not leak into this one.
                    setWorkerModel('')
                    void useAsWorker(profile, '')
                  }}
                  disabled={workerBusy || !available}
                >
                  {isWorker ? 'in uso' : 'usa per i subagenti'}
                </button>
              </div>
            </div>

            {profile.notes && <p className="muted small cli-notes">{profile.notes}</p>}

            <div className="cli-summary muted small">
              <code>{profile.command}</code>
              {profile.args.length > 0 && <> {profile.args.join(' ')}</>}
              {' · '}
              output {OUTPUT_LABELS[profile.output ?? 'auto']}
              {profile.promptMode === 'stdin' ? ' · prompt su stdin' : ''}
            </div>

            {result && (
              <div className={`cli-test ${result.ok ? 'ok' : 'bad'}`}>
                {result.ok ? (
                  <>
                    risponde in {(result.ms / 1000).toFixed(1)}s: <code>{result.text}</code>
                  </>
                ) : (
                  <>non ha risposto: {result.error ?? 'output vuoto'}</>
                )}
                {result.command && (
                  <div className="muted small">
                    comando: <code>{result.command}</code>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      {draft && (
        <div className="cli-editor">
          <h4>{draft.id ? `Modifica ${draft.label || draft.id}` : 'Nuovo profilo CLI'}</h4>

          <label className="cli-field">
            <span>Nome</span>
            <input
              value={draft.label}
              placeholder="es. CLI aziendale"
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </label>

          <label className="cli-field">
            <span>Comando</span>
            <input
              value={draft.command}
              placeholder="nome nel PATH oppure percorso assoluto"
              onChange={(event) => setDraft({ ...draft, command: event.target.value })}
            />
          </label>

          {commandProbe.state === 'searching' && (
            <p className="cli-hint muted small">cerco nel PATH…</p>
          )}
          {commandProbe.state === 'exact' && (
            <p className="cli-hint ok small">
              trovato: <code>{commandProbe.matches[0]?.path}</code>
              {commandProbe.matches[0] && commandProbe.matches[0].path !== draft.command && (
                <button
                  type="button"
                  className="ghost small"
                  onClick={() =>
                    setDraft({ ...draft, command: commandProbe.matches[0]!.path })
                  }
                >
                  usa il percorso assoluto
                </button>
              )}
              {commandProbe.matches.length > 1 && (
                <span className="cli-hint-more">
                  {' '}
                  altre installazioni:{' '}
                  {commandProbe.matches.slice(1, 4).map((match) => (
                    <button
                      key={match.path}
                      type="button"
                      className="ghost small"
                      onClick={() => setDraft({ ...draft, command: match.path })}
                    >
                      {match.path}
                    </button>
                  ))}
                </span>
              )}
            </p>
          )}
          {commandProbe.state === 'similar' && (
            <p className="cli-hint warn small">
              Nessuna corrispondenza esatta. Forse cercavi:{' '}
              {commandProbe.matches.slice(0, 5).map((match) => (
                <button
                  key={match.path}
                  type="button"
                  className="ghost small"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      command: match.path,
                      label: draft.label.trim() ? draft.label : match.name
                    })
                  }
                >
                  {match.name}
                </button>
              ))}
            </p>
          )}
          {commandProbe.state === 'missing' && (
            <p className="cli-hint bad small">
              Non trovato nel PATH. Indica un percorso assoluto oppure installa la CLI e riprova.
            </p>
          )}

          <div className="cli-command-actions">
            <button
              type="button"
              className="ghost small"
              onClick={() => void analyze()}
              disabled={analyzing || !draft.command.trim()}
            >
              {analyzing ? 'Leggo --help…' : 'Analizza --help'}
            </button>
            <span className="muted small">
              legge l’aiuto della CLI e propone i flag che riconosce; niente viene salvato
            </span>
          </div>

          {analysisError && <p className="cli-hint bad small">{analysisError}</p>}

          {analysis && (
            <div className="cli-analysis">
              <p className="small">
                {analysis.path ? (
                  <>
                    Trovata: <code>{analysis.path}</code>
                  </>
                ) : (
                  'Comando non trovato'
                )}
                {analysis.version ? ` · ${analysis.version}` : ''}
                {analysis.helpRead ? ' · aiuto letto' : ' · aiuto non disponibile'}
              </p>
              {analysis.findings.length > 0 && (
                <ul className="cli-findings">
                  {analysis.findings.map((finding) => (
                    <li key={`${finding.field}-${finding.evidence}`}>
                      <span>{finding.label}</span>
                      <code>{finding.evidence}</code>
                    </li>
                  ))}
                </ul>
              )}
              {analysis.warnings.map((warning) => (
                <p className="cli-hint warn small" key={warning}>
                  {warning}
                </p>
              ))}
              {analysis.helpExcerpt && (
                <details className="cli-help">
                  <summary className="muted small">Aiuto letto</summary>
                  <pre>{analysis.helpExcerpt}</pre>
                </details>
              )}
              {analysis.findings.length > 0 && (
                <p className="muted small">
                  Controlla l’anteprima e prova il profilo: ogni proposta resta modificabile.
                </p>
              )}
            </div>
          )}

          <label className="cli-field">
            <span>
              Argomenti <span className="muted small">— uno per riga</span>
            </span>
            <textarea
              rows={4}
              value={draft.argsText}
              placeholder={'run\n--format\njson'}
              onChange={(event) => setDraft({ ...draft, argsText: event.target.value })}
            />
          </label>

          <p className="muted small">
            Segnaposto: <code>{'{prompt}'}</code>, <code>{'{workspace}'}</code>,{' '}
            <code>{'{model}'}</code>, <code>{'{effort}'}</code>. Senza <code>{'{prompt}'}</code> il
            prompt viene aggiunto come ultimo argomento. L’effort può stare anche nel modello, come{' '}
            <code>{'--model {model}#{effort}'}</code>: con «nessuno» resta solo il modello.
          </p>

          <div className="cli-grid">
            <label className="cli-field">
              <span>Prompt</span>
              <select
                value={draft.promptMode}
                onChange={(event) =>
                  setDraft({ ...draft, promptMode: event.target.value as Draft['promptMode'] })
                }
              >
                <option value="arg">come argomento</option>
                <option value="stdin">su stdin</option>
              </select>
            </label>

            <label className="cli-field">
              <span>Output</span>
              <select
                value={draft.output}
                onChange={(event) =>
                  setDraft({ ...draft, output: event.target.value as CliOutputFormat })
                }
              >
                {Object.entries(OUTPUT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <details className="cli-advanced">
            <summary>Argomenti facoltativi</summary>

            <label className="cli-field">
              <span>
                Modello <span className="muted small">— aggiunti solo se scegli un modello</span>
              </span>
              <textarea
                rows={2}
                value={draft.modelArgsText}
                placeholder={'-m\n{model}'}
                onChange={(event) => setDraft({ ...draft, modelArgsText: event.target.value })}
              />
            </label>

            <div className="cli-grid">
              <label className="cli-field">
                <span>
                  Effort{' '}
                  <span className="muted small">— aggiunti solo se scegli un livello</span>
                </span>
                <textarea
                  rows={2}
                  value={draft.effortArgsText}
                  placeholder={'--effort\n{effort}'}
                  onChange={(event) => setDraft({ ...draft, effortArgsText: event.target.value })}
                />
              </label>

              <label className="cli-field">
                <span>
                  Valori effort{' '}
                  <span className="muted small">— dal più basso, separati da virgola</span>
                </span>
                <input
                  value={draft.effortValuesText}
                  placeholder="low, medium, high"
                  onChange={(event) =>
                    setDraft({ ...draft, effortValuesText: event.target.value })
                  }
                />
              </label>
            </div>

            <label className="cli-field">
              <span>
                Sola lettura <span className="muted small">— per esploratori e reviewer</span>
              </span>
              <textarea
                rows={2}
                value={draft.planArgsText}
                placeholder={'--plan'}
                onChange={(event) => setDraft({ ...draft, planArgsText: event.target.value })}
              />
            </label>

            <label className="cli-field">
              <span>
                Scrittura automatica{' '}
                <span className="muted small">— solo se l’utente la abilita</span>
              </span>
              <textarea
                rows={2}
                value={draft.autoArgsText}
                placeholder={'--yes'}
                onChange={(event) => setDraft({ ...draft, autoArgsText: event.target.value })}
              />
            </label>

            <div className="cli-grid">
              <label className="cli-field">
                <span>Comando per elencare i modelli</span>
                <textarea
                  rows={2}
                  value={draft.modelsArgsText}
                  placeholder={'models'}
                  onChange={(event) => setDraft({ ...draft, modelsArgsText: event.target.value })}
                />
              </label>
              <label className="cli-field">
                <span>Formato dei modelli</span>
                <select
                  value={draft.modelsFormat}
                  onChange={(event) =>
                    setDraft({ ...draft, modelsFormat: event.target.value as Draft['modelsFormat'] })
                  }
                >
                  <option value="lines">una riga per modello</option>
                  <option value="json">JSON</option>
                </select>
              </label>
            </div>

            <div className="cli-grid">
              <label className="cli-field">
                <span>
                  Percorso del testo <span className="muted small">— es. message.content</span>
                </span>
                <input
                  value={draft.textPath}
                  onChange={(event) => setDraft({ ...draft, textPath: event.target.value })}
                />
              </label>
              <label className="cli-field">
                <span>Percorso dell’attività</span>
                <input
                  value={draft.activityPath}
                  onChange={(event) => setDraft({ ...draft, activityPath: event.target.value })}
                />
              </label>
              <label className="cli-field">
                <span>
                  Percorso del ragionamento{' '}
                  <span className="muted small">— vuoto: lo riconosce da solo</span>
                </span>
                <input
                  value={draft.thinkingPath}
                  onChange={(event) => setDraft({ ...draft, thinkingPath: event.target.value })}
                />
              </label>
              <label className="cli-field">
                <span>Percorso dei modelli</span>
                <input
                  value={draft.modelsPath}
                  onChange={(event) => setDraft({ ...draft, modelsPath: event.target.value })}
                />
              </label>
              <label className="cli-field">
                <span>Timeout (secondi)</span>
                <input
                  value={draft.timeoutSeconds}
                  inputMode="numeric"
                  placeholder="600"
                  onChange={(event) => setDraft({ ...draft, timeoutSeconds: event.target.value })}
                />
              </label>
              <label className="cli-field">
                <span>Worker in parallelo (2-6)</span>
                <input
                  value={draft.maxWorkers}
                  inputMode="numeric"
                  placeholder="3"
                  onChange={(event) => setDraft({ ...draft, maxWorkers: event.target.value })}
                />
              </label>
            </div>

            <label className="cli-field">
              <span>Note</span>
              <textarea
                rows={2}
                value={draft.notes}
                placeholder="Come si autentica, cosa sa fare, cosa evitare."
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
              />
            </label>
          </details>

          {preview && (
            <div className="cli-preview">
              <div className="muted small">Comando che verrà eseguito:</div>
              <code>{preview}</code>
            </div>
          )}
          {previewError && <div className="message-error">{previewError}</div>}

          <div className="cli-save">
            <button className="primary" onClick={() => void save()} disabled={saving}>
              {saving ? 'salvo…' : 'Salva profilo'}
            </button>
            <button className="ghost" onClick={() => void runPreview()}>
              Anteprima comando
            </button>
            <button className="ghost" onClick={() => openDraft(null)}>
              Annulla
            </button>
          </div>
        </div>
      )}

      <div className="cli-foot">
        <button className="ghost small" onClick={onClose}>
          Chiudi
        </button>
        <span className="muted small">
          Il test esegue una sola frase in una cartella temporanea e non tocca il progetto.
        </span>
      </div>
    </div>
  )
}
