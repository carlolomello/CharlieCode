import { execFile } from 'node:child_process'
import { basename, extname } from 'node:path'
import type { CliFinding, CliProfile } from './types'
import type { Platform } from './platform'
import {
  findBinary,
  formatCommand,
  profileModels,
  resolveBinaryViaShell
} from './external-agents'
import { introspectCli } from './cli-introspect'
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

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

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

const PROBE_TIMEOUT_MS = 8_000

/**
 * Turns a models listing into model names.
 *
 * CLIs print either one id per line, or a decorated table. Prose, headers and
 * usage errors are dropped; bullets are stripped; duplicates are collapsed in
 * the order the CLI printed them. Pure on purpose: the panel and the tests use
 * the same rule, and a noisy listing must not become a picker full of garbage.
 */
export function modelNamesFromOutput(output: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()

  for (const raw of output.replace(ANSI, '').split('\n')) {
    const line = raw
      .trim()
      .replace(/^[-*•]\s+/, '')
      .trim()
    if (!line || line.length > 120) continue
    if (/^[[{]/.test(line)) continue
    if (line.endsWith(':')) continue
    if (/^(no|nessun)\s+models?/i.test(line)) continue
    if (/^available\s+models?$/i.test(line)) continue
    if (/^(error|usage|unknown|unrecognized|invalid)\b/i.test(line)) continue
    if (/^(models?|model list)$/i.test(line)) continue
    if (!/[a-z0-9]/i.test(line)) continue
    // A sentence is not a model id. Display names with a couple of words pass.
    if (line.split(/\s+/).length > 6) continue

    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(line)
  }

  return names.slice(0, 500)
}

interface Capture {
  stdout: string
  stderr: string
}

/** Runs one candidate command. Resolves even on a non-zero exit or timeout. */
function capture(
  binary: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number }
): Promise<Capture> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      {
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
      },
      (_error, stdout, stderr) => {
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

export interface ModelCommand {
  /** argv that prints the models. */
  args: string[]
  models: string[]
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
  for (const args of MODEL_CANDIDATES) {
    const result = await capture(binary, args, {
      ...(options.workspace ? { cwd: options.workspace } : {}),
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS
    })
    const models = modelNamesFromOutput(result.stdout || result.stderr)
    if (models.length > 0) return { args, models }
  }
  return undefined
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

  const introspection = await introspectCli(binary, {
    home: platform.homeDir,
    ...(input.workspace ? { workspace: input.workspace } : {})
  })

  const label = input.label?.trim() || commandLabel(binary)
  const id = slugifyProfileId(label) || slugifyProfileId(commandLabel(binary)) || 'cli'
  const saved = await readCliProfile(platform, id)

  const proposal = introspection.proposal
  const warnings = [...introspection.warnings]
  const findings = [...introspection.findings]

  let modelsArgs = saved?.modelsArgs ?? proposal.modelsArgs
  let modelsCommand: string | undefined
  let models: string[] = []

  const probeProfile: CliProfile = {
    id,
    label,
    // The resolved path, so the model probe works even when the bare name is
    // only visible to the user's shell.
    command: binary,
    args: saved?.args ?? proposal.args ?? [],
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
      modelsCommand = formatCommand(binary, discovered.args)
      findings.push({
        field: 'models',
        label: 'modelli',
        evidence: discovered.args.join(' ')
      })
    }
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

  const profile: CliProfile = saved
    ? {
        ...saved,
        ...(modelsArgs && !sameModelsArgs ? { modelsArgs } : {})
      }
    : {
        id,
        label,
        // The resolved path keeps working even when the app's PATH differs from
        // the user's shell the next time the profile is used.
        command: binary,
        args: proposal.args ?? [],
        ...(proposal.promptMode ? { promptMode: proposal.promptMode } : {}),
        ...(proposal.output ? { output: proposal.output } : {}),
        ...(proposal.modelArgs ? { modelArgs: proposal.modelArgs } : {}),
        ...(proposal.effortArgs ? { effortArgs: proposal.effortArgs } : {}),
        ...(proposal.effortValues ? { effortValues: proposal.effortValues } : {}),
        ...(proposal.planArgs ? { planArgs: proposal.planArgs } : {}),
        ...(proposal.autoArgs ? { autoArgs: proposal.autoArgs } : {}),
        ...(modelsArgs ? { modelsArgs } : {})
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
