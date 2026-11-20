/**
 * Dev-only: the main window with fake data, for visual review.
 *
 *   pnpm wizard && python3 -m http.server 8766 -d scripts/.preview
 *   open http://localhost:8766/preview-app.html?view=chat
 *
 * Views: `chat` (a conversation), `empty` (project open, no messages),
 * `nosetup` (no model configured — the first-run screen).
 * `?open=drawer` and `?open=wizard` open those overlays after mount.
 */
import { createRoot } from 'react-dom/client'
import App from '../src/renderer/src/App'
import type { ContextStats, ModelEntry, ToolLog } from '../src/engine/types'
import type { Session, SessionSummary } from '../src/engine/session-types'
import type { AppInfo, ProviderStatus, RoutersStatus } from '../src/shared/ipc'

const workspace = '/Users/carlolomello/Desktop/VSCodePlugions/sfdc-atlas'
const other = '/Users/carlolomello/Desktop/VSCodePlugions/CharlieMultiAgentic'

const view = new URLSearchParams(location.search).get('view') ?? 'chat'

const models: ModelEntry[] =
  view === 'nosetup'
    ? []
    : [
        {
          key: 'freellmapi::auto',
          providerId: 'freellmapi',
          providerLabel: 'FreeLLMAPI',
          id: 'auto',
          label: 'Automatico (il router sceglie)',
          caps: { tools: true, vision: true, contextWindow: 128000 },
          capsConfidence: 'guess',
          effort: 'none',
          efforts: ['none']
        },
        {
          key: 'openrouter::qwen/qwen3-coder:free',
          providerId: 'openrouter',
          providerLabel: 'OpenRouter',
          id: 'qwen/qwen3-coder:free',
          label: 'Qwen3 Coder (free)',
          caps: { tools: true, vision: false, contextWindow: 262144 },
          capsConfidence: 'guess',
          effort: 'none',
          efforts: ['none', 'low', 'high']
        }
      ]

const info: AppInfo = {
  version: '0.0.1',
  platform: 'darwin',
  configDir: '/Users/carlolomello/.charliecode',
  configPath: '/Users/carlolomello/.charliecode/config.json',
  credentialsPath: '/Users/carlolomello/.charliecode/credentials.json',
  electron: '45.3.0',
  workspacePath: workspace,
  recentWorkspaces: [workspace, other],
  effort: 'none'
}

const providers: ProviderStatus[] = [
  {
    id: 'freellmapi',
    label: 'FreeLLMAPI',
    baseUrl: 'http://127.0.0.1:31415/v1',
    kind: 'router',
    enabled: true,
    hasKey: true,
    keyHint: '…7f2a',
    keySource: 'credentials',
    showAllModels: false,
    free: true
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    kind: 'direct',
    enabled: true,
    hasKey: false,
    keyHint: '',
    keySource: 'none',
    showAllModels: false,
    free: true,
    docs: 'https://openrouter.ai/keys'
  }
]

const routers: RoutersStatus = {
  freellmapi: { running: true, installed: true, hint: 'in ascolto su 31415' },
  ollama: { running: false, installed: false, hint: 'non in ascolto su 11434' },
  detected: [],
  docker: false
} as unknown as RoutersStatus

const now = Date.now()
const iso = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString()

