import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlatform } from './platform'
import {
  buildTools,
  DeniedError,
  isPrivateAddress,
  isRiskyRegex,
  matchesApprovedCommand,
  resolveWorkspacePath,
  toolLogFromEvent,
  type ToolRuntime
} from './tools'
import { defaultConfig } from './config'
import type { AppConfigPatch } from './app-config'
import type { EngineEvent, ModelEntry, PermissionDecision, PermissionRequest } from './types'

type AnyTool = { execute?: (input: unknown, options?: unknown) => Promise<unknown> }

let workspace: string
let events: EngineEvent[]
let decision: PermissionDecision
let requests: PermissionRequest[]

function runtime(overrides: Partial<ToolRuntime> = {}): ToolRuntime {
  return {
    platform: createPlatform({ id: 'darwin', env: { HOME: workspace } }),
    workspace,
    depth: 0,
    autoApprove: [],
    autoApproveCommands: [],
    askPermission: async (request) => {
      requests.push(request)
      return decision
    },
    emit: (event) => events.push(event),
    runSubagent: async () => ({ ok: true, text: 'fatto', summary: 'fatto' }),
    ...overrides
  }
}

function tool(name: string, runtimeValue: ToolRuntime): AnyTool {
  return (buildTools(runtimeValue) as unknown as Record<string, AnyTool>)[name]!
}

async function run(name: string, input: unknown, runtimeValue = runtime()): Promise<string> {
  return String(await tool(name, runtimeValue).execute?.(input))
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'charliecode-tools-'))
  events = []
  requests = []
  decision = 'allow'
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('resolveWorkspacePath', () => {
  it('risolve percorsi relativi e segnala quelli fuori dal progetto', () => {
    const inside = resolveWorkspacePath(runtime(), 'src/app.ts')
    expect(inside.rel).toBe('src/app.ts')
    expect(inside.outside).toBe(false)

    const outside = resolveWorkspacePath(runtime(), '../../etc/passwd')
    expect(outside.outside).toBe(true)
  })
})

describe('file tools', () => {
  it('scrive un file e restituisce un diff di creazione', async () => {
    await run('write', { path: 'note.txt', content: 'ciao\n' })
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('ciao\n')

    const result = events.find((event) => event.type === 'tool-result')
    expect(result && result.type === 'tool-result' ? result.diff?.created : undefined).toBe(true)
  })

  it('legge un file esistente', async () => {
    await writeFile(join(workspace, 'a.txt'), 'riga uno\nriga due\n')
    const output = await run('read', { path: 'a.txt' })
    expect(output).toContain('riga uno')
    expect(output).toContain('riga due')
  })

  it('preserva i fine riga CRLF quando riscrive un file esistente', async () => {
    await writeFile(join(workspace, 'win.txt'), 'a\r\nb\r\n')
    await run('write', { path: 'win.txt', content: 'a\nb\nc\n' })
    expect(await readFile(join(workspace, 'win.txt'), 'utf8')).toBe('a\r\nb\r\nc\r\n')
  })

  it('trova i file con glob e il testo con grep', async () => {
    await writeFile(join(workspace, 'one.ts'), 'export const x = 1\n')
    await writeFile(join(workspace, 'two.ts'), 'export const y = 2\n')

    expect(await run('glob', { pattern: '*.ts' })).toContain('one.ts')
    expect(await run('grep', { pattern: 'const y' })).toContain('two.ts')
  })
})

