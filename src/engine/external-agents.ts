import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, readdirSync, statSync, type Dirent } from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, extname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { writeFileAtomic } from './atomic-write'
import { spawnTarget } from './cli-shim'
import { modelNamesFromOutput } from './model-list'
import type { CliProfile, EffortLevel } from './types'

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
  /** Reasoning effort the user picked for this turn. */
  effort?: EffortLevel
  /** Let the CLI modify files and run commands. Off unless the user opts in. */
  auto?: boolean
  /** Read-only exploration. */
  plan?: boolean
  workspace: string
}

export interface ExternalRunResult {
  text: string
  /**
   * Everything the CLI wrote to stdout, before any format parsing. A plan or
   * any other structured answer must be read from here: `text` is the chat
   * text a format may have extracted (and a JSON line may extract nothing).
   */
  raw: string
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
  /**
   * The command line that ran, with the prompt shortened. A CLI that answers
   * with a bare `ERROR` gives the user nothing to act on; the command is what
   * lets them reproduce the failure in their own terminal.
   */
  command?: string
  /** A note for the user when the turn succeeded after a fallback. */
  warning?: string
}

const MAX_OUTPUT = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10 * 60_000
/** How many times a models command that printed nothing is repeated. */
const MODEL_LIST_ATTEMPTS = 3
/** A cold CLI answers with an empty list; a couple of seconds later it knows. */
const MODEL_LIST_RETRY_MS = 2_500
/** A probe slower than this is not a cold start: repeating it wastes time. */
const MODEL_LIST_RETRY_MAX_MS = 30_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
/**
 * How fast a failure must be to read as "the arguments were rejected". A CLI
 * that does not accept the model flag dies before doing anything; a turn that
 * ran for a minute did real work and must not be repeated.
 */
const FAST_FAILURE_WINDOW_MS = 20_000
const PLACEHOLDER = /\{(prompt|workspace|model|effort)\}/g

/* ------------------------------- argv ---------------------------------- */

interface ExpandOptions extends AgentRunOptions {
  effortValue?: string
}

function expand(value: string, options: ExpandOptions): string | undefined {
  let missing = false
  const expanded = value.replace(PLACEHOLDER, (_match, name: string) => {
    if (name === 'prompt') return options.prompt
    if (name === 'workspace') return options.workspace
    if (name === 'model') {
      if (options.model) return options.model
      missing = true
      return ''
    }
    if (options.effortValue) return options.effortValue
    missing = true
    return ''
  })
  // An argument that only makes sense with a model or an effort disappears
  // instead of being sent as an empty string the CLI would reject.
  return missing ? undefined : expanded
}

