import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, net, shell } from 'electron'
import type { UpdateStatus } from '../shared/ipc'
import {
  decideUpdate,
  parseRelease,
  type ReleaseAsset,
  type ReleaseInfo
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
  checkedAt?: string
}

export interface UpdateContext {
  window: BrowserWindow | null
  configPath: (...segments: string[]) => string
  send: (status: UpdateStatus) => void
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
  await writeFile(context.configPath(STATE_FILE), JSON.stringify(state, null, 2), 'utf8').catch(
    () => undefined
  )
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
async function installMac(dmg: string): Promise<void> {
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
    await rm(staging, { recursive: true, force: true })
    await run('ditto', [join(mount, bundle), staging])
    // The dmg was downloaded by the app, so the copy carries the quarantine
    // flag: without clearing it the next launch is blocked by Gatekeeper.
    await run('xattr', ['-dr', 'com.apple.quarantine', staging]).catch(() => undefined)

    await rm(previous, { recursive: true, force: true })
    await run('mv', [target, previous])
    try {
      await run('mv', [staging, target])
    } catch (error) {
      await run('mv', [previous, target]).catch(() => undefined)
      throw error
    }
    await rm(previous, { recursive: true, force: true }).catch(() => undefined)
  } finally {
    if (attached) await run('hdiutil', ['detach', mount, '-quiet']).catch(() => undefined)
    await rm(mount, { recursive: true, force: true }).catch(() => undefined)
  }

  app.relaunch()
  app.exit(0)
}

/** Runs the NSIS installer silently, into the folder the app already uses. */
async function installWindows(installer: string): Promise<void> {
  const directory = dirname(app.getPath('exe'))
  const child = spawn(installer, ['/S', `/D=${directory}`], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  // The installer waits for the executable to be free; quitting first is what
  // lets it replace the files instead of asking the user to close the app.
  app.quit()
}

async function install(downloaded: string, asset: ReleaseAsset): Promise<void> {
  if (process.platform === 'darwin' && /\.dmg$/i.test(asset.name)) {
    await installMac(downloaded)
    return
  }
  if (process.platform === 'win32' && /\.exe$/i.test(asset.name)) {
    await installWindows(downloaded)
    return
  }
  throw new Error(`Nessun programma di installazione per ${asset.name}.`)
}

function releaseLink(url: string | undefined): string | undefined {
  if (!url) return undefined
  return url.startsWith('https://github.com/carlolomello/CharlieCode/') ? url : undefined
}

/**
 * Checks once and, when there is something newer, asks before doing anything.
 * Every failure is reported to the renderer and — when the download or the
 * install failed — offered as a link to the release page.
 */
export async function checkForUpdates(context: UpdateContext): Promise<void> {
  if (!app.isPackaged) return

  const release = await fetchRelease().catch(() => undefined)
  if (!release) return

  const state = await readState(context)
  const candidate = decideUpdate({
    release,
    currentVersion: app.getVersion(),
    buildTime: buildTime(),
    platform: process.platform,
    arch: process.arch,
    ...(state.dismissedAssetId !== undefined ? { dismissedAssetId: state.dismissedAssetId } : {})
  })
  await writeState(context, { ...state, checkedAt: new Date().toISOString() })
  if (!candidate) return

  const detail = [
    candidate.sameVersion
      ? `La tua build è del ${formatDate(buildTime())}.`
      : `Hai la versione ${app.getVersion()}.`,
    `La nuova build è del ${formatDate(candidate.releasedAt)}.`,
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
  const answer = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)

  if (answer.response !== 0) {
    await writeState(context, {
      ...state,
      checkedAt: new Date().toISOString(),
      dismissedAssetId: candidate.asset.id
    })
    return
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
    await install(target, candidate.asset)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const url = releaseLink(release.url) ?? RELEASE_PAGE
    context.send({ state: 'error', version: candidate.version, message, url })

    const failure: Electron.MessageBoxOptions = {
      type: 'error',
      title: 'Aggiornamento non riuscito',
      message: 'Non sono riuscito a installare l’aggiornamento.',
      detail: `${message}\n\nPuoi scaricarlo a mano dalla pagina della release.`,
      buttons: ['Apri la pagina della release', 'Chiudi'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }
    const choice = window
      ? await dialog.showMessageBox(window, failure)
      : await dialog.showMessageBox(failure)
    if (choice.response === 0) await shell.openExternal(url).catch(() => undefined)
  }
}
