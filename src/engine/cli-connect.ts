import { execFile } from 'node:child_process'
import { basename, extname } from 'node:path'
import { spawnTarget } from './cli-shim'
import { modelNamesFromOutput } from './model-list'
import type { CliFinding, CliProfile } from './types'
import type { Platform } from './platform'
import {
  findBinary,
  formatCommand,
  modelNames,
  profileModels,
  resolveBinaryViaShell
} from './external-agents'
import { introspectCli, hasPromptMechanism } from './cli-introspect'
import { readCliProfile, saveCliProfile, slugifyProfileId } from './cli-profiles'

/**
 * One-step connection of an external CLI.
 *
 * The user knows the command they type in a terminal (`opencode`, a corporate
 * wrapper, a personal script). Everything else — the flags, the model list, the
 * profile file — is discovered from the CLI itself:
 *
 *  1. resolve the command the way a shell would;
 *  2. read its own `--help` for the model/effort/output flags;
 *  3. find the command that prints its models, trying the usual spellings;
 *  4. save a profile (or fill the one already saved) and return the models.
 *
 * No product name is hardcoded: `opencode`, `axet-code` and `my-agent` take the
 * same path. Nothing here installs software or reads credentials.
 */

// The listing parser lives on its own so the profile probe and the connect step
// cannot drift: a CLI that answers with help text must never become a picker
// entry. Re-exported for the tests and the panel.
export { modelNamesFromOutput }

/**
 * Model commands are tried in this order. Flags come first because a CLI that
 * does not know them fails in milliseconds, while a positional subcommand may
 * open an interactive screen and wait for the timeout.
 */
const MODEL_CANDIDATES: string[][] = [
  ['--list-models'],
  ['models'],
  ['models', 'list'],
  ['model', 'list'],
  ['list-models'],
  ['--models']
]

// A models command is not a fast query: opencode and the CLIs that wrap a
// provider load their whole runtime before printing the first id, and on a cold
// Windows start that easily passes ten seconds. Eight seconds used to turn a
// working command into "this CLI cannot list its models".
const PROBE_TIMEOUT_MS = 60_000

interface Capture {
  stdout: string
  stderr: string
  code: number
}

/** Runs one candidate command. Resolves even on a non-zero exit or timeout. */
function capture(
  binary: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number }
): Promise<Capture> {
  return new Promise((resolve) => {
    // On Windows the CLI is often a `.cmd` shim: probes may go through the
    // shell, since no prompt is involved here.
    const target = spawnTarget(binary, args, { allowShell: true })
    if (!target) {
      resolve({ stdout: '', stderr: '', code: -1 })
      return
    }
    execFile(
      target.file,
      target.args,
      {
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: { ...process.env, ...target.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
      },
      (error, stdout, stderr) => {
        const code = (error as (Error & { code?: number }) | null)?.code
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: typeof code === 'number' ? code : error ? -1 : 0
        })
      }
    )
  })
}

export interface ModelCommand {
  /** argv that prints the models. */
  args: string[]
  models: string[]
  /** How the output must be read; defaults to one model per line. */
  format?: 'lines' | 'json'
  /** Dot path of the model array inside a JSON document. */
  path?: string
}

/**
 * Finds the command that prints the CLI's models, if it has one.
 *
 * A models command is not part of any standard: some CLIs list them under
 * `models`, some under a flag. The first spelling that prints something that
 * looks like model ids wins, and the argv is kept so the profile can repeat it.
 */
export async function discoverModelCommand(
  binary: string,
  options: { workspace?: string; timeoutMs?: number } = {}
): Promise<ModelCommand | undefined> {
  const cwd = options.workspace ? { cwd: options.workspace } : {}
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS

  // All spellings at once: a CLI that does not know a flag answers in
  // milliseconds, while the one that lists its models may take half a minute.
  // Run in parallel the wait is the slowest probe, not the sum of six.
  const results = await Promise.all(
    MODEL_CANDIDATES.map((args) => capture(binary, args, { ...cwd, timeoutMs }))
  )

  const silent: number[] = []
  for (const [index, result] of results.entries()) {
    const args = MODEL_CANDIDATES[index]
    if (!args) continue
    const models = modelNamesFromOutput(result.stdout || result.stderr)
    if (models.length > 0) return { args, models }
    // Exit 0 and nothing printed is the signature of a CLI whose provider list
    // is still loading (opencode answers `models` that way on a cold start).
    if (result.code === 0 && !result.stdout.trim() && !result.stderr.trim()) silent.push(index)
  }

  // Only the probes that answered "nothing yet" are repeated: the ones that
  // printed an error or opened a screen already said their word.
  if (silent.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    for (const index of silent) {
      const args = MODEL_CANDIDATES[index]
      if (!args) continue
      const retry = await capture(binary, args, { ...cwd, timeoutMs })
      const models = modelNamesFromOutput(retry.stdout || retry.stderr)
      if (models.length > 0) return { args, models }
    }
  }

  return undefined
}

