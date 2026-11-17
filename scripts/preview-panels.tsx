/**
 * Dev-only: the right-hand panels with fake data, for visual review.
 *
 *   pnpm wizard && python3 -m http.server 8766 -d scripts/.preview
 *   open http://localhost:8766/preview-panels.html
 */
import { createRoot } from 'react-dom/client'
import { ChangesPanel } from '../src/renderer/src/components/ChangesPanel'
import { MascotTeam } from '../src/renderer/src/components/Mascot'
import { ExternalCliPanel } from '../src/renderer/src/components/ExternalCliPanel'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import type {
  AppInfo,
  ProviderStatus,
  RoutersStatus,
  WorkspaceChange,
  WorkspaceChanges
} from '../src/shared/ipc'
import type { SessionSummary } from '../src/engine/session-types'

const workspace = '/Users/carlolomello/Desktop/VSCodePlugions/sfdc-atlas'

const changes: WorkspaceChange[] = [
  { path: 'src/extension.ts', displayPath: 'src/extension.ts', status: 'modified', added: 24, removed: 3, staged: false },
  { path: 'src/metadata/tree.ts', displayPath: 'src/metadata/tree.ts', status: 'modified', added: 6, removed: 9, staged: false },
  { path: 'src/ui/virtualFolder.ts', displayPath: 'src/ui/virtualFolder.ts', status: 'untracked', added: 41, removed: 0, staged: false },
  { path: 'src/legacy/oldTree.ts', displayPath: 'src/legacy/oldTree.ts', status: 'deleted', added: 0, removed: 118, staged: false },
  { path: 'src/nav.ts', displayPath: 'src/nav.ts', status: 'renamed', added: 0, removed: 0, staged: true, from: 'src/navigation.ts' },
  { path: 'assets/icon.png', displayPath: 'assets/icon.png', status: 'modified', added: 0, removed: 0, staged: false, binary: true }
]

const data: WorkspaceChanges = {
  workspace,
  git: true,
  branch: 'feat/virtual-folders',
  changes,
  previewScripts: ['dev'],
  previewUrl: 'http://localhost:5173'
}

const diffs: Record<string, string> = {
  'src/extension.ts': [
    '--- a/src/extension.ts',
    '+++ b/src/extension.ts',
    '@@ -12,7 +12,12 @@ export function activate(context: vscode.ExtensionContext) {',
    '   const provider = new MetadataTreeProvider()',
    '   context.subscriptions.push(',
    '     vscode.window.createTreeView("sfdcAtlas", { treeDataProvider: provider })',
    '   )',
    '+  // Una cartella virtuale per ogni tipo di metadato: aprire un oggetto',
    '+  // non deve richiedere di ricordare in che cartella vive.',
    '+  provider.groupByType()',
    '+',
    '+  const status = vscode.window.createStatusBarItem()',
    '+  status.text = "Atlas: pronto"',
    '   status.show()'
  ].join('\n')
}

;(window as unknown as { charliecode: unknown }).charliecode = {
  externalAgents: async () => ({
    detected: [
      {
        id: 'opencode',
        label: 'OpenCode',
        path: '/Users/carlolomello/.opencode/bin/opencode',
        version: '2.3.0',
        notes: 'Parla --format json: vediamo testo, step e fine turno.',
        canListModels: true
      },
      {
        id: 'cline',
        label: 'Cline',
        path: '/usr/local/bin/cline',
        version: '3.1.0',
        notes: 'Headless con --json: l’ultima riga run_result contiene la risposta.',
        canListModels: false
      },
      {
        id: 'gaia',
        label: 'Gaia Axet (fork Cline)',
        path: '/Applications/Gaia.app/Contents/MacOS/gaia',
        notes: 'Presumo la stessa interfaccia di Cline (--json, run_result).',
        canListModels: false
      }
    ],
    worker: { id: 'gaia', model: 'sonnet-5.5' }
  }),
  externalAgentModels: async () => ['freellmapi/auto', 'anthropic/sonnet-5.5'],
  testExternalAgent: async () => ({ ok: true, text: 'ok', ms: 2400 }),
  setExternalWorker: async () => ({ detected: [] }),
  changes: async () => data,
  changeDiff: async ({ path }: { path: string }) => ({
    path,
    displayPath: path,
    added: 5,
    removed: 0,
    unified: diffs[path] ?? 'Nessuna differenza.'
  }),
  revertChange: async () => data,
  openFile: async () => undefined,
  openExternal: async () => undefined
}

const view = new URLSearchParams(location.search).get('view')

