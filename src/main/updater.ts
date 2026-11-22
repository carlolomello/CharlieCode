import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, net, shell } from 'electron'
import type { UpdateCheckResult, UpdateStatus } from '../shared/ipc'
import {
  decideUpdate,
  parseRelease,
  sha256FromDigest,
  summarizeReleaseNotes,
  type ReleaseAsset,
  type ReleaseInfo,
  type UpdateCandidate
} from './update-check'

/**
 * The update check that runs when the app opens.
 *
 * It reads the release of this repository, picks the installer for this
 * machine and — only after the user says yes — downloads it and installs it:
 * the dmg is mounted and the bundle replaced on macOS, the NSIS installer runs
 * silently on Windows. Both paths end with the app relaunching itself.
 *
 * Nothing here talks to the network before `checkForUpdates` is called, and a
 * failed check is silent: being offline is not an error to show on startup.
 */

const RELEASES = 'https://api.github.com/repos/carlolomello/CharlieCode/releases/latest'
const RELEASE_PAGE = 'https://github.com/carlolomello/CharlieCode/releases'
const STATE_FILE = 'updates.json'
/** The renderer gets a progress event at most this often. */
const PROGRESS_EVERY_MS = 250

declare const __BUILD_TIME__: string

interface UpdateState {
  /** An asset the user said "later" to. A newer build asks again. */
  dismissedAssetId?: number
  /** The asset this copy was installed from, once an update has run. */
  installedAssetId?: number
  checkedAt?: string
}

export interface UpdateContext {
  window: BrowserWindow | null
  configPath: (...segments: string[]) => string
  send: (status: UpdateStatus) => void
  /** Markdown of the release, shown as a short excerpt in the dialog. */
  releaseNotes?: string
}

function buildTime(): string {
  try {
    return __BUILD_TIME__
  } catch {
    // A build without the define (an old installer) simply has no stamp.
    return new Date().toISOString()
  }
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'data sconosciuta'
  return date.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' })
}

async function readState(context: UpdateContext): Promise<UpdateState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(context.configPath(STATE_FILE), 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as UpdateState) : {}
  } catch {
    return {}
  }
}

async function writeState(context: UpdateContext, state: UpdateState): Promise<void> {
  const file = context.configPath(STATE_FILE)
  // On a first run the config folder may not exist yet. Losing this file would
  // mean forgetting "più tardi" and the asset just installed, which is what
  // keeps the app from offering itself in a loop.
  await mkdir(dirname(file), { recursive: true }).catch(() => undefined)
  await writeFile(file, JSON.stringify(state, null, 2), 'utf8').catch(() => undefined)
}

async function fetchRelease(): Promise<ReleaseInfo | undefined> {
  const response = await net.fetch(RELEASES, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'CharlieCode'
    }
  })
  if (!response.ok) return undefined
  return parseRelease(await response.json())
}

/** Runs a command and resolves with its output, or rejects with the reason. */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`${basename(command)}: uscita ${code} ${output.slice(-300)}`.trim()))
    })
  })
}

/**
 * Deletes a tree that lives next to the app bundle.
 *
 * Deliberately not `fs.rm`: Electron patches `fs` to treat a `.asar` as a
 * folder, so removing an app bundle from inside the app stops at
 * `Contents/Resources/app.asar` and leaves half a backup behind. `/bin/rm`
 * does not know about asar and deletes the tree it is given.
 */
async function removeTree(path: string): Promise<void> {
  if (process.platform === 'win32') {
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }).catch(
      () => undefined
    )
    return
  }
  await run('rm', ['-rf', path]).catch(() => undefined)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function download(
  asset: ReleaseAsset,
  target: string,
  onProgress: (received: number, total: number) => void
): Promise<void> {
  const response = await net.fetch(asset.url, { headers: { 'User-Agent': 'CharlieCode' } })
  if (!response.ok || !response.body) {
    throw new Error(`Download non riuscito (HTTP ${response.status}).`)
  }

  const header = Number(response.headers.get('content-length') ?? '')
  const total = Number.isFinite(header) && header > 0 ? header : asset.size
  const file = createWriteStream(target)
  const reader = response.body.getReader()
  let received = 0
  let lastReport = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.byteLength
      if (!file.write(Buffer.from(value))) await once(file, 'drain')
      const now = Date.now()
      if (now - lastReport >= PROGRESS_EVERY_MS) {
        lastReport = now
        onProgress(received, total)
      }
    }
    await new Promise<void>((resolve, reject) => {
      file.end((error?: Error | null) => (error ? reject(error) : resolve()))
    })
  } catch (error) {
    file.destroy()
    await rm(target, { force: true }).catch(() => undefined)
    throw error
  }

  // A truncated download must never reach the installer.
  if (asset.size > 0 && received < asset.size) {
    await rm(target, { force: true }).catch(() => undefined)
    throw new Error('Il download si è interrotto prima della fine del file.')
  }
  onProgress(received, total || received)
  await verifyDigest(target, asset)
}

/**
 * Compares the file with the checksum GitHub computed when the asset was
 * uploaded. Older uploads carry no digest, and then there is nothing to check:
 * the size check above still catches a truncated download.
 */
