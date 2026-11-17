import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { beforeEach, describe, expect, it } from 'vitest'
import { changeDiff, listChanges, revertChange, workspacePath } from './changes'

const run = promisify(execFile)

/**
 * These tests use a real git repository: the whole point of the panel is that it
 * reports what git says, so mocking git would test nothing.
 */
describe('changes', () => {
  let root: string
  let repo: string

  async function git(args: string[]): Promise<string> {
    const { stdout } = await run(
      'git',
      ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args],
      { maxBuffer: 4 * 1024 * 1024 }
    )
    return stdout
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'charliecode-changes-'))
    repo = join(root, 'repo')
    await mkdir(repo, { recursive: true })
    await git(['init', '-q'])
    await writeFile(join(repo, 'a.ts'), 'export const a = 1\n', 'utf8')
    await writeFile(join(repo, 'b.ts'), 'export const b = 2\nexport const c = 3\n', 'utf8')
    await git(['add', '.'])
    await git(['commit', '-q', '-m', 'init'])
  })

  it('lists modified, untracked and deleted files with real counts', async () => {
    await writeFile(join(repo, 'a.ts'), 'export const a = 1\nexport const extra = 2\n', 'utf8')
    await writeFile(join(repo, 'new.ts'), 'uno\ndue\ntre\n', 'utf8')
    await rm(join(repo, 'b.ts'))

    const result = await listChanges(repo)
    expect(result.git).toBe(true)

    const byPath = new Map(result.changes.map((change) => [change.path, change]))
    expect(byPath.get('a.ts')?.status).toBe('modified')
    expect(byPath.get('a.ts')?.added).toBe(1)
    expect(byPath.get('a.ts')?.removed).toBe(0)
    expect(byPath.get('new.ts')?.status).toBe('untracked')
    expect(byPath.get('new.ts')?.added).toBe(3)
    expect(byPath.get('b.ts')?.status).toBe('deleted')
    expect(byPath.get('b.ts')?.removed).toBe(2)
  })

  it('returns the unified diff of one file, with hunks', async () => {
    await writeFile(join(repo, 'a.ts'), 'export const a = 1\nexport const extra = 2\n', 'utf8')

    const diff = await changeDiff(repo, 'a.ts')
    expect(diff.added).toBe(1)
    expect(diff.unified).toContain('@@')
    expect(diff.unified).toContain('+export const extra = 2')
  })

  it('shows an untracked file as a new file', async () => {
    await writeFile(join(repo, 'new.ts'), 'uno\ndue\n', 'utf8')

    const diff = await changeDiff(repo, 'new.ts')
    expect(diff.created).toBe(true)
    expect(diff.added).toBe(2)
  })

  it('reverts a tracked file to HEAD and deletes a new one', async () => {
    await writeFile(join(repo, 'a.ts'), 'sporca\n', 'utf8')
    await writeFile(join(repo, 'new.ts'), 'nuovo\n', 'utf8')

    await revertChange(repo, { path: 'a.ts', status: 'modified' })
    await revertChange(repo, { path: 'new.ts', status: 'untracked' })

    expect(await readFile(join(repo, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(existsSync(join(repo, 'new.ts'))).toBe(false)
    expect((await listChanges(repo)).changes).toHaveLength(0)
  })

  it('handles a rename', async () => {
    await git(['mv', 'b.ts', 'c.ts'])

    const result = await listChanges(repo)
    const renamed = result.changes.find((change) => change.status === 'renamed')
    expect(renamed?.path).toBe('c.ts')
    expect(renamed?.from).toBe('b.ts')
  })

  it('refuses a path outside the workspace', () => {
    expect(() => workspacePath(repo, '../segreto.txt')).toThrow(/fuori dal progetto/)
    expect(() => workspacePath(repo, '/etc/passwd')).toThrow(/fuori dal progetto/)
    expect(workspacePath(repo, 'src/a.ts')).toBe(join(repo, 'src', 'a.ts'))
  })

  it('says so when the folder is not a git repository', async () => {
    const plain = join(root, 'plain')
    await mkdir(plain, { recursive: true })
    await writeFile(
      join(plain, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
      'utf8'
    )

    const result = await listChanges(plain)
    expect(result.git).toBe(false)
    expect(result.changes).toEqual([])
    // The preview hint still works: it only needs package.json.
    expect(result.previewScripts).toEqual(['dev'])
    expect(result.previewUrl).toBe('http://localhost:5173')
  })

  it('reads the port from the script when it is written there', async () => {
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { dev: 'next dev --port 4321' }, dependencies: { next: '15' } }),
      'utf8'
    )

    const result = await listChanges(repo)
    expect(result.previewUrl).toBe('http://localhost:4321')
  })
})