const toolLogs: ToolLog[] = [
  {
    id: 't1',
    name: 'read',
    title: 'src/metadata/parser.ts',
    status: 'ok',
    summary: '218 righe lette',
    ms: 41
  },
  {
    id: 't2',
    name: 'edit',
    title: 'src/metadata/parser.ts',
    status: 'ok',
    summary: '+12 −4',
    ms: 96,
    diff: {
      path: 'src/metadata/parser.ts',
      unified: [
        '--- a/src/metadata/parser.ts',
        '+++ b/src/metadata/parser.ts',
        '@@ -14,7 +14,11 @@ export function parseTag(raw: string) {',
        '   const trimmed = raw.trim()',
        '-  if (!trimmed) return null',
        '+  // Un tag vuoto è un errore del chiamante, non un valore nullo:',
        '+  // nasconderlo faceva sparire il campo dalla UI senza spiegazione.',
        '+  if (!trimmed) throw new Error("tag vuoto")',
        '   const [name, value] = trimmed.split("=")',
        '+  if (!name || value === undefined) throw new Error(`tag non valido: ${raw}`)',
        '   return { name, value }'
      ].join('\n')
    }
  },
  {
    id: 't3',
    name: 'bash',
    title: 'pnpm test',
    status: 'ok',
    summary: '12 test passati',
    ms: 4210
  }
]

const session: Session = {
  id: 's1',
  title: 'Campi su Account e classe che li usa',
  createdAt: iso(180),
  updatedAt: iso(4),
  workspacePath: workspace,
  modelKey: 'freellmapi::auto',
  effort: 'none',
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: 'Sistema il parser dei tag: oggi un tag vuoto sparisce senza dire niente.',
      createdAt: iso(12)
    },
    {
      id: 'm2',
      role: 'assistant',
      content: [
        'Ho letto `src/metadata/parser.ts`: il problema è che un tag vuoto tornava `null` e il chiamante lo trattava come "campo assente".',
        '',
        'Ora il parser distingue i due casi:',
        '',
        '- tag vuoto → errore esplicito',
        '- tag senza `=` → errore con il valore originale nel messaggio',
        '',
        '```ts',
        'if (!trimmed) throw new Error("tag vuoto")',
        '```',
        '',
        'Test: **12 passati**, typecheck pulito.'
      ].join('\n'),
      createdAt: iso(11),
      modelKey: 'freellmapi::auto',
      tools: toolLogs,
      meta: '4 step · 3 tool · ttft 640ms · totale 12.4s · 812 token'
    },
    {
      id: 'm3',
      role: 'user',
      content: 'Ok, ma prima dimmi cosa toccherebbe per migrare i chiamanti.',
      createdAt: iso(6)
    },
    {
      id: 'm4',
      role: 'assistant',
      content: [
        '## Piano',
        '',
        '1. **`src/ui/tree.ts`** — oggi assume `null`; va gestito il throw con un messaggio in UI.',
        '2. **`src/extension.ts`** — un `try/catch` attorno al parse, per non perdere il file intero.',
        '3. **Test** — due casi nuovi sul chiamante, non solo sul parser.',
        '',
        'Rischio basso: nessuna migrazione di dati, solo gestione errori.'
      ].join('\n'),
      createdAt: iso(5),
      modelKey: 'freellmapi::auto',
      mode: 'plan'
    }
  ]
} as Session

const sessions: SessionSummary[] = [
  {
    id: 's1',
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: iso(4),
    workspacePath: workspace,
    modelKey: 'freellmapi::auto',
    effort: 'none',
    messageCount: 4,
    preview: 'Sistema il parser dei tag…'
  },
  {
    id: 's2',
    title: 'Permission set e FLS',
    createdAt: iso(600),
    updatedAt: iso(120),
    workspacePath: workspace,
    effort: 'none',
    messageCount: 9,
    preview: 'Aggiorna il permission set…'
  }
]

const context: ContextStats = {
  tokens: 8420,
  totalTokens: 61200,
  budget: 128000,
  messages: 4,
  droppedMessages: 0,
  compacted: false
}