async function verifyDigest(file: string, asset: ReleaseAsset): Promise<void> {
  const expected = sha256FromDigest(asset.digest)
  if (!expected) return

  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  if (hash.digest('hex') === expected) return

  await rm(file, { force: true }).catch(() => undefined)
  throw new Error('Il file scaricato non corrisponde a quello pubblicato (checksum).')
}

/** `/Applications/CharlieCode.app`, from the running executable. */
function appBundlePath(): string | undefined {
  const bundle = dirname(dirname(dirname(process.execPath)))
  return bundle.endsWith('.app') ? bundle : undefined
}

/**
 * Mounts the dmg and swaps the bundle in place, then relaunches.
 *
 * The running process keeps its own open files; the new bundle is staged next
 * to the old one and moved into place, so a failure can put the old one back
 * instead of leaving the machine without an app.
 */
async function installMac(dmg: string, markInstalled: () => Promise<void>): Promise<void> {
  const target = appBundlePath()
  if (!target) throw new Error('Non riesco a capire dove è installata l’app.')

  const mount = join(tmpdir(), `charliecode-dmg-${Date.now()}`)
  await mkdir(mount, { recursive: true })
  let attached = false
  try {
    await run('hdiutil', ['attach', dmg, '-nobrowse', '-quiet', '-mountpoint', mount])
    attached = true

    const entries = await readdir(mount)
    const bundle = entries.find((entry) => entry.endsWith('.app'))
    if (!bundle) throw new Error('Il dmg non contiene CharlieCode.app.')

    const staging = `${target}.update`
    const previous = `${target}.old`
    await removeTree(staging)
    await run('ditto', [join(mount, bundle), staging])
    // The dmg was downloaded by the app, so the copy carries the quarantine
    // flag: without clearing it the next launch is blocked by Gatekeeper.
    await run('xattr', ['-dr', 'com.apple.quarantine', staging]).catch(() => undefined)

    // A backup left by an update that died halfway must be gone before the
    // swap: `mv` into an existing folder would nest the app inside it.
    await removeTree(previous)
    if (await exists(previous)) {
      throw new Error(`Non riesco a liberare ${previous}: rimuovilo e riprova.`)
    }
    await run('mv', [target, previous])
    try {
      await run('mv', [staging, target])
    } catch (error) {
      await run('mv', [previous, target]).catch(() => undefined)
      throw error
    }
    // `previous` is kept on purpose: if this build does not start, the backup
    // is still next to the app. `cleanupPreviousBundles` removes it only once
    // a launch gets far enough to load its window.
    await markInstalled()
  } finally {
    if (attached) await run('hdiutil', ['detach', mount, '-quiet']).catch(() => undefined)
    await removeTree(mount)
  }

  app.relaunch()
  app.exit(0)
}