function expandAll(values: string[], options: ExpandOptions): string[] {
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
 * Maps CharlieCode's four levels to the values a CLI advertises in `--help`.
 * `none` means "do not pass anything": the CLI default is the default.
 */
export function effortValue(profile: CliProfile, effort: EffortLevel): string {
  if (effort === 'none') return ''
  const values = profile.effortValues ?? []
  if (values.length === 0) return effort
  if (effort === 'low') return values[0] ?? effort
  if (effort === 'max') return values[values.length - 1] ?? effort
  const high = values.find((value) => /high|strong|deep/i.test(value))
  return high ?? values[Math.max(0, values.length - 2)] ?? effort
}

/** The optional argv groups a profile adds to a turn. */
export type FlagGroup = 'model' | 'effort' | 'plan' | 'auto'

/**
 * Where a group sits in the argv. `after` is the default, after the profile's
 * own arguments (`cli run --yolo`). `before` puts it in front of them, which is
 * where a CLI that only knows the flag globally expects it (`cli --yolo run`).
 * `off` leaves the group out of this turn.
 */
export type FlagPlacement = 'after' | 'before' | 'off'

export type FlagPlacements = Partial<Record<FlagGroup, FlagPlacement>>

/** Everything a turn knows about the flags the CLI already refused. */
export interface ArgvAdjustments {
  placements?: FlagPlacements
  /** Flags the CLI refused that sat in the profile's own `args`. */
  refusedArgs?: string[]
}

/**
 * Builds the argv for one task. Exported because the settings panel shows the
 * exact command before the user saves it: no surprises at spawn time.
 *
 * `placements` exists because a CLI can document a flag at the top level and
 * reject it after the subcommand that runs the prompt: the same flag has to
 * move in front of `args`, or disappear.
 */
export function buildCliArgs(
  profile: CliProfile,
  options: AgentRunOptions,
  adjustments: ArgvAdjustments = {}
): string[] {
  const placements = adjustments.placements ?? {}
  const base = withoutRefusedArgs(expandAll(profile.args, options), adjustments.refusedArgs ?? [])
  const hasPrompt = profile.args.some((arg) => arg.includes('{prompt}'))
  const before: string[] = []
  const after: string[] = []

  const place = (group: FlagGroup, args: string[]): void => {
    const where = placements[group] ?? 'after'
    if (where === 'off' || args.length === 0) return
    if (where === 'before') before.push(...args)
    else after.push(...args)
  }

  if (options.model) {
    const alreadyPlaced = profile.args.some((arg) => arg.includes('{model}'))
    if (profile.modelArgs?.length) {
      place('model', expandAll(profile.modelArgs, options))
    } else if (!alreadyPlaced) {
      // Almost every coding CLI spells this flag the same way. The profile
      // editor overrides it when a CLI disagrees, so a missing `modelArgs`
      // never turns the model picker into a dead control.
      place('model', ['--model', options.model])
    }
  }

  const effort = options.effort ? effortValue(profile, options.effort) : ''
  if (effort && profile.effortArgs?.length) {
    place('effort', expandAll(profile.effortArgs, { ...options, effortValue: effort }))
  }

  if (options.plan && profile.planArgs?.length) {
    place('plan', expandAll(profile.planArgs, options))
  }
  if (options.auto && profile.autoArgs?.length) {
    place('auto', expandAll(profile.autoArgs, options))
  }

  const argv = [...before, ...base, ...after]
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

/* ------------------------ flags the CLI rejected ------------------------ */

/**
 * Every CLI spells "I do not know this flag" a little differently. These are
 * the shapes seen in the wild (`Unknown flag: --yolo`, `unexpected argument
 * '--x'`, `--x is not a valid option`), never a product name.
 */
const UNKNOWN_FLAG_PATTERNS: RegExp[] = [
  /unknown\s+(?:flag|option|argument)s?\s*[:=]?\s*["'`]?(-{1,2}[A-Za-z0-9][\w-]*)/gi,
  /unrecogni[sz]ed\s+(?:flag|option|argument)\s*[:=]?\s*["'`]?(-{1,2}[A-Za-z0-9][\w-]*)/gi,
  /(?:invalid|illegal|bad)\s+(?:flag|option)\s*[:=]?\s*["'`]?(-{1,2}[A-Za-z0-9][\w-]*)/gi,
  /(?:unexpected|unsupported)\s+(?:argument|flag|option)\s*["'`]?(-{1,2}[A-Za-z0-9][\w-]*)/gi,
  /(-{1,2}[A-Za-z0-9][\w-]*)\s+(?:is\s+)?not\s+(?:a\s+)?(?:valid|recogni[sz]ed|known|supported)\s+(?:flag|option)/gi,
  /(?:flag|option)\s+["'`]?(-{1,2}[A-Za-z0-9][\w-]*)["'`]?\s+(?:is\s+)?not\s+(?:recogni[sz]ed|known|supported|defined)/gi
]

function normalizeFlag(raw: string): string | undefined {
  const value =
    raw
      .replace(/["'`.,;:!?)\]}]+$/g, '')
      .split('=')[0]
      ?.trim() ?? ''
  return /^-{1,2}[A-Za-z][\w-]*$/.test(value) ? value.toLowerCase() : undefined
}

/** The flags a CLI's own error message names as unknown. */
export function rejectedFlags(output: string): string[] {
  const found = new Set<string>()
  for (const pattern of UNKNOWN_FLAG_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      const flag = normalizeFlag(match[1] ?? '')
      if (flag) found.add(flag)
    }
  }
  return [...found]
}

/**
 * Only a fast failure that produced no answer reads as "the arguments were
 * rejected": a turn that ran for a minute did real work and is never repeated.
 */
function fastFailure(result: ExternalRunResult): boolean {
  if (result.aborted || result.timedOut) return false
  if (result.code === 0 || !result.error) return false
  if (result.text.trim()) return false
  return result.ms < FAST_FAILURE_WINDOW_MS
}

function groupFlags(profile: CliProfile, options: AgentRunOptions): [FlagGroup, string[]][] {
  return [
    ['model', profile.modelArgs?.length ? profile.modelArgs : options.model ? ['--model'] : []],
    ['effort', profile.effortArgs ?? []],
    ['plan', profile.planArgs ?? []],
    ['auto', profile.autoArgs ?? []]
  ]
}

/**
 * Takes a refused flag out of the profile's own argv, with the value that
 * follows it: leaving `--yolo` out of `run --yolo` is the fix, leaving its
 * value behind would be a new error. A plain word is never touched.
 */
function withoutRefusedArgs(args: string[], refused: string[]): string[] {
  if (refused.length === 0) return args
  const output: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    const flag = normalizeFlag(arg)
    if (!flag || !refused.includes(flag)) {
      output.push(arg)
      continue
    }
    const next = args[index + 1]
    if (!arg.includes('=') && next !== undefined && !next.startsWith('-')) index++
  }
  return output
}

/** One flag the CLI said it does not know, and where it came from. */
export interface RefusedFlag {
  /** The group we added it with, or `args` when the profile's argv has it. */
  group: FlagGroup | 'args'
  flag: string
}

/**
 * The flags we added that the CLI says it does not know, with the group they
 * belong to. A flag written by the user inside `args` is not ours to remove:
 * it never matches a group, so it never triggers a repeat.
 */
export function rejectedGroups(
  profile: CliProfile,
  options: AgentRunOptions,
  result: ExternalRunResult,
  adjustments: ArgvAdjustments = {}
): RefusedFlag[] {
  if (!fastFailure(result)) return []
  const output = `${result.stderr}\n${result.raw}`.slice(-4_000)
  const flags = rejectedFlags(output)
  if (flags.length === 0) return []

  const placements = adjustments.placements ?? {}
  const refusedArgs = adjustments.refusedArgs ?? []
  const matches: RefusedFlag[] = []
  for (const [group, args] of groupFlags(profile, options)) {
    if ((placements[group] ?? 'after') === 'off') continue
    for (const arg of args) {
      const flag = normalizeFlag(arg)
      if (flag && flags.includes(flag)) matches.push({ group, flag })
    }
  }

  // The same flag can sit in the profile's own argv instead: the user copied
  // it from the CLI's help, or an older connect step put it there.
  for (const arg of profile.args) {
    const flag = normalizeFlag(arg)
    if (!flag || !flags.includes(flag) || refusedArgs.includes(flag)) continue
    matches.push({ group: 'args', flag })
  }
  return matches
}

/**
 * Flags a CLI already refused, remembered per profile signature: the next turn
 * does not pay the failed process again. Editing the profile changes the
 * signature, so a corrected profile is never stuck with an old decision.
 *
 * The decision also survives a restart (see `rememberFlags`): the first turn
 * after every launch used to pay the failed process again, which on a slow CLI
 * is most of the wait before the first token.
 */
const refusedFlagsByProfile = new Map<string, ArgvAdjustments>()

/** Where the learned decisions live, inside the app config dir. */
const LEARNED_FILE = 'cli-learned.json'

interface LearnedEntry {
  /** The profile as it was when the flag was refused: an edit invalidates it. */
  signature: string
  placements?: FlagPlacements
  refusedArgs?: string[]
}

function learnedFilePath(stateDir: string): string {
  return join(stateDir, LEARNED_FILE)
}

function readPlacements(value: unknown): FlagPlacements {
  const placements: FlagPlacements = {}
  if (typeof value !== 'object' || value === null) return placements
  for (const [group, where] of Object.entries(value as Record<string, unknown>)) {
    if (!['model', 'effort', 'plan', 'auto'].includes(group)) continue
    if (where !== 'after' && where !== 'before' && where !== 'off') continue
    placements[group as FlagGroup] = where
  }
  return placements
}

function readRefused(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .filter((entry) => normalizeFlag(entry) !== undefined)
    .slice(0, 16)
}

/** One read per state dir per run: the file is small, the launch is not. */
const learnedLoads = new Map<string, Promise<void>>()

async function loadLearned(stateDir?: string): Promise<void> {
  if (!stateDir) return
  const pending = learnedLoads.get(stateDir)
  if (pending) return pending

  const load = (async (): Promise<void> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(learnedFilePath(stateDir), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      for (const entry of Object.values(parsed as Record<string, unknown>)) {
        const record = entry as Record<string, unknown> | null
        if (!record || typeof record.signature !== 'string') continue
        refusedFlagsByProfile.set(record.signature, {
          placements: readPlacements(record.placements),
          refusedArgs: readRefused(record.refusedArgs)
        })
      }
    } catch {
      // No file yet, or one we cannot read: memory only. Learning again costs
      // a single failed process, never a broken turn.
    }
  })()
  learnedLoads.set(stateDir, load)
  return load
}

/** Writes are serialised: a team turn learns the same flag from three CLIs. */
let learnedWrites: Promise<void> = Promise.resolve()

function rememberFlags(
  stateDir: string | undefined,
  profile: CliProfile,
  signature: string,
  adjustments: ArgvAdjustments
): Promise<void> {
  refusedFlagsByProfile.set(signature, adjustments)
  if (!stateDir) return Promise.resolve()

  const placements = adjustments.placements ?? {}
  const refusedArgs = adjustments.refusedArgs ?? []
  const entry: LearnedEntry = {
    signature,
    ...(Object.keys(placements).length > 0 ? { placements } : {}),
    ...(refusedArgs.length > 0 ? { refusedArgs } : {})
  }
  const path = learnedFilePath(stateDir)

  learnedWrites = learnedWrites
    .then(async () => {
      let all: Record<string, LearnedEntry> = {}
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          all = parsed as Record<string, LearnedEntry>
        }
      } catch {
        // First time: the file is created below.
      }
      all[profile.id] = entry
      await mkdir(stateDir, { recursive: true })
      await writeFileAtomic(path, `${JSON.stringify(all, null, 2)}\n`)
    })
    .catch(() => undefined)
  return learnedWrites
}

function profileSignature(profile: CliProfile): string {
  return JSON.stringify([
    profile.id,
    profile.command,
    profile.args,
    profile.modelArgs ?? [],
    profile.effortArgs ?? [],
    profile.planArgs ?? [],
    profile.autoArgs ?? []
  ])
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

  // Last resort: many installers keep the binary in `<home>/<tool>/bin` and add
  // that directory to the user's shell profile only. The app is usually started
  // from Finder/Explorer, so it never sees that PATH. The pattern is generic:
  // no product name is involved, and the scan happens only when the command was
  // not found anywhere else.
  for (const directory of nestedBinDirectories(home)) {
    for (const candidate of candidatePaths(join(directory, cleaned))) {
      if (isExecutable(candidate)) return candidate
    }
  }

  return undefined
}

const SAFE_COMMAND = /^[A-Za-z0-9._+@/\\:-]+$/

/** The shell the user actually logs in with, when this platform has one. */
function loginShell(): string {
  if (process.platform === 'win32') return ''
  const fromEnv = process.env.SHELL
  if (fromEnv && isAbsolute(fromEnv)) return fromEnv
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

/**
 * Resolves a command through the user's own shell.
 *
 * An app launched from Finder/Explorer inherits a minimal PATH, while the CLI
 * was installed by a line in `.zshrc`/`.bashrc`. `findBinary` covers the common
 * install directories; this covers everything else, using the shell the user
 * configured. The command is whitelisted before it reaches the shell, so the
 * prompt can never become a command line.
 */
export async function resolveBinaryViaShell(
  command: string,
  options: { home?: string; timeoutMs?: number } = {}
): Promise<string | undefined> {
  const cleaned = command.trim()
  if (!cleaned || !SAFE_COMMAND.test(cleaned)) return undefined
  const shell = loginShell()
  if (!shell) return undefined

  // `-l` loads the login profile; `-i` also loads the interactive rc, where
  // most installers append their PATH. Two attempts, each bounded.
  for (const flags of [['-lc'], ['-ilc']]) {
    const found = await new Promise<string | undefined>((resolve) => {
      execFile(
        shell,
        [...flags, `command -v ${cleaned}`],
        {
          timeout: options.timeoutMs ?? 5_000,
          killSignal: 'SIGKILL',
          windowsHide: true,
          maxBuffer: 64 * 1024,
          env: { ...process.env, ...(options.home ? { HOME: options.home } : {}) }
        },
        (_error, stdout) => {
          const line = String(stdout ?? '')
            .split('\n')
            .map((entry) => entry.trim())
            .find(Boolean)
          resolve(line && isAbsolute(line) && isExecutable(line) ? line : undefined)
        }
      )
    })
    if (found) return found
  }

  return undefined
}

/** `<home>/<name>/bin` for every folder directly under the home directory. */
function nestedBinDirectories(home: string): string[] {
  const directories: string[] = []
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const bin = join(home, entry.name, 'bin')
      try {
        if (statSync(bin).isDirectory()) directories.push(bin)
      } catch {
        // No bin folder: the usual case.
      }
    }
  } catch {
    // An unreadable home directory is not worth failing a lookup over.
  }
  return directories
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

  // Before scanning for partial names: the command may be installed on a PATH
  // that only the user's shell knows about.
  if (cleaned.length >= 3 && !cleaned.includes('/') && !cleaned.includes('\\')) {
    const viaShell = await resolveBinaryViaShell(cleaned, { home, timeoutMs: 800 })
    if (viaShell) {
      const version = await versionOf(viaShell)
      return [
        {
          name: displayName(basename(viaShell)),
          path: viaShell,
          ...(version ? { version } : {})
        }
      ]
    }
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

export function modelNames(value: unknown, path?: string): string[] {
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
  // A profile saved with a bare command (or an older profile) may only be
  // resolvable through the user's shell; without this the list comes back
  // empty and the model selector has nothing to show.
  const binary =
    findBinary(profile.command, home, workspace) ??
    (await resolveBinaryViaShell(profile.command, { home, timeoutMs: 4_000 }))
  if (!binary) return []

  const args = profile.modelsArgs.map((arg) =>
    arg.replace(/\{workspace\}/g, workspace ?? '').replace(/\{model\}/g, '')
  )

  // A `.cmd` shim on Windows cannot be execFile'd directly; its JS entry can.
  const node = findBinary('node', home)
  const target = spawnTarget(binary, args, { ...(node ? { node } : {}), allowShell: true })
  if (!target) return []

  // A models command may print its list to stderr, or print it and then exit
  // non-zero over an unrelated warning (a missing telemetry key, an update
  // check). Reading only a clean stdout turned a working list into an empty
  // picker, which is exactly what the user sees as "there is no list".
  const probe = (): Promise<string> =>
    new Promise<string>((resolve) => {
      execFile(
        target.file,
        target.args,
        {
          // A cold Windows start of an agent CLI loads its whole runtime before
          // the first id: a minute was still not enough on some machines.
          timeout: 120_000,
          killSignal: 'SIGKILL',
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, ...target.env },
          ...(workspace ? { cwd: workspace } : {})
        },
        (_error, stdout, stderr) => {
          const out = String(stdout ?? '')
          resolve(out.trim() ? out : String(stderr ?? ''))
        }
      )
    })

  const format = profile.modelsFormat ?? 'lines'
  const parse = (output: string): string[] => {
    if (format === 'json') {
      try {
        const parsed: unknown = JSON.parse(output)
        return [...new Set(modelNames(parsed, profile.modelsPath))].slice(0, 400)
      } catch {
        return []
      }
    }
    return [...new Set(modelNamesFromOutput(output))].slice(0, 400)
  }

  // Some CLIs load their provider list in the background and answer the models
  // command before that list exists: `opencode models` prints nothing and exits
  // 0 on a cold start, while the same command works seconds later. Without the
  // retry the picker stays empty and the CLI looks like it has no models.
  for (let attempt = 0; attempt < MODEL_LIST_ATTEMPTS; attempt += 1) {
    const started = Date.now()
    const output = await probe()
    if (output.trim()) return parse(output)
    if (Date.now() - started > MODEL_LIST_RETRY_MAX_MS) break
    if (attempt < MODEL_LIST_ATTEMPTS - 1) await delay(MODEL_LIST_RETRY_MS * (attempt + 1))
  }
  return []
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

export interface RunHooks {
  onText?: (text: string) => void
  onActivity?: (activity: string) => void
  onStderr?: (line: string) => void
  signal?: AbortSignal
  timeoutMs?: number
  home?: string
  /** App config dir: where a learned flag decision survives a restart. */
  stateDir?: string
}

/**
 * Only a fast failure with no answer looks like a rejected argument. Repeating
 * the turn is what turns "axet-code è uscita con codice 1" into a working turn
 * on the CLI's default model, with a note saying why.
 */
function shouldRetryWithoutModel(
  options: AgentRunOptions,
  result: ExternalRunResult
): boolean {
  if (!options.model) return false
  if (result.aborted || result.timedOut) return false
  if (result.code === 0 || !result.error) return false
  if (result.text.trim()) return false
  return result.ms < FAST_FAILURE_WINDOW_MS
}

/**
 * Runs one task through a CLI profile.
 *
 * Resolves with a result even on a non-zero exit, timeout or abort: the agent
 * decides what to do with it, and the UI shows the real reason instead of a
 * generic rejection. Only a spawn failure (binary missing, permissions)
 * rejects.
 */
export async function runExternalAgent(
  profile: CliProfile,
  options: AgentRunOptions,
  hooks: RunHooks = {}
): Promise<ExternalRunResult> {
  if (hooks.signal?.aborted) {
    return {
      text: '',
      raw: '',
      code: -1,
      stderr: '',
      ms: 0,
      timedOut: false,
      aborted: true,
      error: `${profile.label} interrotta`
    }
  }

  const binary = findBinary(profile.command, hooks.home ?? homedir(), options.workspace)
  if (!binary) {
    throw new Error(
      `${profile.label}: comando "${profile.command}" non trovato. Controlla il percorso nel profilo.`
    )
  }

  const signature = profileSignature(profile)
  await loadLearned(hooks.stateDir)
  const remembered = refusedFlagsByProfile.get(signature) ?? {}
  const adjustments: ArgvAdjustments = {
    placements: { ...(remembered.placements ?? {}) },
    refusedArgs: [...(remembered.refusedArgs ?? [])]
  }
  const placements = adjustments.placements ?? {}
  const refusedArgs = adjustments.refusedArgs ?? []
  let result = await attempt(profile, options, hooks, binary, adjustments)

  // A CLI can document a flag at the top level and refuse it in the subcommand
  // that runs the prompt (`cli run --yolo` answers "Unknown flag: --yolo"):
  // the flag is global and belongs before the subcommand, or the CLI never had
  // it. Its own error names the flag, so the turn is repeated with the flag
  // moved and then without it, instead of dying on something the user never
  // typed. Only a flag the CLI itself named is ever touched.
  let refused: RefusedFlag[] = []
  let refusedCode = 0
  for (let round = 0; round < 4; round++) {
    const rejected = rejectedGroups(profile, options, result, adjustments)
    if (rejected.length === 0) break
    refused = rejected
    refusedCode = result.code
    for (const entry of rejected) {
      if (entry.group === 'args') {
        if (!refusedArgs.includes(entry.flag)) refusedArgs.push(entry.flag)
      } else {
        placements[entry.group] = placements[entry.group] === undefined ? 'before' : 'off'
      }
    }
    result = await attempt(profile, options, hooks, binary, adjustments)
    if (result.aborted || result.timedOut) return result
  }
  // Awaited so the decision is on disk before the turn is reported: the next
  // launch of the app is exactly the case this memory exists for.
  if (refused.length > 0) await rememberFlags(hooks.stateDir, profile, signature, adjustments)

  const notes: string[] = []
  if (refused.length > 0) {
    const flags = [...new Set(refused.map((entry) => `"${entry.flag}"`))].join(', ')
    const removed = refused.some((entry) =>
      entry.group === 'args' ? true : placements[entry.group] === 'off'
    )
    const how = removed ? 'senza quel flag' : 'con il flag prima del sottocomando'
    const outcome =
      result.code === 0 && !result.error
        ? 'e il turno è andato a buon fine'
        : `ma la CLI è ancora uscita con codice ${result.code}`
    notes.push(
      `${profile.label} ha rifiutato ${flags} (uscita ${refusedCode}): ho ripetuto il turno ${how}, ${outcome}.${removed ? ' La scelta resta memorizzata: i prossimi turni non riprovano il flag.' : ''}`
    )
  }

  if (shouldRetryWithoutModel(options, result) && (placements.model ?? 'after') !== 'off') {
    // The CLI rejected the model instead of doing the work. Retrying without it
    // costs one process and keeps the turn usable; the note says the model was
    // not applied, so nothing is hidden from the user.
    const retry = await attempt(
      profile,
      { ...options, model: undefined },
      hooks,
      binary,
      adjustments
    )
    if (!retry.error && !retry.aborted) {
      notes.push(
        `${profile.label} non ha accettato il modello "${options.model}" (uscita ${result.code}): ho ripetuto il turno con il modello predefinito della CLI.`
      )
      return { ...retry, warning: notes.join(' ') }
    }
  }

  return notes.length > 0 ? { ...result, warning: notes.join(' ') } : result
}

/** One CLI process: the argv, the spawn, the streams and the timeout. */
function attempt(
  profile: CliProfile,
  options: AgentRunOptions,
  hooks: RunHooks,
  binary: string,
  adjustments: ArgvAdjustments = {}
): Promise<ExternalRunResult> {
  const argv = buildCliArgs(profile, options, adjustments)
  const started = Date.now()
  const timeoutMs =
    hooks.timeoutMs ?? (profile.timeoutSeconds ? profile.timeoutSeconds * 1_000 : DEFAULT_TIMEOUT_MS)
  const useStdin = promptOnStdin(profile)

  // On Windows an npm/pnpm CLI is a `.cmd` shim, which node cannot spawn
  // without a shell — and a shell would re-parse the prompt. The JS entry the
  // shim points at is run instead, so the prompt stays data.
  const node = findBinary('node', hooks.home ?? homedir())
  const target = spawnTarget(binary, argv, node ? { node } : {})
  if (!target) {
    return Promise.resolve({
      text: '',
      raw: '',
      code: -1,
      stderr: '',
      ms: 0,
      timedOut: false,
      aborted: false,
      error: `${profile.label}: "${basename(binary)}" è uno script .cmd senza entry JavaScript. Installa la versione nativa della CLI o indica il percorso del suo eseguibile nel profilo.`
    })
  }

  return new Promise<ExternalRunResult>((resolve, reject) => {
    const child = spawn(target.file, target.args, {
      cwd: options.workspace,
      shell: false,
      windowsHide: true,
      // A process group of its own, so the whole tree can be killed.
      detached: process.platform !== 'win32',
      env: { ...process.env, ...target.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
    })

    let text = ''
    let raw = ''
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
      raw = (raw + chunk).slice(-MAX_OUTPUT)
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
    } else {
      // In argument mode the prompt is already in argv: close stdin, or a CLI
      // that also watches it waits forever for an EOF that never comes.
      child.stdin?.on('error', () => undefined)
      child.stdin?.end()
    }

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      hooks.signal?.removeEventListener('abort', stop)
      if (buffer.trim()) consume(buffer)

      const exitCode = code ?? -1
      // The CLI's own words are the only useful diagnosis: without them the
      // user reads "codice 1" and has nothing to act on. A CLI that logs a bare
      // `ERROR` and the reason on the next line needs more than the first line.
      const stderrLines = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      // Some CLIs explain the failure on stdout and leave a bare `ERROR` on
      // stderr: both are read, and the last line of stdout usually carries the
      // real reason.
      const stdoutTail = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-1)[0]
      const detail = [...new Set([...stderrLines.slice(0, 3), ...(stdoutTail ? [stdoutTail] : [])])]
        .join(' | ')
        .slice(0, 400)

      // The prompt is the bulk of the argv: shortening it keeps the command
      // readable and still reproducible by pasting the prompt back in.
      const displayCommand = formatCommand(
        binary,
        argv.map((arg) => (arg === options.prompt ? '…' : arg))
      ).slice(0, 400)

      const failure = timedOut
        ? `${profile.label} non ha risposto entro ${Math.round(timeoutMs / 1000)}s`
        : aborted
          ? `${profile.label} interrotta`
          : exitCode !== 0
            ? `${profile.label} è uscita con codice ${exitCode}${detail ? `: ${detail}` : ''}\nComando: ${displayCommand}`
            : undefined

      resolve({
        text: text.trim(),
        raw: raw.trim(),
        code: exitCode,
        stderr: stderr.trim(),
        ms: Date.now() - started,
        timedOut,
        aborted,
        command: displayCommand,
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
