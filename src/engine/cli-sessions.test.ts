import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearCliSession, hasCliSession, markCliSession } from './cli-sessions'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'charliecode-cli-sessions-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('CLI sessions', () => {
  it('remembers a session for the workspace it was started in', async () => {
    const workspace = join(dir, 'project')
    expect(await hasCliSession(dir, 'axet', workspace)).toBe(false)

    await markCliSession(dir, 'axet', workspace)
    expect(await hasCliSession(dir, 'axet', workspace)).toBe(true)
  })

  it('does not reuse a session in a different project', async () => {
    await markCliSession(dir, 'axet', join(dir, 'one'))
    expect(await hasCliSession(dir, 'axet', join(dir, 'two'))).toBe(false)
  })

  it('keeps one record per profile', async () => {
    const workspace = join(dir, 'project')
    await markCliSession(dir, 'axet', workspace)
    expect(await hasCliSession(dir, 'opencode', workspace)).toBe(false)
  })

  it('forgets a session that is gone', async () => {
    const workspace = join(dir, 'project')
    await markCliSession(dir, 'axet', workspace)
    await clearCliSession(dir, 'axet')
    expect(await hasCliSession(dir, 'axet', workspace)).toBe(false)
  })

  it('treats a missing or corrupt file as "no session"', async () => {
    expect(await hasCliSession(join(dir, 'nowhere'), 'axet', dir)).toBe(false)
    await markCliSession(dir, 'axet', dir)
    // The read path never throws, whatever the file contains.
    expect(await hasCliSession(dir, 'axet', dir)).toBe(true)
  })
})
