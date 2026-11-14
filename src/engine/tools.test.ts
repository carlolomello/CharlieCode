import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlatform } from './platform'
import { buildTools, DeniedError, resolveWorkspacePath, toolLogFromEvent, type ToolRuntime } from './tools'
import type { EngineEvent, PermissionDecision, PermissionRequest } from './types'

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

  it('DeniedError è un errore riconoscibile', () => {
    expect(new DeniedError()).toBeInstanceOf(Error)
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
