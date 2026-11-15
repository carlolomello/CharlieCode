#!/usr/bin/env node
/**
 * `pnpm dev` wrapper.
 *
 * Electron in development runs from `node_modules/electron/dist/Electron.app`,
 * so macOS shows "Electron" and its logo in the Dock and menu bar. Packaged
 * builds get their name and icon from the bundle, but during development that
 * is misleading — you cannot tell CharlieCode apart from a bare Electron shell.
 *
 * This script makes a copy of that bundle under `.dev/`, rewrites its
 * Info.plist to CharlieCode, swaps in `build/icon.icns`, ad-hoc signs it and
 * launches electron-vite with `ELECTRON_EXEC_PATH` pointing at that copy.
 * Nothing outside the repo is touched, and Windows/Linux keep the plain
 * `electron-vite dev`.
 */
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  run(process.env)
  process.exit(0)
}

const require = createRequire(import.meta.url)
const electronBinary = require('electron')
// …/dist/Electron.app/Contents/MacOS/Electron → …/dist
const distDir = resolve(dirname(electronBinary), '..', '..', '..')
const sourceBundle = join(distDir, 'Electron.app')
const devDir = join(root, '.dev')
// The bundle name matters: the Dock, the menu bar and Activity Monitor all read
// it, so it is not enough to change Info.plist values.
const targetBundle = join(devDir, 'CharlieCode.app')
const iconSource = join(root, 'build', 'icon.icns')
const stampFile = join(devDir, '.version')

const version = JSON.parse(
  readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
).version

function branded() {
  if (!existsSync(targetBundle) || !existsSync(stampFile)) return false
  if (!existsSync(join(targetBundle, 'Contents', 'MacOS', 'CharlieCode'))) return false
  if (readFileSync(stampFile, 'utf8').trim() !== version) return false
  try {
    const plist = readFileSync(join(targetBundle, 'Contents', 'Info.plist'), 'utf8')
    return plist.includes('<string>CharlieCode</string>')
  } catch {
    return false
  }
}

function buildBundle() {
  console.log('[dev] preparing a branded Electron bundle (one-time, ~250 MB)…')
  rmSync(devDir, { recursive: true, force: true })
  mkdirSync(devDir, { recursive: true })
  cpSync(sourceBundle, targetBundle, { recursive: true, verbatimSymlinks: true })

  const plist = join(targetBundle, 'Contents', 'Info.plist')
  const set = (key, value) =>
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], {
      stdio: 'ignore'
    })
  try {
    set('CFBundleName', 'CharlieCode')
    set('CFBundleDisplayName', 'CharlieCode')
    set('CFBundleIdentifier', 'co.charliecode.app')
    // The process name (menu bar, Dock label, Activity Monitor) comes from the
    // executable itself, so rename it too.
    set('CFBundleExecutable', 'CharlieCode')
  } catch {
    // Older Electron builds may not have every key; the icon still applies.
  }

  const binary = join(targetBundle, 'Contents', 'MacOS', 'Electron')
  if (existsSync(binary)) {
    renameSync(binary, join(targetBundle, 'Contents', 'MacOS', 'CharlieCode'))
  }

  if (existsSync(iconSource)) {
    cpSync(iconSource, join(targetBundle, 'Contents', 'Resources', 'icon.icns'))
    try {
      set('CFBundleIconFile', 'icon.icns')
    } catch {
      /* ignore */
    }
  }

  // Copying the bundle invalidates its signature; macOS then refuses to launch
  // it. An ad-hoc signature is enough for local development.
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', targetBundle], {
      stdio: 'ignore'
    })
  } catch {
    console.warn('[dev] ad-hoc signing failed; the Dock icon may not update.')
  }

  writeFileSync(stampFile, `${version}\n`, 'utf8')
}

function run(extraEnv) {
  const child = spawn('npx', ['electron-vite', 'dev'], {
    cwd: root,
    stdio: 'inherit',
    env: extraEnv
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
}

if (!branded()) buildBundle()

// electron-vite resolves the Electron binary from ELECTRON_EXEC_PATH (it reads
// `node_modules/electron/path.txt` otherwise), so this — not
// ELECTRON_OVERRIDE_DIST_PATH — is what actually launches the branded bundle.
run({
  ...process.env,
  ELECTRON_EXEC_PATH: join(targetBundle, 'Contents', 'MacOS', 'CharlieCode')
})
