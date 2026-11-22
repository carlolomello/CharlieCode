import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Writes a file through a temporary sibling and a rename.
 *
 * The rename is the fragile step on Windows: a virus scanner, the search
 * indexer or any other handle on the destination makes it fail with `EPERM`
 * even though the app owns the file. A failed save used to abort the whole
 * turn ("Error invoking remote method 'charliecode:chat:start': EPERM ...
 * rename"), so the rename is retried, then replaced by an in-place write:
 * losing atomicity is better than losing the message.
 */

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST', 'ENOENT'])

function isRetryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && RETRYABLE.has(code)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function write(path: string, content: string, mode?: number): Promise<void> {
  await writeFile(path, content, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) })
}

/**
 * Creates the folder the file lives in. The callers that matter already do it,
 * but a first run on a machine whose config folder does not exist yet (a fresh
 * HOME, a portable install) used to fail on the rename with `ENOENT`.
 */
async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined)
}

export interface WriteFileOptions {
  /** Permission bits, applied to the final file. */
  mode?: number
}

export async function writeFileAtomic(
  path: string,
  content: string,
  options: WriteFileOptions = {}
): Promise<void> {
  await ensureParent(path)
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await write(temp, content, options.mode)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(temp, path)
      if (options.mode !== undefined) await chmod(path, options.mode).catch(() => undefined)
      return
    } catch (error) {
      if (!isRetryable(error)) {
        await rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
      // The folder can be gone (a cleaned home, a folder removed while the app
      // was writing), and a read-only destination also makes Windows refuse
      // the rename: recreate it, clear the attribute and try again.
      await ensureParent(path)
      if (attempt >= 1) {
        await chmod(path, 0o666).catch(() => undefined)
        await rm(path, { force: true }).catch(() => undefined)
      }
      await delay(25 * (attempt + 1))
    }
  }

  // The destination stayed locked (an indexer, a backup tool, a second writer).
  // Writing in place keeps the conversation usable; the temporary file is
  // removed either way.
  await ensureParent(path)
  try {
    await write(path, content, options.mode)
  } catch (error) {
    if (!isRetryable(error)) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    await chmod(path, 0o666).catch(() => undefined)
    await write(path, content, options.mode)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }

  if (options.mode !== undefined) await chmod(path, options.mode).catch(() => undefined)
}
