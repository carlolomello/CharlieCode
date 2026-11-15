import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  enabledPluginIds,
  ensureProjectMemory,
  pluginSystemPrompt,
  projectMemoryPath,
  readProjectMemory,
  recordTurn,
  rememberNote,
  resolvePlugins
} from './plugins'
import { suggestSetup } from './advisor'
import type { CharlieCodeConfig } from './types'
import { defaultConfig } from './config'

let workspace: string

const configWith = (plugins: Record<string, { enabled: boolean }>): CharlieCodeConfig => ({
  ...defaultConfig(),
  plugins
})

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'charliecode-plugins-'))
})

afterEach(async () => {
  // mkdtemp dirs live in the OS temp folder; leaving them is harmless.
})

describe('plugin resolution', () => {
  it('ships every built-in plugin enabled by default', () => {
    const ids = enabledPluginIds(defaultConfig())
    expect(ids).toContain('memory')
    expect(ids).toContain('advisor')
    expect(ids).toContain('reach')
  })

  it('respects an explicit switch', () => {
    const config = configWith({ memory: { enabled: false } })
    const memory = resolvePlugins(config).find((plugin) => plugin.id === 'memory')
    expect(memory?.enabled).toBe(false)
    expect(enabledPluginIds(config)).not.toContain('memory')
    expect(enabledPluginIds(config)).toContain('advisor')
  })
})

describe('project memory', () => {
  it('creates the template on demand', async () => {
    const path = await ensureProjectMemory(workspace)
    expect(path).toBe(projectMemoryPath(workspace))
    const content = await readFile(path, 'utf8')
    expect(content).toContain('# Memoria del progetto')
    expect(content).toContain('## Attività recente')
  })

  it('keeps notes and recent turns newest first', async () => {
    await ensureProjectMemory(workspace)
    await rememberNote(workspace, 'Il comando di test è `pnpm test`.')
    await recordTurn(workspace, { request: 'sistemare il parser', files: ['src/parser.ts'] })
    await recordTurn(workspace, { request: 'aggiungere i test', files: [] })

    const memory = (await readProjectMemory(workspace)) ?? ''
    expect(memory).toContain('Il comando di test è')
    const recent = memory.slice(memory.indexOf('## Attività recente'))
    expect(recent.indexOf('aggiungere i test')).toBeLessThan(recent.indexOf('sistemare il parser'))
    expect(memory).toContain('src/parser.ts')
  })

  it('caps the diary so the prompt stays small', async () => {
    await ensureProjectMemory(workspace)
    for (let i = 0; i < 30; i += 1) {
      await recordTurn(workspace, { request: `turno ${i}`, files: [] })
    }
    const memory = (await readProjectMemory(workspace)) ?? ''
    const lines = memory
      .slice(memory.indexOf('## Attività recente'))
      .split('\n')
      .filter((line) => line.startsWith('- '))
    expect(lines.length).toBeLessThanOrEqual(12)
    expect(memory).toContain('turno 29')
    expect(memory).not.toContain('turno 0 ')
  })

  it('returns undefined when there is no memory yet', async () => {
    expect(await readProjectMemory(workspace)).toBeUndefined()
  })
})

describe('prompt contribution', () => {
  it('injects the memory only when the plugin is on', async () => {
    await ensureProjectMemory(workspace)
    await rememberNote(workspace, 'Il progetto usa pnpm e Vite.')

    const on = await pluginSystemPrompt(defaultConfig(), workspace)
    expect(on).toContain('<memoria>')
    expect(on).toContain('pnpm e Vite')
    expect(on).toContain('fetch_url')

    const off = await pluginSystemPrompt(
      configWith({ memory: { enabled: false }, advisor: { enabled: false }, reach: { enabled: false } }),
      workspace
    )
    expect(off).toBe('')
  })
})

describe('setup advisor', () => {
  it('detects commands, missing AGENTS.md and suggests skills', async () => {
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'src', 'index.ts'), 'export const a = 1\n', 'utf8')
    await writeFile(
      join(workspace, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@9.0.0',
        scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' }
      }),
      'utf8'
    )

    const report = await suggestSetup(workspace)
    expect(report.markdown).toContain('pnpm test')
    expect(report.markdown).toContain('pnpm typecheck')
    expect(report.markdown).toContain('AGENTS.md assente')
    expect(report.markdown).toContain('typecheck')
    expect(report.autoApproveCommands).toContain('pnpm test')
  })

  it('notices an existing AGENTS.md and memory file', async () => {
    await writeFile(join(workspace, 'AGENTS.md'), '# regole\n', 'utf8')
    await ensureProjectMemory(workspace)

    const report = await suggestSetup(workspace)
    expect(report.markdown).toContain('AGENTS.md')
    expect(report.markdown).not.toContain('AGENTS.md assente')
    expect(report.markdown).toContain('Memoria del progetto: presente')
  })
})
