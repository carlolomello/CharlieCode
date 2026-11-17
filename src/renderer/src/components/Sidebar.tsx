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
  onOpenWizard: () => void
  onOpenSettings: () => void
  onOpenConfig: () => void
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
  onOpenWizard,
  onOpenSettings,
  onOpenConfig
}: SidebarProps): React.JSX.Element {
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
      </div>

      <div className="project-tree">
        {projects.length === 0 && <div className="session-empty">Nessun progetto aperto</div>}
        {projects.map((project) => {
          const active = project === workspace
          // Sessions are per project: one without a workspace belongs to the
          // project that is open now.
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
                  <button className="new-chat nested" onClick={onNewChat}>
                    + Nuova chat
                  </button>
                  {projectSessions.length === 0 && (
                    <div className="session-empty">Nessuna chat in questo progetto</div>
                  )}
                  {projectSessions.map((session) => (
                    <div
                      key={session.id}
                      className={`session ${session.id === sessionId ? 'active' : ''}`}
                      onClick={() => onOpenSession(session.id)}
                      title={session.preview || session.title}
                    >
                      <div className="session-main">
                        <div className="session-title">{session.title}</div>
                        <div className="session-meta">
                          {relativeTime(session.updatedAt)} · {session.messageCount} msg
                        </div>
                      </div>
                      <div className="session-actions">
                        <button
                          className="icon"
                          title="Rinomina"
                          onClick={(event) => {
                            event.stopPropagation()
                            onRenameSession(session.id, session.title)
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="icon danger-text"
                          title="Elimina"
                          onClick={(event) => {
                            event.stopPropagation()
                            onRemoveSession(session.id)
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="sidebar-bottom">
        <button className="primary wide" onClick={onOpenWizard}>
          ✦ Collega un modello
        </button>
        <button className="ghost wide" onClick={onOpenSettings}>
          ⚙ Provider e chiavi
        </button>
        <button className="ghost wide" onClick={onOpenConfig}>
          Apri cartella config
        </button>
        <div className="sidebar-foot">
          {info?.platform ?? '…'} · {providers.filter((provider) => provider.enabled).length} provider
          {routers?.ollama.running ? ' · ollama ✓' : ''}
          {routers?.freellmapi.running ? ' · router ✓' : ''}
        </div>
      </div>
    </aside>
  )
}
