import { useMemo, useState } from 'react'
import { Mascot, type MascotMood } from './Mascot'
import { baseName, relativeTime } from '../format'
import type { AppInfo, ProviderStatus, RoutersStatus } from '../../../shared/ipc'
import type { SessionSummary } from '../../../engine/session-types'

/**
 * The left column: one project at a time, with its own chats inside it.
 *
 * Projects are a tree, not a flat list, because a chat belongs to a project:
 * opening another project must not mix its sessions with the current one. Only
 * the open project expands; the others stay one click away with a message count.
 */
export interface SidebarProps {
  info: AppInfo | null
  workspace?: string
  projects: string[]
  sessions: SessionSummary[]
  sessionId: string | null
  providers: ProviderStatus[]
  routers: RoutersStatus | null
  mood: MascotMood
  onTeamPreview: () => void
  onNewProject: () => void
  onSwitchProject: (path: string) => void
  onNewChat: () => void
  onOpenSession: (id: string) => void
  onRenameSession: (id: string, title: string) => void
  onRemoveSession: (id: string) => void
  onOpenSettings: () => void
}

const DAY_GROUPS = ['Oggi', 'Ieri', 'Ultimi 7 giorni', 'Più vecchie'] as const

/** Midnight, `daysAgo` days back: DST-safe, unlike subtracting 24h. */
function startOfDay(daysAgo: number): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - daysAgo)
  return date.getTime()
}

/**
 * Chats read as a history, not a list: a flat column of timestamps makes it
 * hard to tell today's work from something from last month.
 */
function groupByDay(sessions: SessionSummary[]): { label: string; sessions: SessionSummary[] }[] {
  const buckets = new Map<string, SessionSummary[]>(DAY_GROUPS.map((label) => [label, []]))
  const today = startOfDay(0)
  const yesterday = startOfDay(1)
  const week = startOfDay(7)

  for (const session of sessions) {
    const time = new Date(session.updatedAt).getTime()
    const label =
      !Number.isFinite(time) || time < week
        ? 'Più vecchie'
        : time >= today
          ? 'Oggi'
          : time >= yesterday
            ? 'Ieri'
            : 'Ultimi 7 giorni'
    buckets.get(label)?.push(session)
  }

  return DAY_GROUPS.map((label) => ({ label, sessions: buckets.get(label) ?? [] })).filter(
    (group) => group.sessions.length > 0
  )
}

