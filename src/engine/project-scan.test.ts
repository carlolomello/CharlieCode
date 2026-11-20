import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectCommands, readPackageJson } from './project-scan'

describe('detectCommands', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('non inventa npm test per un package.json senza script test', async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-scan-'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))

    const pkg = await readPackageJson(dir)
    expect(detectCommands(dir, pkg, [])).toEqual([])
  })

  it('propone solo gli script presenti, nell’ordine di verifica', () => {
    expect(
      detectCommands('/progetto', { scripts: { test: 'vitest', lint: 'eslint' } }, [])
    ).toEqual(['npm lint', 'npm test'])
  })

  it('riconosce pytest da pyproject.toml', () => {
    expect(detectCommands('/progetto', undefined, ['pyproject.toml'])).toEqual(['pytest -q'])
  })
})
