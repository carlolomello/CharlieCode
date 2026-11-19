import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, readdirSync, statSync, type Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, extname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { CliProfile } from './types'

/**
 * User-defined CLIs as workers.
 *
 * CharlieCode ships no product presets. A CLI is a command with an argv array
 * and a description of how it prints a turn; everything else is the user's
 * business. That keeps the app honest for anyone: a corporate wrapper, a
 * personal script and a well-known agent CLI are all just profiles.
 *
 * Rules that matter:
 *  - `args` is an argv array, never a shell string, so the prompt is data;
 *  - the prompt goes as the last argument by default, or on stdin;
 *  - a non-zero exit, a timeout and an abort are all failures, even when the
 *    CLI printed something before dying;
 *  - the whole process tree is killed: an agent CLI spawns tools of its own.
 */

const run = promisify(execFile)

export interface AgentRunOptions {
  prompt: string
  model?: string
  /** Let the CLI modify files and run commands. Off unless the user opts in. */
  auto?: boolean
  /** Read-only exploration. */
  plan?: boolean
  workspace: string
}

export interface ExternalRunResult {
  text: string
  /** Exit code, or -1 when the process was killed. */
  code: number
  stderr: string
  ms: number
  /** The process had to be killed for exceeding the timeout. */
  timedOut: boolean
  /** The user stopped the turn. */
  aborted: boolean
  /** Human-readable failure, when there is one. */
  error?: string
}

const MAX_OUTPUT = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const PLACEHOLDER = /\{(prompt|workspace|model)\}/g

/* ------------------------------- argv ---------------------------------- */

function expand(value: string, options: AgentRunOptions): string | undefined {
  let missingModel = false
  const expanded = value.replace(PLACEHOLDER, (_match, name: string) => {
    if (name === 'prompt') return options.prompt
    if (name === 'workspace') return options.workspace
    if (options.model) return options.model
    missingModel = true
    return ''
  })
  // An argument that only makes sense with a model disappears without one,
  // instead of being sent as an empty string the CLI would reject.
  return missingModel ? undefined : expanded
}

function expandAll(values: string[], options: AgentRunOptions): string[] {
  const output: string[] = []
  for (const value of values) {
    const expanded = expand(value, options)
    if (expanded === undefined) {
      // An argument that only makes sense with a model disappears together
      // with the flag that introduced it: `--model {model}` must not become
      // `--model` followed by the prompt.
      const previous = output[output.length - 1]
      if (previous && previous.startsWith('-')) output.pop()
      continue
    }
    output.push(expanded)
  }
  return output
}

/**
 * Builds the argv for one task. Exported because the settings panel shows the
 * exact command before the user saves it: no surprises at spawn time.
 */
export function buildCliArgs(profile: CliProfile, options: AgentRunOptions): string[] {
  const argv = expandAll(profile.args, options)
  const hasPrompt = profile.args.some((arg) => arg.includes('{prompt}'))

  if (options.model && profile.modelArgs?.length) {
    argv.push(...expandAll(profile.modelArgs, options))
  }
  if (options.plan && profile.planArgs?.length) {
    argv.push(...expandAll(profile.planArgs, options))
  }
  if (options.auto && profile.autoArgs?.length) {
    argv.push(...expandAll(profile.autoArgs, options))
  }

  if (profile.promptMode !== 'stdin' && !hasPrompt) argv.push(options.prompt)
  return argv
}

/** True when the prompt must be written to stdin instead of argv. */
export function promptOnStdin(profile: CliProfile): boolean {
  return profile.promptMode === 'stdin'
}