/* --------------------------- models, with help --------------------------- */

export interface ModelListHint {
  args: string[]
  format: 'lines' | 'json'
  path?: string
}

/**
 * Asks a model to read the CLI's help and name the argv that prints its models.
 * A models command is not standard, so guessing its spelling is guesswork; the
 * help text is the one place where the CLI says it itself.
 */
export function modelHintPrompt(input: {
  command: string
  help: string
  attempts: { args: string[]; output: string }[]
}): string {
  const attempts = input.attempts
    .map(
      (attempt) =>
        `$ ${input.command} ${attempt.args.join(' ')}\n${attempt.output.trim() || '(nessun output)'}`
    )
    .join('\n\n')

  return [
    'Devo configurare una CLI dentro un’app che la usa come backend. Mi serve l’argv che stampa gli id dei modelli che quella CLI può usare.',
    `Comando: ${input.command}`,
    '',
    '--- output di --help ---',
    input.help.trim() || '(nessun help)',
    '',
    '--- comandi che non hanno stampato una lista di modelli ---',
    attempts || '(nessuno)',
    '',
    'Rispondi SOLO con JSON, senza prosa:',
    '{"args":["models"],"format":"lines"}',
    'Se il comando stampa un documento JSON usa "format":"json" e, quando serve, "path" (esempio: {"args":["models","--json"],"format":"json","path":"data"}).',
    'Se la CLI non ha un modo per elencare i modelli, rispondi {"args":[]}.',
    'Non proporre comandi che aprono schermate interattive, modificano file o chiedono input.'
  ].join('\n')
}

/** Reads the JSON answer, tolerating prose and fences around it. */
export function parseModelHint(reply: string): ModelListHint | undefined {
  const start = reply.indexOf('{')
  if (start < 0) return undefined

  for (let end = reply.lastIndexOf('}'); end > start; end = reply.lastIndexOf('}', end - 1)) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>
    } catch {
      continue
    }

    const raw = Array.isArray(parsed.args)
      ? parsed.args.filter((arg): arg is string => typeof arg === 'string').map((arg) => arg.trim())
      : []
    const args = raw.filter((arg) => arg.length > 0)
    // No args means "this CLI cannot list its models": that is an answer, not a
    // command, and the caller must not save it.
    if (args.length === 0 || args.length > 6) return undefined
    if (args.some((arg) => arg.length > 200 || /[\r\n]/.test(arg))) return undefined

    const path =
      typeof parsed.path === 'string' && parsed.path.trim()
        ? parsed.path.trim().slice(0, 200)
        : undefined
    return {
      args,
      format: parsed.format === 'json' ? 'json' : 'lines',
      ...(path ? { path } : {})
    }
  }

  return undefined
}

function jsonModelNames(stdout: string, path?: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return [...new Set(modelNames(parsed, path))].slice(0, 400)
  } catch {
    return []
  }
}

/**
 * Last resort for the model list: ask the app's own model which command prints
 * the models, then run it. The answer is verified before it is used, so a wrong
 * guess costs one probe and nothing else.
 */
