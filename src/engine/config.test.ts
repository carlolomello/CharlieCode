import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config'
import { createPlatform } from './platform'

/**
 * `CHARLIECODE_BASE_URL` is how CI and the docs point the engine at the mock
 * router, so it has to do two things: rewrite the router URL *and* turn the
 * router on. A fresh config ships every provider disabled (the app starts
 * clean), which used to make the env var silently useless.
 */
describe('CHARLIECODE_BASE_URL', () => {
  let dir: string
  const previous = process.env.CHARLIECODE_BASE_URL

  const platform = (): ReturnType<typeof createPlatform> =>
    createPlatform({ id: 'darwin', env: { HOME: dir, CHARLIECODE_CONFIG_DIR: dir } })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-config-'))
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.CHARLIECODE_BASE_URL
    else process.env.CHARLIECODE_BASE_URL = previous
  })

  it('riscrive l’URL del router e lo abilita', async () => {
    process.env.CHARLIECODE_BASE_URL = 'http://localhost:3999/v1'
    const { config } = await loadConfig(platform())

    const router = config.providers.find((provider) => provider.id === 'freellmapi')
    expect(router?.baseUrl).toBe('http://localhost:3999/v1')
    expect(router?.enabled).toBe(true)
  })

  it('non tocca i provider diretti', async () => {
    process.env.CHARLIECODE_BASE_URL = 'http://localhost:3999/v1'
    const { config } = await loadConfig(platform())

    const direct = config.providers.find((provider) => provider.id === 'openrouter')
    expect(direct?.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(direct?.enabled).toBe(false)
  })

  it('senza variabile lascia tutto spento', async () => {
    delete process.env.CHARLIECODE_BASE_URL
    const { config } = await loadConfig(platform())

    expect(config.providers.every((provider) => !provider.enabled)).toBe(true)
  })

  it('recupera una config corrotta e ne conserva un backup', async () => {
    const p = platform()
    await mkdir(p.configDir, { recursive: true })
    await writeFile(p.configPath('config.json'), '{ non è json', 'utf8')

    const result = await loadConfig(p)
    expect(result.recovered).toContain('config.json.corrupt-')
    expect(result.config.version).toBe(1)

    const files = await readdir(p.configDir)
    expect(files.some((name) => name.startsWith('config.json.corrupt-'))).toBe(true)

    const repaired = JSON.parse(await readFile(p.configPath('config.json'), 'utf8')) as {
      version: number
    }
    expect(repaired.version).toBe(1)
  })
})
