import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-write'

/**
 * Whether a CLI still holds the conversation for a workspace.
 *
 * A CLI is a new process every turn, so without a session the whole history is
 * written into the prompt again: on a long chat that is the largest part of
 * what the user pays for. A profile that declares `continueArgs` (`--continue`)
 * lets the CLI keep its own session; this file records that the session exists
 * and where it was started, so the next turn can send only the new request.
 *
 * The record is per profile and per workspace, because a CLI session belongs to
 * the folder it was started in. It is dropped as soon as a turn shows the
 * session is gone (new install, cleaned cache, CLI updated): the turn is then
 * repeated with the full briefing instead of failing.
 */

const SESSION_FILE = 'cli-sessions.json'

interface SessionRecord {
  /** Absolute workspace the session was started in, normalized. */
  workspace: string
  /** ISO timestamp of the last turn that succeeded in that session. */
  at: string
}

type SessionFile = Record<string, SessionRecord>

/** Case-insensitive on the platforms whose file systems are. */
function workspaceKey(workspace: string): string {
  const absolute = resolve(workspace)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function pathOf(stateDir: string): string {
  return join(stateDir, SESSION_FILE)
}

async function readAll(stateDir: string): Promise<SessionFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pathOf(stateDir), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const records: SessionFile = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as Record<string, unknown> | null
      if (!record || typeof record.workspace !== 'string') continue
      records[id] = {
        workspace: record.workspace,
        at: typeof record.at === 'string' ? record.at : new Date(0).toISOString()
      }
    }
    return records
  } catch {
    // No file yet, or one we cannot read: the next turn pays the briefing,
    // which is the safe direction.
    return {}
  }
}

/** Writes are serialised: a team turn can finish several CLI processes. */
let writeChain: Promise<void> = Promise.resolve()

function enqueue(work: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(work).catch(() => undefined)
  return writeChain
}

export async function hasCliSession(
  stateDir: string,
  profileId: string,
  workspace: string
): Promise<boolean> {
  const record = (await readAll(stateDir))[profileId]
  return Boolean(record) && record!.workspace === workspaceKey(workspace)
}

export async function markCliSession(
  stateDir: string,
  profileId: string,
  workspace: string
): Promise<void> {
  await enqueue(async () => {
    const all = await readAll(stateDir)
    all[profileId] = { workspace: workspaceKey(workspace), at: new Date().toISOString() }
    await mkdir(stateDir, { recursive: true })
    await writeFileAtomic(pathOf(stateDir), `${JSON.stringify(all, null, 2)}\n`)
  })
}

export async function clearCliSession(stateDir: string, profileId: string): Promise<void> {
  await enqueue(async () => {
    const all = await readAll(stateDir)
    if (!(profileId in all)) return
    delete all[profileId]
    await mkdir(stateDir, { recursive: true })
    await writeFileAtomic(pathOf(stateDir), `${JSON.stringify(all, null, 2)}\n`)
  })
}