describe('permissions', () => {
  it('blocca la scrittura quando l’utente nega', async () => {
    decision = 'deny'
    await expect(run('write', { path: 'denied.txt', content: 'no' })).resolves.toContain('negat')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tool).toBe('write')

    const denied = events.find((event) => event.type === 'tool-result')
    expect(denied && denied.type === 'tool-result' ? denied.denied : undefined).toBe(true)
  })

  it('non chiede permesso per i tool in autoApprove', async () => {
    await writeFile(join(workspace, 'auto.txt'), 'x')
    await run('read', { path: 'auto.txt' }, runtime({ autoApprove: ['read'] }))
    expect(requests).toHaveLength(0)
  })

  it('chiede sempre permesso per una lettura fuori dal progetto', async () => {
    decision = 'deny'
    const output = await run(
      'read',
      { path: '../../etc/passwd' },
      runtime({ autoApprove: ['read'] })
    )
    expect(output).toContain('negat')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tool).toBe('read')
    expect(requests[0]?.risk).toBe('high')
  })

  it('un comando composto non eredita l’auto-approvazione del prefisso', async () => {
    decision = 'deny'
    const output = await run(
      'bash',
      { command: 'git status && echo pwned' },
      runtime({ autoApproveCommands: ['git status'] })
    )
    expect(output).toContain('negat')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.command).toBe('git status && echo pwned')
  })

  it('un comando singolo con lo stesso prefisso resta auto-approvato', () => {
    expect(matchesApprovedCommand('git status --short', ['git status'])).toBe(true)
    expect(matchesApprovedCommand('git status', ['git status'])).toBe(true)
    expect(matchesApprovedCommand('git statusx', ['git status'])).toBe(false)
    expect(matchesApprovedCommand('git status | sh', ['git status'])).toBe(false)
    expect(matchesApprovedCommand('git status; rm -rf /', ['git status'])).toBe(false)
    expect(matchesApprovedCommand('git commit -m "a; b"', ['git commit'])).toBe(true)
  })

  it('DeniedError è un errore riconoscibile', () => {
    expect(new DeniedError()).toBeInstanceOf(Error)
  })
})

describe('sandbox', () => {
  it('chiede permesso quando un symlink esce dal progetto', async () => {
    // Creating symlinks on Windows needs privileges; the CI there skips this.
    if (process.platform === 'win32') return
    const outside = await mkdtemp(join(tmpdir(), 'charliecode-outside-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'top secret')
      await symlink(outside, join(workspace, 'link'), 'dir')

      decision = 'deny'
      const output = await run(
        'read',
        { path: 'link/secret.txt' },
        runtime({ autoApprove: ['read'] })
      )

      expect(output).toContain('negat')
      expect(requests).toHaveLength(1)
      expect(requests[0]?.risk).toBe('high')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('non legge il file delle credenziali nemmeno con autoApprove', async () => {
    const rt = runtime({ autoApprove: ['read'] })
    const credentials = rt.platform.configPath('credentials.json')
    await mkdir(dirname(credentials), { recursive: true })
    await writeFile(credentials, '{"openai":{"apiKey":"sk-test"}}')

    const output = await run('read', { path: credentials }, rt)
    expect(output).toContain('credenziali')
    expect(requests).toHaveLength(0)
  })

  it('una scrittura fuori dal progetto chiede sempre permesso', async () => {
    const name = `escape-${Date.now()}.txt`
    decision = 'deny'

    const output = await run(
      'write',
      { path: `../${name}`, content: 'no' },
      runtime({ autoApprove: ['write'] })
    )

    expect(output).toContain('negat')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.risk).toBe('high')
    expect(existsSync(join(workspace, '..', name))).toBe(false)
  })

  it('remember mostra un diff e chiede permesso', async () => {
    const output = await run(
      'remember',
      { note: 'Usa pnpm, non npm.' },
      runtime({ plugins: ['memory'] })
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]?.tool).toBe('remember')
    expect(requests[0]?.diff?.unified).toContain('pnpm')
    expect(output).toContain('Nota salvata')
    expect(await readFile(join(workspace, '.charliecode', 'memory.md'), 'utf8')).toContain('pnpm')
  })

  it('se l’utente nega, remember non crea nemmeno il file', async () => {
    decision = 'deny'
    const output = await run(
      'remember',
      { note: 'Non salvarmi.' },
      runtime({ plugins: ['memory'] })
    )

    expect(output).toContain('negat')
    expect(existsSync(join(workspace, '.charliecode', 'memory.md'))).toBe(false)
  })
})

describe('regex e rete', () => {
  it('rifiuta i quantificatori annidati', () => {
    expect(isRiskyRegex('(a+)+')).toBe(true)
    expect(isRiskyRegex('a+')).toBe(false)
  })

  it('riconosce indirizzi privati e pubblici', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false)
  })
})