const plugins = [
  {
    id: 'memory',
    name: 'Memoria del progetto',
    tagline: 'Ricorda il progetto tra una sessione e l’altra',
    description: 'Tiene `.charliecode/memory.md` dentro il progetto e lo inietta a ogni sessione.',
    tools: ['remember'],
    enabled: true
  },
  {
    id: 'advisor',
    name: 'Consigliere di setup',
    tagline: 'Comandi, AGENTS.md e skill sensate',
    description: 'Legge il progetto e propone le cose utili: comandi veri, istruzioni, skill.',
    tools: ['suggest_setup'],
    enabled: true
  },
  {
    id: 'reach',
    name: 'Agent Reach',
    tagline: 'Legge documentazione e pagine come testo',
    description: 'Scarica una pagina e la passa all’agente come testo pulito, mai come istruzioni.',
    tools: ['fetch_url'],
    enabled: true
  }
]

const skills = [
  {
    id: 'verify-before-commit',
    name: 'verify-before-commit',
    description: 'La sequenza di verifica da eseguire prima di dire che una modifica è pronta',
    source: 'global',
    path: '/Users/carlolomello/.charliecode/skills/verify-before-commit/SKILL.md',
    dir: '/Users/carlolomello/.charliecode/skills/verify-before-commit'
  }
] as unknown as import('../src/shared/ipc').SkillInfo[]

const noop = async (): Promise<undefined> => undefined
const unsubscribe = (): void => undefined

const bridge = {
  info: async () => info,
  models: async () => ({
    models,
    errors: [],
    defaultModel: models[0]?.key
  }),
  providers: async () => providers,
  listSessions: async () => (view === 'chat' ? sessions : []),
  routers: async () => routers,
  routing: async () => ({ enabled: false, roles: [] }),
  autoApprove: async () => ({ tools: ['read', 'ls', 'glob', 'grep'], commands: ['git status'] }),
  plugins: async () => plugins,
  skills: async () => skills,
  changes: async () => ({
    workspace,
    git: true,
    branch: 'main',
    changes: [],
    previewScripts: ['dev'],
    previewUrl: 'http://localhost:5173'
  }),
  contextStats: async () => context,
  onboardingFacts: async () => ({ needsOnboarding: false }),
  loadSession: async () => (view === 'chat' ? session : null),
  onChatEvent: () => unsubscribe,
  onPermission: () => unsubscribe,
  onChatSession: () => unsubscribe,
  onModelsChanged: () => unsubscribe,
  onConfigChanged: () => unsubscribe,
  openExternal: noop,
  openWorkspace: noop,
  openConfigDir: noop,
  openProjectMemory: noop,
  openSkillsDir: noop,
  openGlobalAgents: noop,
  openRouting: noop,
  suggestSetup: noop,
  setProviderKey: async () => providers,
  toggleProvider: async () => providers,
  setProviderShowAllModels: async () => providers,
  setPluginEnabled: async () => plugins,
  addProvider: async () => providers,
  installSkill: async () => skills,
  removeSkill: async () => skills,
  compactContext: async () => context,
  cliProfileModels: async () => [],
  stopChat: noop,
  respondPermission: noop,
  pickWorkspace: async () => ({ path: workspace }),
  useWorkspace: async () => ({ path: workspace }),
  deleteSession: noop,
  renameSession: noop,
  startChat: async () => ({ ok: true, sessionId: 's1' })
}

;(window as unknown as { charliecode: unknown }).charliecode = new Proxy(bridge, {
  get: (target, key) => (key in target ? target[key as keyof typeof target] : noop)
})

createRoot(document.getElementById('root') as HTMLElement).render(<App />)

// `view=chat` opens the first saved chat, so the transcript is on screen.
if (view === 'chat') {
  setTimeout(() => document.querySelector<HTMLElement>('.session')?.click(), 400)
}

// `?open=drawer|wizard` opens the matching overlay once the first render lands.
const open = new URLSearchParams(location.search).get('open')
if (open) {
  setTimeout(() => {
    const label = open === 'drawer' ? 'Impostazioni' : 'Collega un modello'
    for (const button of document.querySelectorAll<HTMLButtonElement>('button')) {
      if (button.textContent?.includes(label)) {
        button.click()
        return
      }
    }
  }, 400)
}