export async function askModelCommand(
  binary: string,
  ask: (prompt: string) => Promise<string>,
  options: { workspace?: string; timeoutMs?: number } = {}
): Promise<ModelCommand | undefined> {
  const cwd = options.workspace ? { cwd: options.workspace } : {}
  // The help and the failed probes are what the model reads: collect them in
  // one round trip instead of one process after the other.
  const [helpResult, ...probes] = await Promise.all([
    capture(binary, ['--help'], { ...cwd, timeoutMs: 15_000 }),
    ...MODEL_CANDIDATES.slice(0, 4).map((args) =>
      capture(binary, args, { ...cwd, timeoutMs: 15_000 })
    )
  ])

  let help = helpResult.stdout || helpResult.stderr
  if (!help.trim()) {
    help = (await capture(binary, ['-h'], { ...cwd, timeoutMs: 8_000 })).stdout
  }

  const attempts: { args: string[]; output: string }[] = []
  for (const [index, result] of probes.entries()) {
    const args = MODEL_CANDIDATES[index]
    if (!args) continue
    attempts.push({ args, output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 800) })
  }

  let hint: ModelListHint | undefined
  try {
    hint = parseModelHint(
      await ask(modelHintPrompt({ command: binary, help: help.slice(0, 6_000), attempts }))
    )
  } catch {
    return undefined
  }
  if (!hint) return undefined

  const result = await capture(binary, hint.args, {
    ...cwd,
    timeoutMs: options.timeoutMs ?? 60_000
  })
  const output = result.stdout || result.stderr
  const models =
    hint.format === 'json' ? jsonModelNames(output, hint.path) : modelNamesFromOutput(output)
  if (models.length === 0) return undefined

  return {
    args: hint.args,
    models,
    format: hint.format,
    ...(hint.path ? { path: hint.path } : {})
  }
}

/** `opencode` from `/usr/local/bin/opencode`, and `tool` from `tool.exe`. */
function commandLabel(path: string): string {
  const name = basename(path)
  const extension = extname(name).toLowerCase()
  return ['.exe', '.cmd', '.bat', '.com'].includes(extension)
    ? name.slice(0, -extension.length)
    : name
}

export interface ConnectCliInput {
  /** The command the user would type in a terminal, or an absolute path. */
  command: string
  /** Optional display name; defaults to the command name. */
  label?: string
  /** Project folder: the CLI runs there, so relative commands resolve. */
  workspace?: string
  /**
   * Asks the app's own model how to list the models when no probe worked.
   * Optional: without it the connect step stays fully local.
   */
  ask?: (prompt: string) => Promise<string>
}

export interface ConnectCliResult {
  profile: CliProfile
  /** Resolved executable. */
  path: string
  version?: string
  helpRead: boolean
  findings: CliFinding[]
  warnings: string[]
  /** Models the CLI reported, already normalized. */
  models: string[]
  /** The exact command used to list the models, when one was found. */
  modelsCommand?: string
  /** An existing profile with this id was reused instead of created. */
  existing: boolean
}

/**
 * Resolves a command, reads what it says about itself, discovers its models and
 * saves a profile. Reconnecting the same command keeps the user's edits: only
 * the missing model command is filled in.
 */