describe('charliecode_config', () => {
  const model: ModelEntry = {
    key: 'openai::gpt-4.1',
    providerId: 'openai',
    providerLabel: 'OpenAI',
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    caps: { tools: true, vision: false, contextWindow: 128_000 },
    capsConfidence: 'manual',
    effort: 'none',
    efforts: ['none', 'low', 'high', 'max']
  }

  function selfRuntime(overrides: Partial<ToolRuntime> = {}): ToolRuntime {
    const config = defaultConfig()
    config.defaultModel = 'openai::gpt-4.1'
    return runtime({ config, models: [model], appVersion: '0.0.1', ...overrides })
  }

  it('legge lo stato dell’app con le chiavi modello valide', async () => {
    const output = await run('charliecode_config', { action: 'read' }, selfRuntime())
    expect(output).toContain('CONFIGURAZIONE DI CHARLIECODE')
    expect(output).toContain('openai::gpt-4.1')
    expect(output).toContain('modello predefinito: openai::gpt-4.1')
  })

  it('applica un patch dopo il permesso e restituisce il diff', async () => {
    let applied: AppConfigPatch | undefined
    const output = await run(
      'charliecode_config',
      { action: 'apply', patch: { effort: 'high' } },
      selfRuntime({
        applyConfig: async (patch) => {
          applied = patch
          return {
            config: defaultConfig(),
            path: '/tmp/config.json',
            summary: 'effort predefinito: none → high'
          }
        }
      })
    )

    expect(applied).toEqual({ effort: 'high' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tool).toBe('config')
    expect(requests[0]?.diff?.unified).toContain('high')
    expect(output).toContain('Configurazione salvata')
  })

  it('se l’utente nega, non salva nulla', async () => {
    decision = 'deny'
    let applied = false
    const output = await run(
      'charliecode_config',
      { action: 'apply', patch: { effort: 'high' } },
      selfRuntime({
        applyConfig: async () => {
          applied = true
          return { config: defaultConfig(), path: '/tmp/config.json', summary: '' }
        }
      })
    )

    expect(output).toContain('negat')
    expect(applied).toBe(false)
  })

  it('in modalità piano legge ma non scrive', async () => {
    const read = await run('charliecode_config', { action: 'read' }, selfRuntime({ readOnly: true }))
    expect(read).toContain('CONFIGURAZIONE DI CHARLIECODE')

    const write = await run(
      'charliecode_config',
      { action: 'apply', patch: { effort: 'high' } },
      selfRuntime({ readOnly: true })
    )
    expect(write).toContain('modalità piano')
    expect(requests).toHaveLength(0)
  })

  it('rifiuta un modello che non è nel catalogo del turno', async () => {
    const output = await run(
      'charliecode_config',
      { action: 'apply', patch: { defaultModel: 'ghost::model' } },
      selfRuntime({
        applyConfig: async () => ({
          config: defaultConfig(),
          path: '/tmp/config.json',
          summary: ''
        })
      })
    )
    expect(output).toContain('sconosciuto')
    expect(requests).toHaveLength(0)
  })

  it('non compare nei subagenti', () => {
    const tools = buildTools(selfRuntime({ depth: 1 })) as unknown as Record<string, unknown>
    expect(tools.charliecode_config).toBeUndefined()
  })
})

describe('toolLogFromEvent', () => {
  it('crea una riga running e la completa con il risultato', () => {
    const start = toolLogFromEvent(
      { type: 'tool-call', id: 't1', name: 'read', title: 'read · a.txt' },
      []
    )
    expect(start).toHaveLength(1)
    expect(start[0]?.status).toBe('running')

    const done = toolLogFromEvent(
      { type: 'tool-result', id: 't1', name: 'read', ok: true, summary: 'ok', ms: 12 },
      start
    )
    expect(done[0]?.status).toBe('ok')
    expect(done[0]?.ms).toBe(12)
  })
})
