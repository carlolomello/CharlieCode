/**
 * Dev-only: the right-hand panels with fake data, for visual review.
 *
 *   pnpm wizard && python3 -m http.server 8766 -d scripts/.preview
 *   open http://localhost:8766/preview-panels.html
 */
import { createRoot } from 'react-dom/client'
import { ChangesPanel } from '../src/renderer/src/components/ChangesPanel'
import { MascotTeam } from '../src/renderer/src/components/Mascot'
import type { WorkspaceChange, WorkspaceChanges } from '../src/shared/ipc'

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

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(
  <div className="app" style={{ justifyContent: view === 'team' ? 'center' : 'flex-end' }}>
    {view === 'team' ? team : <ChangesPanel workspace={workspace} onClose={() => undefined} />}
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