/** Display form of a command, quoted only for reading. */
export function formatCommand(command: string, args: string[]): string {
  const quote = (value: string): string =>
    /[\s"'$`\\]/.test(value) ? `"${value.replace(/(["\\$`])/g, '\\$1')}"` : value
  return [command, ...args.map(quote)].join(' ')
}

/* ------------------------------ binaries -------------------------------- */

const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com']

function executableExtensions(): string[] {
  if (process.platform !== 'win32') return ['']
  const fromEnv = (process.env.PATHEXT ?? '')
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  return fromEnv.length > 0 ? fromEnv : WINDOWS_EXTENSIONS
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function candidatePaths(base: string): string[] {
  const extensions = executableExtensions()
  if (extensions.length === 1 && extensions[0] === '') return [base]
  // On Windows the extension may already be there (`tool.cmd`).
  if (extensions.some((extension) => base.toLowerCase().endsWith(extension))) return [base]
  return [base, ...extensions.map((extension) => `${base}${extension}`)]
}

function searchDirectories(home: string): string[] {
  const directories = new Set<string>(
    (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  )

  // Finder/Explorer launches do not inherit the shell PATH. These are generic
  // tool-manager locations, not product presets: whatever the user installed
  // there is found by name like anything else.
  const fixed = [
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, 'Library', 'pnpm'),
    join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ]
  for (const directory of fixed) directories.add(directory)

  for (const variable of ['PNPM_HOME', 'VOLTA_HOME', 'CARGO_HOME', 'DENO_INSTALL', 'NVM_BIN']) {
    const value = process.env[variable]
    if (!value) continue
    directories.add(variable === 'NVM_BIN' ? value : join(value, 'bin'))
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    const localAppData = process.env.LOCALAPPDATA
    if (appData) directories.add(join(appData, 'npm'))
    if (localAppData) directories.add(join(localAppData, 'Programs'))
  }

  // nvm keeps one bin directory per Node version; the shell PATH only points
  // at the active one, and the app usually starts with a different PATH.
  try {
    const versions = readdirSync(join(home, '.nvm', 'versions', 'node'), {
      withFileTypes: true
    })
    for (const version of versions) {
      if (version.isDirectory()) {
        directories.add(join(home, '.nvm', 'versions', 'node', version.name, 'bin'))
      }
    }
  } catch {
    // No nvm: nothing to add.
  }

  return [...directories]
}

/**
 * Resolves a command the way a shell would: an absolute path is used as is, a
 * relative one is resolved against the workspace, and a bare name is searched
 * in PATH plus the usual per-user install directories.
 */
export function findBinary(
  command: string,
  home = homedir(),
  workspace?: string
): string | undefined {
  const cleaned = command.trim()
  if (!cleaned) return undefined

  const absolute = cleaned.startsWith('~/')
    ? join(home, cleaned.slice(2))
    : isAbsolute(cleaned)
      ? cleaned
      : undefined

  if (absolute) {
    return candidatePaths(absolute).find(isExecutable)
  }

  if (cleaned.includes('/') || cleaned.includes('\\')) {
    const base = workspace ? join(workspace, cleaned) : cleaned
    return candidatePaths(base).find(isExecutable)
  }

  for (const directory of searchDirectories(home)) {
    for (const candidate of candidatePaths(join(directory, cleaned))) {
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

/* ------------------------------- search --------------------------------- */

export interface BinaryMatch {
  /** Command name without the Windows extension. */
  name: string
  path: string
  /** `--version` first line, when the binary answered quickly. */
  version?: string
}

function displayName(name: string): string {
  if (process.platform !== 'win32') return name
  const extension = extname(name).toLowerCase()
  return executableExtensions().includes(extension) ? name.slice(0, -extension.length) : name
}

function hasRunnableExtension(name: string): boolean {
  if (process.platform !== 'win32') return true
  return executableExtensions().includes(extname(name).toLowerCase())
}

async function versionOf(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(path, ['--version'], {
      timeout: 1_500,
      windowsHide: true,
      maxBuffer: 128 * 1024
    })
    return stdout.split('\n')[0]?.trim() || undefined
  } catch {
    // A CLI that cannot answer --version is still usable.
    return undefined
  }
}

/**
 * Finds commands by name while the user types.
 *
 * Exact names go through `findBinary` (fast, respects PATH order). A partial
 * query scans the same directories and returns the first match per command
 * name, capped: this is a picker, not a package manager. Versions are fetched
 * for the first few matches only, with a short timeout, so a slow binary never
 * blocks the panel.
 */
export async function searchBinaries(
  query: string,
  home = homedir(),
  workspace?: string
): Promise<BinaryMatch[]> {
  const cleaned = query.trim()
  if (!cleaned) return []

  const exact = findBinary(cleaned, home, workspace)
  if (exact) {
    const version = await versionOf(exact)
    return [
      {
        name: displayName(basename(exact)),
        path: exact,
        ...(version ? { version } : {})
      }
    ]
  }

  // One character would list half the machine; wait for a real query.
  if (cleaned.length < 2) return []

  const lower = cleaned.toLowerCase()
  const seen = new Set<string>()
  const matches: BinaryMatch[] = []

  for (const directory of searchDirectories(home)) {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (!entry.name.toLowerCase().includes(lower)) continue
      if (!hasRunnableExtension(entry.name)) continue

      const name = displayName(entry.name)
      const key = process.platform === 'win32' ? name.toLowerCase() : name
      if (seen.has(key)) continue

      const path = join(directory, entry.name)
      if (!isExecutable(path)) continue

      seen.add(key)
      matches.push({ name, path })
      if (matches.length >= 40) break
    }
    if (matches.length >= 40) break
  }

  const score = (match: BinaryMatch): number => {
    const name = match.name.toLowerCase()
    if (name === lower) return 0
    if (name.startsWith(lower)) return 1
    return 2
  }
  matches.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))

  const top = matches.slice(0, 40)
  const versions = await Promise.all(top.slice(0, 6).map((match) => versionOf(match.path)))
  return top.map((match, index) => {
    const version = versions[index]
    return version ? { ...match, version } : match
  })
}

/* ------------------------------- parsing -------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function parseJson(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return undefined
  }
}

/** Reads a dot path (`message.content`) from a parsed object. */
function readPath(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const segment of path.split('.')) {
    const record = asRecord(current)
    if (!record) return undefined
    current = record[segment]
  }
  return current
}

function textOfContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const pieces = content
    .map((part) => {
      const record = asRecord(part)
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
  return pieces.length > 0 ? pieces.join('') : undefined
}

/**
 * Pulls visible text out of one parsed line. Covers the shapes agent CLIs
 * actually emit, without naming any of them: plain `text`, OpenAI-style
 * `choices[].delta.content`, assistant messages with content parts, and final
 * `run_result`/`result` objects.
 */
export function extractText(event: Record<string, unknown>, textPath?: string): string | undefined {
  if (textPath) {
    const value = readPath(event, textPath)
    if (typeof value === 'string' && value) return value
  }

  if (typeof event.text === 'string' && event.text) return event.text
  if (typeof event.delta === 'string' && event.delta) return event.delta
  if (typeof event.content === 'string' && event.content) return event.content
  if (typeof event.result === 'string' && event.result) return event.result
  if (typeof event.response === 'string' && event.response) return event.response
  if (typeof event.message === 'string' && event.message) return event.message

  const part = asRecord(event.part)
  if (part && typeof part.text === 'string' && part.text) return part.text

  const message = asRecord(event.message)
  if (message) {
    const fromParts = textOfContent(message.content)
    if (fromParts) return fromParts
    if (typeof message.content === 'string' && message.content) return message.content
  }

  const choices = Array.isArray(event.choices) ? event.choices : []
  for (const choice of choices) {
    const record = asRecord(choice)
    const delta = asRecord(record?.delta)
    if (typeof delta?.content === 'string' && delta.content) return delta.content
    const choiceMessage = asRecord(record?.message)
    if (typeof choiceMessage?.content === 'string' && choiceMessage.content) {
      return choiceMessage.content
    }
  }

  return undefined
}

/** Pulls a tool/activity name out of one parsed line. */
export function extractActivity(
  event: Record<string, unknown>,
  activityPath?: string
): string | undefined {
  if (activityPath) {
    const value = readPath(event, activityPath)
    if (typeof value === 'string' && value) return value
  }

  const type = typeof event.type === 'string' ? event.type : ''
  if (typeof event.tool === 'string' && event.tool) return event.tool
  if (typeof event.name === 'string' && /tool|function|action/i.test(type)) return event.name

  const part = asRecord(event.part)
  if (typeof part?.tool === 'string' && part.tool) return part.tool
  if (typeof part?.name === 'string' && /tool/i.test(type)) return part.name

  const message = asRecord(event.message)
  if (Array.isArray(message?.content)) {
    for (const entry of message.content) {
      const record = asRecord(entry)
      if (record?.type === 'tool_use' && typeof record.name === 'string') return record.name
      if (record?.type === 'tool_call' && typeof record.name === 'string') return record.name
    }
  }

  return undefined
}

/** One line of output, interpreted according to the profile. */
function lineText(profile: CliProfile, line: string): string | undefined {
  const format = profile.output ?? 'auto'

  if (format === 'text') return line

  if (format === 'auto') {
    const event = parseJson(line)
    if (!event) return line
    return extractText(event, profile.textPath)
  }

  const event = parseJson(line)
  if (!event) return undefined

  if (format === 'run-result') {
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'run_result' || type === 'result' || type === 'final') {
      return extractText(event, profile.textPath)
    }
    return undefined
  }

  return extractText(event, profile.textPath)
}

function lineActivity(profile: CliProfile, line: string): string | undefined {
  if ((profile.output ?? 'auto') === 'text') return undefined
  const event = parseJson(line)
  return event ? extractActivity(event, profile.activityPath) : undefined
}

/* ------------------------------- models --------------------------------- */

function modelNames(value: unknown, path?: string): string[] {
  const target = path ? readPath(value, path) : value
  if (!Array.isArray(target)) return []

  const names: string[] = []
  for (const entry of target) {
    if (typeof entry === 'string') {
      names.push(entry)
      continue
    }
    const record = asRecord(entry)
    const name = record?.id ?? record?.name ?? record?.model
    if (typeof name === 'string') names.push(name)
  }
  return names
}

function modelsFromLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length < 120 && !line.startsWith('{'))
    .slice(0, 400)
}

/**
 * Models the CLI already has access to. No key ever reaches this process: the
 * command runs inside the CLI's own environment.
 */
export async function profileModels(
  profile: CliProfile,
  home = homedir(),
  workspace?: string
): Promise<string[]> {
  if (!profile.modelsArgs?.length) return []
  const binary = findBinary(profile.command, home, workspace)
  if (!binary) return []

  const args = profile.modelsArgs.map((arg) =>
    arg.replace(/\{workspace\}/g, workspace ?? '').replace(/\{model\}/g, '')
  )

  try {
    const { stdout } = await run(binary, args, {
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      ...(workspace ? { cwd: workspace } : {})
    })

    const format = profile.modelsFormat ?? 'lines'
    if (format === 'json') {
      const parsed: unknown = JSON.parse(stdout)
      return [...new Set(modelNames(parsed, profile.modelsPath))].slice(0, 400)
    }
    return [...new Set(modelsFromLines(stdout))]
  } catch {
    return []
  }
}

/* ------------------------------- process -------------------------------- */

/**
 * Kills the CLI and everything it started. A coding CLI spawns builds, tests
 * and language servers: killing only the parent leaves them running and the
 * user's next turn races with a zombie.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      child.kill()
    }
    return
  }

  try {
    // Negative pid = process group, because the child is spawned detached.
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }
}

/**
 * Runs one task through a CLI profile.
 *
 * Resolves with a result even on a non-zero exit, timeout or abort: the agent
 * decides what to do with it, and the UI shows the real reason instead of a
 * generic rejection. Only a spawn failure (binary missing, permissions)
 * rejects.
 */
export function runExternalAgent(
  profile: CliProfile,
  options: AgentRunOptions,
  hooks: {
    onText?: (text: string) => void
    onActivity?: (activity: string) => void
    onStderr?: (line: string) => void
    signal?: AbortSignal
    timeoutMs?: number
    home?: string
  } = {}
): Promise<ExternalRunResult> {
  if (hooks.signal?.aborted) {
    return Promise.resolve({
      text: '',
      code: -1,
      stderr: '',
      ms: 0,
      timedOut: false,
      aborted: true,
      error: `${profile.label} interrotta`
    })
  }

  const binary = findBinary(profile.command, hooks.home ?? homedir(), options.workspace)
  if (!binary) {
    return Promise.reject(
      new Error(
        `${profile.label}: comando "${profile.command}" non trovato. Controlla il percorso nel profilo.`
      )
    )
  }

  const argv = buildCliArgs(profile, options)
  const started = Date.now()
  const timeoutMs =
    hooks.timeoutMs ?? (profile.timeoutSeconds ? profile.timeoutSeconds * 1_000 : DEFAULT_TIMEOUT_MS)
  const useStdin = promptOnStdin(profile)

  return new Promise<ExternalRunResult>((resolve, reject) => {
    const child = spawn(binary, argv, {
      cwd: options.workspace,
      shell: false,
      windowsHide: true,
      // A process group of its own, so the whole tree can be killed.
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
    })

    let text = ''
    let stderr = ''
    let buffer = ''
    let timedOut = false
    let aborted = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child, 'SIGTERM')
      // Some CLIs ignore SIGTERM while a tool is running.
      setTimeout(() => killTree(child, 'SIGKILL'), 5_000).unref?.()
    }, timeoutMs)

    const stop = (): void => {
      aborted = true
      killTree(child, 'SIGTERM')
      setTimeout(() => killTree(child, 'SIGKILL'), 3_000).unref?.()
    }
    hooks.signal?.addEventListener('abort', stop, { once: true })

    const consume = (line: string): void => {
      if (!line.trim()) return
      const activity = lineActivity(profile, line)
      if (activity) hooks.onActivity?.(activity)

      const piece = lineText(profile, line)
      if (piece) {
        text += piece
        hooks.onText?.(piece)
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_OUTPUT) buffer = buffer.slice(-MAX_OUTPUT)
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        consume(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_OUTPUT)
      for (const line of chunk.split('\n')) {
        if (line.trim()) hooks.onStderr?.(line)
      }
    })

    if (useStdin && child.stdin) {
      // A CLI that exits before reading stdin must not crash the app with EPIPE.
      child.stdin.on('error', () => undefined)
      child.stdin.end(options.prompt)
    }

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      hooks.signal?.removeEventListener('abort', stop)
      if (buffer.trim()) consume(buffer)

      const exitCode = code ?? -1
      const failure = timedOut
        ? `${profile.label} non ha risposto entro ${Math.round(timeoutMs / 1000)}s`
        : aborted
          ? `${profile.label} interrotta`
          : exitCode !== 0
            ? `${profile.label} è uscita con codice ${exitCode}${
                stderr ? `: ${stderr.split('\n')[0]}` : ''
              }`
            : undefined

      resolve({
        text: text.trim(),
        code: exitCode,
        stderr: stderr.trim(),
        ms: Date.now() - started,
        timedOut,
        aborted,
        ...(failure ? { error: failure } : {})
      })
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      hooks.signal?.removeEventListener('abort', stop)
      reject(error)
    })

    child.on('close', (code) => finish(code))
  })
}

/** True when the profile's command exists: the panel uses it to enable a row. */
export function profileAvailable(
  profile: CliProfile,
  home = homedir(),
  workspace?: string
): boolean {
  return Boolean(findBinary(profile.command, home, workspace))
}