/** Runs the NSIS installer silently, into the folder the app already uses. */
async function installWindows(
  installer: string,
  markInstalled: () => Promise<void>
): Promise<void> {
  const directory = dirname(app.getPath('exe'))
  // The installer is already on disk and silent; recording it here keeps the
  // app that reopens from offering the same file again.
  await markInstalled()
  const child = spawn(installer, ['/S', `/D=${directory}`], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  // The installer waits for the executable to be free; quitting first is what
  // lets it replace the files instead of asking the user to close the app.
  app.quit()
}

async function install(
  downloaded: string,
  asset: ReleaseAsset,
  markInstalled: () => Promise<void>
): Promise<void> {
  if (process.platform === 'darwin' && /\.dmg$/i.test(asset.name)) {
    await installMac(downloaded, markInstalled)
    return
  }
  if (process.platform === 'win32' && /\.exe$/i.test(asset.name)) {
    await installWindows(downloaded, markInstalled)
    return
  }
  throw new Error(`Nessun programma di installazione per ${asset.name}.`)
}

function releaseLink(url: string | undefined): string | undefined {
  if (!url) return undefined
  return url.startsWith('https://github.com/carlolomello/CharlieCode/') ? url : undefined
}

/** Asked from the drawer: "più tardi" does not apply, the user wants to know. */
export interface CheckOptions {
  manual?: boolean
}

/** The dialog that asks the question, and the hook that skips it. */
async function askToUpdate(
  context: UpdateContext,
  candidate: UpdateCandidate
): Promise<boolean> {
  // Verification hook, never set in normal use: answers "sì" without a click.
  if (process.env.CHARLIECODE_UPDATE_ACCEPT === '1') return true

  const notes = summarizeReleaseNotes(context.releaseNotes)
  const detail = [
    candidate.sameVersion
      ? `La tua build è del ${formatDate(buildTime())}.`
      : `Hai la versione ${app.getVersion()}.`,
    `La nuova build è del ${formatDate(candidate.releasedAt)}.`,
    ...(notes ? ['', 'Novità:', notes] : []),
    '',
    process.platform === 'darwin'
      ? 'Scarico il dmg e sostituisco l’app: si riapre da sola.'
      : 'Scarico il programma di installazione: l’app si chiude e si riapre aggiornata.'
  ].join('\n')

  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: 'Aggiornamento disponibile',
    message: `CharlieCode ${candidate.version} è disponibile`,
    detail,
    buttons: ['Aggiorna ora', 'Più tardi'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
  const window = context.window && !context.window.isDestroyed() ? context.window : undefined
  return window
    ? (await dialog.showMessageBox(window, options)).response === 0
    : (await dialog.showMessageBox(options)).response === 0
}

/**
 * Checks once and, when there is something newer, asks before doing anything.
 * Returns what happened so the drawer can say "sei aggiornato"; the startup
 * call ignores the answer. Every failure is reported to the renderer and —
 * when the download or the install failed — offered as a link to the release
 * page.
 */
export async function checkForUpdates(
  context: UpdateContext,
  request: CheckOptions = {}
): Promise<UpdateCheckResult> {
  if (!app.isPackaged) {
    return { state: 'unavailable', message: 'Il controllo gira solo nell’app installata.' }
  }

  const release = await fetchRelease().catch(() => undefined)
  if (!release) {
    return { state: 'unavailable', message: 'Il repository non ha risposto.' }
  }
  // Notes belong to the release, not to the candidate: the dialog reads them
  // from here, so the question says what changed before anything is downloaded.
  context.releaseNotes = release.body

  const state = await readState(context)
  const candidate = decideUpdate({
    release,
    currentVersion: app.getVersion(),
    buildTime: buildTime(),
    platform: process.platform,
    arch: process.arch,
    ...(request.manual ? {} : { dismissedAssetId: state.dismissedAssetId }),
    ...(state.installedAssetId !== undefined ? { installedAssetId: state.installedAssetId } : {}),
    // Verification hook: a copy of the app in a scratch folder has to be able
    // to exercise the install path against the build it already runs.
    force: process.env.CHARLIECODE_UPDATE_FORCE === '1'
  })
  await writeState(context, { ...state, checkedAt: new Date().toISOString() })
  if (!candidate) return { state: 'up-to-date' }

  if (!(await askToUpdate(context, candidate))) {
    await writeState(context, {
      ...state,
      checkedAt: new Date().toISOString(),
      dismissedAssetId: candidate.asset.id
    })
    return { state: 'declined', version: candidate.version }
  }

  const target = join(tmpdir(), `charliecode-${Date.now()}-${basename(candidate.asset.name)}`)
  context.send({
    state: 'downloading',
    version: candidate.version,
    received: 0,
    total: candidate.asset.size
  })

  try {
    await download(candidate.asset, target, (received, total) => {
      context.send({ state: 'downloading', version: candidate.version, received, total })
    })
    context.send({ state: 'installing', version: candidate.version })
    // Recorded before the relaunch, so the build that starts does not offer
    // the installer it was just made from.
    const markInstalled = async (): Promise<void> => {
      await writeState(context, {
        ...state,
        checkedAt: new Date().toISOString(),
        installedAssetId: candidate.asset.id
      })
    }
    await install(target, candidate.asset, markInstalled)
    // Unreachable in practice: both installers end the app. The type needs it.
    return { state: 'offered', version: candidate.version }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const url = releaseLink(release.url) ?? RELEASE_PAGE
    context.send({ state: 'error', version: candidate.version, message, url })

    // The dmg is still on disk: opening it is the manual way out when the swap
    // did not work, and dragging the app over the old one is a step the user
    // already knows.
    const canOpenDmg =
      process.platform === 'darwin' && /\.dmg$/i.test(target) && (await exists(target))
    const failure: Electron.MessageBoxOptions = {
      type: 'error',
      title: 'Aggiornamento non riuscito',
      message: 'Non sono riuscito a installare l’aggiornamento.',
      detail: `${message}\n\n${
        canOpenDmg
          ? 'Posso aprire il dmg già scaricato: trascina CharlieCode nella cartella Applicazioni.'
          : 'Puoi scaricarlo a mano dalla pagina della release.'
      }`,
      buttons: canOpenDmg
        ? ['Apri il dmg', 'Apri la pagina della release', 'Chiudi']
        : ['Apri la pagina della release', 'Chiudi'],
      defaultId: 0,
      cancelId: canOpenDmg ? 2 : 1,
      noLink: true
    }
    const parent =
      context.window && !context.window.isDestroyed() ? context.window : undefined
    const choice = parent
      ? await dialog.showMessageBox(parent, failure)
      : await dialog.showMessageBox(failure)
    if (canOpenDmg && choice.response === 0) {
      await shell.openPath(target).catch(() => undefined)
    } else if (choice.response === (canOpenDmg ? 1 : 0)) {
      await shell.openExternal(url).catch(() => undefined)
    }
    return { state: 'unavailable', message }
  }
}

/**
 * Removes the backup an update leaves next to the app. Called once a launch
 * has loaded its window: until then, `.old` is what a build that does not
 * start can fall back to by hand.
 */
export async function cleanupPreviousBundles(): Promise<void> {
  if (process.platform !== 'darwin') return
  const bundle = appBundlePath()
  if (!bundle) return
  await removeTree(`${bundle}.old`)
}
