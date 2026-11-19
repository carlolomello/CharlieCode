import { useCallback, useEffect, useState } from 'react'
import type { FileDiff } from '../../../engine/types'
import type { WorkspaceChange, WorkspaceChanges } from '../../../shared/ipc'
import { DiffView } from './DiffView'

/**
 * "Modifiche": every uncommitted change in the project, read from git.
 *
 * The agent describes what it did; this panel shows what actually happened. Each
 * file can be opened in the editor, expanded to its diff, or reverted — one file
 * at a time, never a blanket "undo everything".
 *
 * The preview card at the bottom is deliberately dumb: it opens the URL the
 * project serves. Starting a dev server is the user's call, with the command
 * already written out.
 */

interface ChangesPanelProps {
  workspace: string
  onClose: () => void
}

const STATUS_LABEL: Record<WorkspaceChange['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U'
}

const STATUS_TITLE: Record<WorkspaceChange['status'], string> = {
  modified: 'Modificato',
  added: 'Aggiunto all’indice',
  deleted: 'Eliminato',
  renamed: 'Rinominato',
  untracked: 'Nuovo file, non tracciato'
}

function previewKey(workspace: string): string {
  return `charliecode.preview.${workspace}`
}

export function ChangesPanel({ workspace, onClose }: ChangesPanelProps): React.JSX.Element {
  const [data, setData] = useState<WorkspaceChanges | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, FileDiff>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [embed, setEmbed] = useState(false)
  const [frameKey, setFrameKey] = useState(0)
  const [gitBusy, setGitBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const next = await window.charliecode.changes(workspace)
      setData(next)
      setDiffs({})
      setOpen(null)
      if (next.previewUrl) {
        setPreviewUrl((current) => current || next.previewUrl || '')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [workspace])

  useEffect(() => {
    void load()
    try {
      setPreviewUrl(window.localStorage.getItem(previewKey(workspace)) ?? '')
    } catch {
      // A blocked localStorage must not break the panel.
    }
  }, [load, workspace])

  useEffect(() => {
    try {
      if (previewUrl) window.localStorage.setItem(previewKey(workspace), previewUrl)
    } catch {
      // Same: remembering the URL is a convenience, not a requirement.
    }
  }, [previewUrl, workspace])

  const toggleDiff = async (change: WorkspaceChange): Promise<void> => {
    if (open === change.path) {
      setOpen(null)
      return
    }
    setOpen(change.path)
    if (diffs[change.path]) return
    setBusy(change.path)
    try {
      const diff = await window.charliecode.changeDiff({ workspace, path: change.path })
      setDiffs((current) => ({ ...current, [change.path]: diff }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const initGit = async (): Promise<void> => {
    if (
      !window.confirm(
        `Inizializzo un repository git in:\n${workspace}\n\nViene creata solo la cartella .git: nessun file viene committato.`
      )
    ) {
      return
    }
    setGitBusy(true)
    try {
      setData(await window.charliecode.initRepository(workspace))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setGitBusy(false)
    }
  }

  const revert = async (change: WorkspaceChange): Promise<void> => {
    const what =
      change.status === 'untracked' || change.status === 'added'
        ? `Elimino ${change.path} (file nuovo, mai committato).`
        : `Riporto ${change.path} all’ultima versione committata.`
    if (!window.confirm(`${what}\n\nLe modifiche locali a questo file vanno perse.`)) return
    setBusy(change.path)
    try {
      const next = await window.charliecode.revertChange({ workspace, change })
      setData(next)
      setDiffs((current) => {
        const copy = { ...current }
        delete copy[change.path]
        return copy
      })
      setOpen(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const changes = data?.changes ?? []
  const totalAdded = changes.reduce((sum, change) => sum + change.added, 0)
  const totalRemoved = changes.reduce((sum, change) => sum + change.removed, 0)

  return (
    <aside className="changes-panel" aria-label="Modifiche del progetto">
      <header className="changes-head">
        <div>
          <h2>Modifiche</h2>
          <p className="muted small">
            {data?.git
              ? [
                  data.branch ? `branch ${data.branch}` : null,
                  `${changes.length} file`,
                  totalAdded > 0 ? `+${totalAdded}` : null,
                  totalRemoved > 0 ? `-${totalRemoved}` : null
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'Questo progetto non è un repository git'}
          </p>
        </div>
        <div className="changes-head-actions">
          <button className="ghost small" onClick={() => void load()} disabled={loading}>
            {loading ? '…' : '↻'}
          </button>
          <button className="ghost small" onClick={onClose} title="Chiudi">
            ✕
          </button>
        </div>
      </header>

      {error && <div className="message-error">{error}</div>}

      <div className="changes-body">
        {!data?.git && !loading && (
          <div className="changes-empty">
            <p className="muted small">
              Senza git non posso dire cosa è cambiato: il pannello legge lo stato reale del
              repository, non la memoria dell’agente.
            </p>
            <button className="primary small" onClick={() => void initGit()} disabled={gitBusy}>
              {gitBusy ? 'inizializzo…' : 'Inizializza git'}
            </button>
            <p className="muted small">
              Viene creata solo la cartella <code>.git</code>: nessun file viene committato o
              aggiunto all’indice.
            </p>
          </div>
        )}

        {data?.git && changes.length === 0 && !loading && (
          <p className="muted small changes-empty">
            Nessuna modifica non committata. Quando l’agente scrive un file, compare qui con il suo
            diff.
          </p>
        )}

        {changes.map((change) => (
          <div key={`${change.path}-${change.from ?? ''}`} className="change">
            <div className="change-row">
              <span
                className={`change-status ${change.status}`}
                title={STATUS_TITLE[change.status]}
              >
                {STATUS_LABEL[change.status]}
              </span>
              <button
                className="change-path"
                onClick={() => void toggleDiff(change)}
                title={change.from ? `${change.from} → ${change.path}` : change.path}
              >
                {change.path}
                {change.from && <span className="muted small"> ← {change.from}</span>}
              </button>
              <span className="change-stats">
                {change.binary ? (
                  <span className="muted small">binario</span>
                ) : (
                  <>
                    {change.added > 0 && <span className="add">+{change.added}</span>}
                    {change.removed > 0 && <span className="del">-{change.removed}</span>}
                  </>
                )}
              </span>
              <span className="change-actions">
                <button
                  className="ghost small"
                  onClick={() => void window.charliecode.openFile({ workspace, path: change.path })}
                  title="Apri nell’editor"
                >
                  apri
                </button>
                <button
                  className="ghost small"
                  onClick={() => void revert(change)}
                  disabled={busy === change.path}
                  title="Annulla le modifiche locali a questo file"
                >
                  annulla
                </button>
              </span>
            </div>

            {open === change.path && (
              <div className="change-diff">
                {busy === change.path && <p className="muted small">Carico il diff…</p>}
                {diffs[change.path] && (
                  <DiffView diff={diffs[change.path] as FileDiff} bare defaultOpen />
                )}
              </div>
            )}
          </div>
        ))}

        {data?.truncated && (
          <p className="muted small changes-empty">
            Ci sono più file di quelli mostrati: committa o annulla qualcosa.
          </p>
        )}
      </div>

      {data?.git && (
        <footer className="changes-preview">
          <div className="changes-preview-head">
            <strong>Anteprima</strong>
            {data.previewScripts.length > 0 && (
              <span className="muted small">
                avvia con{' '}
                {data.previewScripts.map((script) => (
                  <code key={script}>
                    {script === 'dev' ? 'pnpm dev' : `pnpm ${script}`}
                  </code>
                ))}
              </span>
            )}
          </div>
          <div className="changes-preview-row">
            <input
              value={previewUrl}
              onChange={(event) => setPreviewUrl(event.target.value)}
              placeholder="http://localhost:5173"
              spellCheck={false}
            />
            <button
              className="ghost small"
              onClick={() => previewUrl && void window.charliecode.openExternal(previewUrl)}
              disabled={!previewUrl}
            >
              Apri
            </button>
            <label className="provider-toggle small-toggle" title="Alcuni siti vietano di essere incorniciati">
              <input
                type="checkbox"
                checked={embed}
                onChange={(event) => {
                  setEmbed(event.target.checked)
                  setFrameKey((key) => key + 1)
                }}
              />
              <span>qui dentro</span>
            </label>
          </div>
          {embed && previewUrl && (
            <iframe
              key={frameKey}
              className="changes-frame"
              src={previewUrl}
              title="Anteprima del progetto"
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          )}
        </footer>
      )}
    </aside>
  )
}
