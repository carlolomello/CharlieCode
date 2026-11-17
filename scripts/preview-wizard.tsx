/**
 * Dev-only: mounts the project wizard in a plain page with a stubbed IPC
 * bridge, so the four steps can be reviewed and screenshotted without
 * launching Electron or touching a real project.
 *
 *   npx vite build --config scripts/preview-wizard.config.mjs
 *   python3 -m http.server 8766 -d scripts/.preview
 *   # then open http://localhost:8766/preview-wizard.html?step=0
 *
 * `?step=N` drives the wizard to that step by clicking the primary button, so
 * every screen can be captured headlessly.
 */
import { createRoot } from 'react-dom/client'
import { ProjectWizard } from '../src/renderer/src/components/ProjectWizard'
import type { OnboardingAnswers, OnboardingPlan } from '../src/shared/ipc'

const workspace = '/Users/carlolomello/Desktop/VSCodePlugions/sfdc-atlas'

const plan: OnboardingPlan = {
  agentsMdPath: `${workspace}/AGENTS.md`,
  agentsMdExists: false,
  agentsMd: [
    '# sfdc-atlas',
    '',
    'Estensione VS Code che organizza e naviga i metadati Salesforce (SFDX).',
    '',
    '## Stack',
    '',
    '- Linguaggi: TypeScript',
    '- Package manager: pnpm',
    '- Repository git: sì',
    '',
    '## Comandi',
    '',
    '- `pnpm typecheck`',
    '- `pnpm test`',
    '- `pnpm build`',
    '',
    '## Regole',
    '',
    '- Prima di modificare un file, leggilo.',
    '- Dopo una modifica, verifica con il comando più stretto disponibile.',
    '- Non modificare i test per farli passare: correggi il codice.',
    ''
  ].join('\n'),
  autoApproveCommands: ['pnpm typecheck', 'pnpm test', 'pnpm build'],
  skills: [
    {
      id: 'verify-before-commit',
      name: 'verify-before-commit',
      description: 'La sequenza di verifica da eseguire prima di dire che una modifica è pronta',
      origin: 'catalog',
      warnings: [],
      body: '# Prima di consegnare\n\n- `pnpm typecheck`\n- `pnpm test`\n\nSe un test fallisce, correggi la causa.'
    },
    {
      id: 'review-diff',
      name: 'review-diff',
      description: 'Come rivedere un diff prima di consegnarlo, con i problemi in file:riga',
      origin: 'catalog',
      warnings: [],
      body: '# Revisione di un diff\n\n1. `git status` e `git diff`.\n2. Un problema per riga.'
    },
    {
      id: 'run-typecheck',
      name: 'run-typecheck',
      description: 'Come lanciare e interpretare `pnpm typecheck` in questo progetto',
      origin: 'generated',
      warnings: ['rm -rf out'],
      body: '# typecheck\n\nEsegui `pnpm typecheck` e leggi l’output per intero.'
    }
  ]
}

const stub = {
  onboardingFacts: async () => ({
    workspace,
    languages: ['TypeScript', 'CSS'],
    packageManager: 'pnpm',
    commands: ['pnpm typecheck', 'pnpm test', 'pnpm build'],
    files: 214,
    truncated: false,
    isGit: true,
    hasMemory: false,
    skillCount: 0,
    needsOnboarding: true
  }),
  onboardingPreview: async (_payload: { workspace: string; answers: OnboardingAnswers }) => plan,
  onboardingApply: async () => ({
    written: [`${workspace}/AGENTS.md`, `${workspace}/.charliecode/skills/verify-before-commit/SKILL.md`],
    skipped: [],
    skills: [],
    autoApprove: ['pnpm typecheck', 'pnpm test']
  }),
  onboardingSkip: async () => undefined
}

;(window as unknown as { charliecode: unknown }).charliecode = stub

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function drive(target: number): Promise<void> {
  for (let i = 0; i < target; i++) {
    await wait(250)
    const button = document.querySelector<HTMLButtonElement>('.wizard-nav button.primary')
    button?.click()
  }
}

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(
  <ProjectWizard
    workspace={workspace}
    onClose={() => undefined}
    onApplied={async () => undefined}
  />
)

void drive(Number(new URLSearchParams(location.search).get('step') ?? 0))