export async function connectCli(
  platform: Platform,
  input: ConnectCliInput
): Promise<ConnectCliResult> {
  const command = input.command.trim()
  if (!command) throw new Error('Scrivi il comando con cui avvii la CLI.')

  // PATH first (fast), then the user's own shell: a CLI installed by a line in
  // `.zshrc` is invisible to an app launched from Finder.
  const binary =
    findBinary(command, platform.homeDir, input.workspace) ??
    (await resolveBinaryViaShell(command, { home: platform.homeDir }))
  if (!binary) {
    throw new Error(
      `Comando "${command}" non trovato. Controlla il nome nel PATH o indica il percorso assoluto della CLI.`
    )
  }

  const label = input.label?.trim() || commandLabel(binary)
  const id = slugifyProfileId(label) || slugifyProfileId(commandLabel(binary)) || 'cli'
  const saved = await readCliProfile(platform, id)

  const introspection = await introspectCli(binary, {
    home: platform.homeDir,
    // Reconnecting an existing profile reads the help of the subcommand it
    // already uses: that is where its format and model flags are documented.
    ...(saved?.args.length ? { args: saved.args } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {})
  })

  const proposal = introspection.proposal
  const warnings = [...introspection.warnings]
  const findings = [...introspection.findings]

  // A profile saved while the CLI's help was unreadable (a Windows `.cmd` that
  // answered nothing) has no way to hand the prompt over. Adopting the proposal
  // that does is what turns `<cli> "prompt"` — a project folder for a TUI-first
  // CLI — into `<cli> run "prompt"`.
  const savedArgs = saved?.args ?? []
  const proposedArgs = proposal.args ?? []
  const args =
    !hasPromptMechanism(savedArgs) && hasPromptMechanism(proposedArgs)
      ? proposedArgs
      : saved
        ? savedArgs
        : proposedArgs
  const argsChanged = Boolean(saved) && args.join('\u0000') !== savedArgs.join('\u0000')
  if (argsChanged && args.length > 0) {
    warnings.push(`Ho corretto l’avvio della CLI: il prompt ora passa come ${args.join(' ')}.`)
  }

  let modelsArgs = saved?.modelsArgs ?? proposal.modelsArgs
  // The CLI's own answer is kept even if it prints nothing in time: a models
  // command that needs half a minute is still the right command.
  const declaredModelsArgs = modelsArgs ? [...modelsArgs] : undefined
  let modelsCommand: string | undefined
  let models: string[] = []
  let modelsFormat: 'lines' | 'json' | undefined = saved?.modelsFormat
  let modelsPath: string | undefined = saved?.modelsPath

  const probeProfile: CliProfile = {
    id,
    label,
    // The resolved path, so the model probe works even when the bare name is
    // only visible to the user's shell.
    command: binary,
    args,
    ...(modelsArgs ? { modelsArgs } : {})
  }

  if (modelsArgs) {
    models = await profileModels(probeProfile, platform.homeDir, input.workspace)
    if (models.length > 0) {
      modelsCommand = formatCommand(binary, modelsArgs)
    } else {
      // The help promised a model list, but it printed nothing usable.
      modelsArgs = undefined
    }
  }

  if (!modelsArgs) {
    const discovered = await discoverModelCommand(binary, {
      ...(input.workspace ? { workspace: input.workspace } : {})
    })
    if (discovered) {
      modelsArgs = discovered.args
      models = discovered.models
      modelsFormat = discovered.format
      modelsPath = discovered.path
      modelsCommand = formatCommand(binary, discovered.args)
      findings.push({
        field: 'models',
        label: 'modelli',
        evidence: discovered.args.join(' ')
      })
    }
  }

  // Nothing printed a model list. Ask the model the app already uses to read
  // the CLI's own help: that is how an unknown CLI becomes usable without the
  // user writing a models command by hand.
  if (!modelsArgs && input.ask) {
    const asked = await askModelCommand(binary, input.ask, {
      ...(input.workspace ? { workspace: input.workspace } : {})
    }).catch(() => undefined)
    if (asked) {
      modelsArgs = asked.args
      models = asked.models
      modelsFormat = asked.format
      modelsPath = asked.path
      modelsCommand = formatCommand(binary, asked.args)
      findings.push({
        field: 'models',
        label: 'modelli (dedotti dall’help)',
        evidence: asked.args.join(' ')
      })
    }
  }

  if (!modelsArgs && declaredModelsArgs) {
    modelsArgs = declaredModelsArgs
    warnings.push(
      'Il comando modelli non ha stampato nulla in tempo: l’ho lasciato nel profilo. Premi ↻ accanto al selettore per riprovare.'
    )
  }

  if (!modelsArgs) {
    warnings.push(
      'Nessun comando per elencare i modelli: la CLI userà il suo predefinito. Puoi scrivere il nome del modello accanto al selettore del modello.'
    )
  }

  // The user's argv wins; only a missing (or silent) model command is filled in.
  const sameModelsArgs =
    saved?.modelsArgs &&
    modelsArgs &&
    saved.modelsArgs.join('\u0000') === modelsArgs.join('\u0000')

  // The list is reused by the picker for a few minutes: re-reading a slow CLI
  // on every selection is what made the selector look empty.
  const modelsCache =
    models.length > 0 && modelsArgs
      ? { args: [...modelsArgs], at: new Date().toISOString(), models: models.slice(0, 400) }
      : undefined

  const profile: CliProfile = saved
    ? {
        ...saved,
        ...(argsChanged ? { args } : {}),
        // A saved profile gets the structured format the first time its help
        // advertises one: without it the transcript only ever sees prose.
        ...(proposal.outputArgs && !saved.outputArgs?.length
          ? { outputArgs: proposal.outputArgs, output: proposal.output ?? saved.output }
          : {}),
        ...(modelsArgs && !sameModelsArgs ? { modelsArgs } : {}),
        ...(modelsFormat ? { modelsFormat } : {}),
        ...(modelsPath ? { modelsPath } : {}),
        ...(modelsCache ? { modelsCache } : {})
      }
    : {
        id,
        label,
        // The resolved path keeps working even when the app's PATH differs from
        // the user's shell the next time the profile is used.
        command: binary,
        args,
        ...(proposal.promptMode ? { promptMode: proposal.promptMode } : {}),
        ...(proposal.output ? { output: proposal.output } : {}),
        ...(proposal.outputArgs ? { outputArgs: proposal.outputArgs } : {}),
        // A CLI that can list models but does not advertise the flag still
        // takes one: store the usual spelling so the panel shows it and the
        // user can correct it, instead of hiding the model picker.
        modelArgs: proposal.modelArgs ?? ['--model', '{model}'],
        ...(proposal.effortArgs ? { effortArgs: proposal.effortArgs } : {}),
        ...(proposal.effortValues ? { effortValues: proposal.effortValues } : {}),
        ...(proposal.planArgs ? { planArgs: proposal.planArgs } : {}),
        ...(proposal.autoArgs ? { autoArgs: proposal.autoArgs } : {}),
        ...(modelsArgs ? { modelsArgs } : {}),
        ...(modelsFormat ? { modelsFormat } : {}),
        ...(modelsPath ? { modelsPath } : {}),
        ...(modelsCache ? { modelsCache } : {})
      }

  const persisted = await saveCliProfile(platform, profile)

  return {
    profile: persisted,
    path: binary,
    ...(introspection.version ? { version: introspection.version } : {}),
    helpRead: introspection.helpRead,
    findings,
    warnings: [...new Set(warnings)],
    models,
    ...(modelsCommand ? { modelsCommand } : {}),
    existing: Boolean(saved)
  }
}