const team = (
  <div className="overlay team-overlay">
    <div className="team-preview">
      <div className="team-preview-head">
        <div>
          <h2>La squadra di Charlie</h2>
          <p className="muted small">
            Compare quando l’agente delega con <code>task</code>: Charlie in piedi supervisiona, i
            subagenti scrivono al computer.
          </p>
        </div>
        <button className="ghost small">✕</button>
      </div>
      <MascotTeam
        width={720}
        members={[
          { id: 'd1', label: 'esplora' },
          { id: 'd2', label: 'implementa' },
          { id: 'd3', label: 'verifica' },
          { id: 'd4', label: 'documenta' }
        ]}
      />
      <div className="team-preview-foot">
        <span className="muted small">
          Un subagente = un contesto separato: legge, lavora e riporta. Charlie integra.
        </span>
        <button className="primary">Attiva Squadra</button>
      </div>
    </div>
  </div>
)

const now = Date.now()
const iso = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString()

const projectA = '/Users/carlolomello/Desktop/VSCodePlugions/sfdc-atlas'
const projectB = '/Users/carlolomello/Desktop/VSCodePlugions/CharlieMultiAgentic'

const fakeSessions: SessionSummary[] = [
  {
    id: 's1',
    title: 'Campi su Account e classe che li usa',
    createdAt: iso(180),
    updatedAt: iso(4),
    workspacePath: projectA,
    effort: 'none',
    messageCount: 24,
    preview: 'Crea quattro campi…'
  },
  {
    id: 's2',
    title: 'Permission set e FLS',
    createdAt: iso(600),
    updatedAt: iso(120),
    workspacePath: projectA,
    effort: 'none',
    messageCount: 9,
    preview: 'Aggiorna il permission set…'
  },
  {
    id: 's3',
    title: 'Squadra visibile durante il lavoro',
    createdAt: iso(3000),
    updatedAt: iso(1500),
    workspacePath: projectB,
    effort: 'none',
    messageCount: 41,
    preview: 'La mascotte…'
  }
]

const fakeProviders = [
  { id: 'freellmapi', label: 'FreeLLMAPI', enabled: true },
  { id: 'gemini', label: 'Gemini', enabled: false }
] as unknown as ProviderStatus[]

const fakeRouters = {
  ollama: { running: false },
  freellmapi: { running: true },
  detected: [],
  docker: false
} as unknown as RoutersStatus

const fakeInfo = {
  version: '0.0.1',
  platform: 'darwin',
  configDir: '/tmp',
  configPath: '/tmp/config.json',
  credentialsPath: '/tmp/credentials.json',
  electron: '39',
  recentWorkspaces: [projectA, projectB],
  effort: 'none'
} as unknown as AppInfo

const sidebar = (
  <div className="app">
    <Sidebar
      info={fakeInfo}
      workspace={projectA}
      projects={[projectA, projectB]}
      sessions={fakeSessions}
      sessionId="s1"
      providers={fakeProviders}
      routers={fakeRouters}
      mood="idle"
      onTeamPreview={() => undefined}
      onNewProject={() => undefined}
      onSwitchProject={() => undefined}
      onNewChat={() => undefined}
      onOpenSession={() => undefined}
      onRenameSession={() => undefined}
      onRemoveSession={() => undefined}
      onOpenWizard={() => undefined}
      onOpenSettings={() => undefined}
      onOpenConfig={() => undefined}
    />
    <div style={{ flex: 1 }} />
  </div>
)

const cliPanel = (
  <div className="wizard" style={{ width: 'min(680px, 94vw)' }}>
    <div className="wizard-body">
      <section className="wizard-panel">
        <ExternalCliPanel onClose={() => undefined} />
      </section>
    </div>
  </div>
)

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(
  <div
    className="app"
    style={{
      justifyContent:
        view === 'team' || view === 'cli'
          ? 'center'
          : view === 'sidebar'
            ? 'flex-start'
            : 'flex-end'
    }}
  >
    {view === 'team' ? (
      team
    ) : view === 'sidebar' ? (
      sidebar
    ) : view === 'cli' ? (
      cliPanel
    ) : (
      <ChangesPanel workspace={workspace} onClose={() => undefined} />
    )}
  </div>
)

// `?open=src/extension.ts` expands that file's diff, so the screenshot shows it.
const openPath = new URLSearchParams(location.search).get('open')
if (openPath) {
  setTimeout(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.change-path')) {
      if (button.textContent?.includes(openPath)) button.click()
    }
  }, 300)
}