function SessionRow({
  session,
  active,
  projectLabel,
  onOpen,
  onRename,
  onRemove
}: {
  session: SessionSummary
  active: boolean
  /** Shown in search results, where chats from every project are mixed. */
  projectLabel?: string
  onOpen: () => void
  onRename: (title: string) => void
  onRemove: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const [confirming, setConfirming] = useState(false)

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== session.title) onRename(next)
  }

  return (
    <div
      className={`session ${active ? 'active' : ''}`}
      onClick={() => {
        if (!editing) onOpen()
      }}
      title={session.preview || session.title}
    >
      <div className="session-main">
        {editing ? (
          <input
            className="session-rename"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commit()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setDraft(session.title)
                setEditing(false)
              }
            }}
            onBlur={commit}
            aria-label="Nuovo titolo della chat"
          />
        ) : (
          <div className="session-title">{session.title}</div>
        )}
        <div className="session-meta">
          {projectLabel ? `${baseName(projectLabel)} · ` : ''}
          {relativeTime(session.updatedAt)} · {session.messageCount} msg
        </div>
      </div>
      <div className="session-actions">
        {confirming ? (
          <>
            <button
              className="icon danger-text"
              title="Conferma eliminazione"
              aria-label="Conferma eliminazione"
              onClick={(event) => {
                event.stopPropagation()
                setConfirming(false)
                onRemove()
              }}
            >
              ✓
            </button>
            <button
              className="icon"
              title="Annulla"
              aria-label="Annulla eliminazione"
              onClick={(event) => {
                event.stopPropagation()
                setConfirming(false)
              }}
            >
              ✕
            </button>
          </>
        ) : (
          <>
            <button
              className="icon"
              title="Rinomina"
              aria-label="Rinomina la chat"
              onClick={(event) => {
                event.stopPropagation()
                setDraft(session.title)
                setEditing(true)
              }}
            >
              ✎
            </button>
            <button
              className="icon danger-text"
              title="Elimina"
              aria-label="Elimina la chat"
              onClick={(event) => {
                event.stopPropagation()
                setConfirming(true)
              }}
            >
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function Sidebar({
  info,
  workspace,
  projects,
  sessions,
  sessionId,
  providers,
  routers,
  mood,
  onTeamPreview,
  onNewProject,
  onSwitchProject,
  onNewChat,
  onOpenSession,
  onRenameSession,
  onRemoveSession,
  onOpenSettings
}: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return []
    return sessions.filter((session) =>
      `${session.title} ${session.preview}`.toLowerCase().includes(needle)
    )
  }, [needle, sessions])

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <button
            className="brand-mascot"
            onClick={onTeamPreview}
            title="Vedi la squadra al lavoro"
            aria-label="Vedi la squadra al lavoro"
          >
            <Mascot size={38} mood={mood} />
          </button>
          <div>
            <div className="brand-name">CharlieCode</div>
            <div className="brand-sub">v{info?.version ?? '0.0.1'}</div>
          </div>
        </div>

        <button
          className="new-project"
          onClick={onNewProject}
          title="Scegli o crea la cartella di un progetto"
        >
          <span className="project-icon">＋</span>
          <span>Nuovo progetto</span>
        </button>

        <input
          id="session-search"
          className="sidebar-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Cerca nelle chat…"
          aria-label="Cerca nelle chat"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('')
          }}
        />
      </div>

      <div className="project-tree">
        {needle ? (
          matches.length === 0 ? (
            <div className="session-empty">Nessuna chat trovata</div>
          ) : (
            groupByDay(matches).map((group) => (
              <div key={group.label} className="session-group">
                <div className="session-group-label">{group.label}</div>
                {group.sessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === sessionId}
                    {...(session.workspacePath ? { projectLabel: session.workspacePath } : {})}
                    onOpen={() => onOpenSession(session.id)}
                    onRename={(title) => onRenameSession(session.id, title)}
                    onRemove={() => onRemoveSession(session.id)}
                  />
                ))}
              </div>
            ))
          )
        ) : (
          <>
            {projects.length === 0 && <div className="session-empty">Nessun progetto aperto</div>}
            {projects.map((project) => {
              const active = project === workspace
              // Sessions are per project: one without a workspace belongs to
              // the project that is open now.
              const projectSessions = sessions.filter((session) =>
                session.workspacePath ? session.workspacePath === project : active
              )
              return (
                <div key={project} className={`project-node ${active ? 'active' : ''}`}>
                  <button
                    className="project-row"
                    onClick={() => onSwitchProject(project)}
                    title={project}
                    aria-expanded={active}
                  >
                    <span className="project-caret">{active ? '▾' : '▸'}</span>
                    <span className="project-label">{baseName(project)}</span>
                    {projectSessions.length > 0 && (
                      <span className="project-count">{projectSessions.length}</span>
                    )}
                  </button>

                  {active && (
                    <div className="project-children">
                      {projectSessions.length === 0 && (
                        <div className="session-empty">Nessuna chat in questo progetto</div>
                      )}
                      {groupByDay(projectSessions).map((group) => (
                        <div key={group.label} className="session-group">
                          <div className="session-group-label">{group.label}</div>
                          {group.sessions.map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              active={session.id === sessionId}
                              onOpen={() => onOpenSession(session.id)}
                              onRename={(title) => onRenameSession(session.id, title)}
                              onRemove={() => onRemoveSession(session.id)}
                            />
                          ))}
                        </div>
                      ))}
                      <button className="new-chat nested" onClick={onNewChat}>
                        + Nuova chat
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>

      <div className="sidebar-bottom">
        {/* One entry point: with no model the main area already offers the
            guided setup as its only action, so the sidebar does not repeat it. */}
        <button className="primary wide" onClick={onOpenSettings}>
          ⚙ Impostazioni
        </button>
        <div className="sidebar-foot">
          {providers.filter((provider) => provider.enabled).length} provider attivi
          {routers?.ollama.running ? ' · ollama ✓' : ''}
          {routers?.freellmapi.running ? ' · router ✓' : ''}
        </div>
        <div className="sidebar-foot">
          {info?.platform === 'darwin' ? '⌘N' : 'Ctrl+N'} nuova chat ·{' '}
          {info?.platform === 'darwin' ? '⌘K' : 'Ctrl+K'} cerca
        </div>
      </div>
    </aside>
  )
}