/**
 * Repairs a profile that cannot hand its prompt to the CLI.
 *
 * A profile saved before the help was readable on this machine (a Windows
 * `.cmd` that answered nothing) has an empty argv: every turn then runs as
 * `<cli> "prompt"`, which a TUI-first CLI reads as a project folder. The fix is
 * the one `connectCli` applies — read the help and adopt the non-interactive
 * subcommand — applied to a profile that already exists, so the user does not
 * have to delete and recreate it.
 */
/**
 * True when the profile still prints for humans: no format flag was chosen and
 * the output was not pinned to plain text by the user. Without a structured
 * format the app can only show the CLI's prose — no commands, no files, no
 * workers — which is exactly the turn that looks stuck.
 */
function wantsStructuredOutput(profile: CliProfile): boolean {
  if (profile.output === 'text') return false
  if (profile.outputArgs?.length) return false
  return !profile.args.some((arg) =>
    /^--?(format|output-format|output|json|jsonl|json-lines|stream-json)$/i.test(arg)
  )
}

export async function ensureCliArgs(
  platform: Platform,
  profile: CliProfile,
  workspace?: string
): Promise<CliProfile> {
  const needsArgs = !hasPromptMechanism(profile.args)
  const needsOutput = wantsStructuredOutput(profile)
  if (!needsArgs && !needsOutput) return profile

  const binary =
    findBinary(profile.command, platform.homeDir, workspace) ??
    (await resolveBinaryViaShell(profile.command, {
      home: platform.homeDir,
      timeoutMs: 4_000
    }))
  if (!binary) return profile

  const introspection = await introspectCli(binary, {
    home: platform.homeDir,
    // The argv names the subcommand that runs a turn: its help is the one
    // that documents the format flag.
    args: profile.args,
    ...(workspace ? { workspace } : {})
  }).catch(() => undefined)

  const repaired: CliProfile = { ...profile }
  let changed = false

  if (needsArgs) {
    const proposed = introspection?.proposal.args ?? []
    if (hasPromptMechanism(proposed)) {
      repaired.args = proposed
      changed = true
    }
  }

  if (needsOutput && introspection?.proposal.outputArgs?.length) {
    repaired.outputArgs = introspection.proposal.outputArgs
    if (introspection.proposal.output) repaired.output = introspection.proposal.output
    changed = true
  }

  if (!changed) return profile
  return saveCliProfile(platform, repaired).catch(() => repaired)
}
