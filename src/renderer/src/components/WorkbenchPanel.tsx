import { useCallback, useEffect, useState } from 'react'
import type {
  WorkspaceChanges,
  WorkspaceEntry,
  WorkspaceFile
} from '../../../shared/ipc'

/**
 * The right-hand workbench: Preview, Code and Browser.
 *
 * Preview shows the URL the project serves (detected from package.json) and
 * remembers the one you typed. Code is a read-only tree of the open project,
 * loaded folder by folder. Browser is a plain frame with its own address bar:
 * some sites refuse to be framed, and the panel says so instead of showing a
 * blank rectangle — those open in the real browser.
 *
 * Everything here is a frame, not a second Chromium: the app window stays
 * sandboxed and a page can never reach the preload bridge.
 */

type Tab = 'preview' | 'code' | 'browser'

const TABS: { id: Tab; label: string }[] = [
  { id: 'preview', label: 'Anteprima' },
  { id: 'code', label: 'Codice' },
  { id: 'browser', label: 'Browser' }
]

const TAB_KEY = 'charliecode.workbench.tab'
const MAX_RENDERED_LINES = 2_000

function storedTab(): Tab {
  try {
    const value = window.localStorage.getItem(TAB_KEY)
    return value === 'code' || value === 'browser' ? value : 'preview'
  } catch {
    return 'preview'
  }
}

function urlKey(workspace: string, kind: 'preview' | 'browser'): string {
  return `charliecode.${kind}.${workspace}`
}

function storedUrl(workspace: string, kind: 'preview' | 'browser'): string {
  try {
    return window.localStorage.getItem(urlKey(workspace, kind)) ?? ''
  } catch {
    return ''
  }
}

function remember(workspace: string, kind: 'preview' | 'browser', url: string): void {
  try {
    window.localStorage.setItem(urlKey(workspace, kind), url)
  } catch {
    // Remembering a URL is a convenience, never a requirement.
  }
}

/** `example.com` becomes `https://example.com`; localhost stays as typed. */
function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`
  return `https://${trimmed}`
}

interface WorkbenchPanelProps {
  workspace: string
  initialTab?: Tab
  onClose: () => void
}

export function WorkbenchPanel({
  workspace,
  initialTab,
  onClose
}: WorkbenchPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab ?? storedTab())

  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_KEY, tab)
    } catch {
      // Preference only.
    }
  }, [tab])

  return (
    <aside className="workbench" aria-label="Anteprima, codice e browser">
      <header className="workbench-head">
        <div className="workbench-tabs" role="tablist" aria-label="Pannello">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              role="tab"
              aria-selected={tab === entry.id}
              className={`workbench-tab ${tab === entry.id ? 'active' : ''}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button className="ghost small" onClick={onClose} title="Chiudi il pannello" aria-label="Chiudi il pannello">
          ✕
        </button>
      </header>

      <div className="workbench-body">
        {tab === 'preview' && <PreviewTab workspace={workspace} />}
        {tab === 'code' && <CodeTab workspace={workspace} />}
        {tab === 'browser' && <BrowserTab workspace={workspace} />}
      </div>
    </aside>
  )
}

/* ------------------------------- preview -------------------------------- */

function PreviewTab({ workspace }: { workspace: string }): React.JSX.Element {
  const [url, setUrl] = useState(() => storedUrl(workspace, 'preview'))
  const [scripts, setScripts] = useState<string[]>([])
  const [frameKey, setFrameKey] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.charliecode
      .changes(workspace)
      .then((data: WorkspaceChanges) => {
        if (cancelled) return
        setScripts(data.previewScripts)
        setUrl((current) => current || data.previewUrl || '')
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [workspace])

  useEffect(() => {
    if (url) remember(workspace, 'preview', url)
  }, [url, workspace])

  return (
    <div className="workbench-pane">
      <div className="browser-bar">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setFrameKey((key) => key + 1)
          }}
          placeholder="http://localhost:5173"
          spellCheck={false}
          aria-label="URL dell’anteprima"
        />
        <button
          className="ghost small"
          onClick={() => setFrameKey((key) => key + 1)}
          disabled={!url}
          title="Ricarica l’anteprima"
        >
          ↻
        </button>
        <button
          className="ghost small"
          onClick={() => url && void window.charliecode.openExternal(url)}
          disabled={!url}
          title="Apri nel browser di sistema"
        >
          Apri
        </button>
      </div>

      {scripts.length > 0 && (
        <p className="muted small workbench-hint">
          Il progetto parte con {scripts.map((script) => `pnpm ${script}`).join(' · ')}: avvialo nel
          terminale, poi ricarica.
        </p>
      )}

      {url ? (
        <iframe
          key={frameKey}
          className="workbench-frame"
          src={url}
          title="Anteprima del progetto"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      ) : (
        <div className="workbench-empty">
          <p>Nessun indirizzo rilevato in questo progetto.</p>
          <p className="muted small">
            Avvia il dev server e scrivi qui l’indirizzo, per esempio <code>localhost:5173</code>.
          </p>
        </div>
      )}

      {error && <p className="error small">{error}</p>}
    </div>
  )
}

/* -------------------------------- browser ------------------------------- */

function BrowserTab({ workspace }: { workspace: string }): React.JSX.Element {
  const [url, setUrl] = useState(() => storedUrl(workspace, 'browser'))
  const [current, setCurrent] = useState(() => storedUrl(workspace, 'browser'))
  const [history, setHistory] = useState<string[]>([])
  const [frameKey, setFrameKey] = useState(0)

  const go = (raw: string): void => {
    const next = normalizeUrl(raw)
    if (!next) return
    setUrl(next)
    setCurrent(next)
    remember(workspace, 'browser', next)
    setFrameKey((key) => key + 1)
    setHistory((previous) => (previous[previous.length - 1] === next ? previous : [...previous, next]))
  }

  return (
    <div className="workbench-pane">
      <div className="browser-bar">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') go(url)
          }}
          placeholder="docs.salesforce.com"
          spellCheck={false}
          aria-label="Indirizzo del browser"
        />
        <button
          className="ghost small"
          onClick={() => setHistory((previous) => previous.slice(0, -1))}
          disabled={history.length < 2}
          title="Indietro"
        >
          ‹
        </button>
        <button
          className="ghost small"
          onClick={() => setFrameKey((key) => key + 1)}
          disabled={!current}
          title="Ricarica"
        >
          ↻
        </button>
        <button
          className="ghost small"
          onClick={() => current && void window.charliecode.openExternal(current)}
          disabled={!current}
          title="Apri nel browser di sistema"
        >
          Apri
        </button>
      </div>

      {current ? (
        <iframe
          key={`${current}-${frameKey}`}
          className="workbench-frame"
          src={current}
          title="Browser"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      ) : (
        <div className="workbench-empty">
          <p>Scrivi un indirizzo e premi Enter.</p>
          <p className="muted small">
            Un sito che vieta di essere incorniciato resta bianco: usa «Apri» per il browser di
            sistema.
          </p>
        </div>
      )}
    </div>
  )
}

/* --------------------------------- code --------------------------------- */

function CodeTab({ workspace }: { workspace: string }): React.JSX.Element {
  const [dirs, setDirs] = useState<Record<string, WorkspaceEntry[]>>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<WorkspaceFile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadDir = useCallback(
    async (path: string): Promise<void> => {
      try {
        const listing = await window.charliecode.workspaceTree(workspace, path)
        setDirs((previous) => ({ ...previous, [path]: listing.entries }))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [workspace]
  )

  useEffect(() => {
    setDirs({})
    setExpanded([])
    setSelected(null)
    setFile(null)
    void loadDir('').finally(() => setLoading(false))
  }, [loadDir])

  const openFile = async (path: string): Promise<void> => {
    setSelected(path)
    setError(null)
    try {
      setFile(await window.charliecode.workspaceFile(workspace, path))
    } catch (cause) {
      setFile(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const toggleDir = (path: string): void => {
    setExpanded((previous) =>
      previous.includes(path) ? previous.filter((entry) => entry !== path) : [...previous, path]
    )
    if (!dirs[path]) void loadDir(path)
  }

  const rows: React.JSX.Element[] = []
  const walk = (path: string, depth: number): void => {
    for (const entry of dirs[path] ?? []) {
      const open = entry.dir && expanded.includes(entry.path)
      rows.push(
        <button
          key={entry.path}
          className={`code-row ${selected === entry.path ? 'active' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => (entry.dir ? toggleDir(entry.path) : void openFile(entry.path))}
          title={entry.path}
        >
          <span className="code-icon">{entry.dir ? (open ? '▾' : '▸') : '·'}</span>
          <span className="code-name">{entry.name}</span>
        </button>
      )
      if (open) walk(entry.path, depth + 1)
    }
  }
  walk('', 0)

  return (
    <div className="workbench-pane code-pane">
      <div className="code-split">
        <div className="code-tree" aria-label="File del progetto">
          <div className="code-tree-head">
            <span className="muted small">progetto</span>
            <button
              className="ghost small"
              onClick={() => void loadDir('')}
              title="Rileggi la cartella"
            >
              ↻
            </button>
          </div>
          {loading ? <p className="muted small">carico…</p> : rows}
        </div>

        <div className="code-view">
          {file ? (
            <>
              <div className="code-view-head">
                <span className="code-path" title={file.path}>
                  {file.path}
                </span>
                <span className="muted small">
                  {file.binary ? 'binario' : `${formatBytes(file.size)}${file.truncated ? ' · primi 200 kB' : ''}`}
                </span>
              </div>
              {file.binary ? (
                <div className="workbench-empty">
                  <p>File binario: niente da mostrare.</p>
                </div>
              ) : (
                <div className="code-text">
                  {file.text.split('\n').slice(0, MAX_RENDERED_LINES).map((line, index) => (
                    <div className="code-line" key={index}>
                      <span className="code-ln">{index + 1}</span>
                      <span className="code-source">{line || ' '}</span>
                    </div>
                  ))}
                  {file.text.split('\n').length > MAX_RENDERED_LINES && (
                    <p className="muted small">…il resto del file non è mostrato.</p>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="workbench-empty">
              <p>Scegli un file dall’albero.</p>
              <p className="muted small">La lettura è sola andata: da qui non si modifica niente.</p>
            </div>
          )}
          {error && <p className="error small">{error}</p>}
        </div>
      </div>
    </div>
  )
}

function formatBytes(size: number): string {
  if (size < 1_024) return `${size} B`
  if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(1)} kB`
  return `${(size / (1_024 * 1_024)).toFixed(1)} MB`
}
