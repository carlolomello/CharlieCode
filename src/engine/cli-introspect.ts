import { execFile, type ExecFileException } from 'node:child_process'
import type { CliFinding, CliIntrospection, CliProfile } from './types'
import { findBinary } from './external-agents'
import { spawnTarget } from './cli-shim'

export type { CliFinding, CliIntrospection } from './types'

/**
 * Reads a CLI's own `--help` and proposes a profile.
 *
 * The app still ships no product presets: this only understands the
 * conventions every command-line tool uses (`--model`, `--effort`, `--json`…).
 * Everything it finds is a proposal the user can edit, and nothing is assumed
 * about a vendor. A CLI that answers nothing is simply left to manual setup.
 */

export interface HelpFlag {
  /** Long form, e.g. `--model`. */
  name: string
  /** Short form when the help line pairs one, e.g. `-m`. */
  short?: string
  takesValue: boolean
  description: string
  /** Enum-ish values written in the help line, in the order shown. */
  values: string[]
}

export interface IntrospectOptions {
  home?: string
  workspace?: string
  /** Existing argv, so the proposal adds flags instead of replacing them. */
  args?: string[]
  /** Help timeout. Kept short: a help screen that hangs is not help. */
  timeoutMs?: number
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const FLAG_TOKEN = /(^|[\s,=])(--?[a-zA-Z][\w-]*)/g

function stripAnsi(value: string): string {
  return value.replace(ANSI, '')
}

interface Capture {
  stdout: string
  stderr: string
  failed: boolean
}

/**
 * Runs a command and resolves even on a non-zero exit: help often goes to
 * stderr and still exits 1, and that output is exactly what we need.
 */
function capture(
  binary: string,
  args: string[],
  timeout: number,
  home?: string
): Promise<Capture> {
  return new Promise((resolve) => {
    // On Windows an npm/pnpm CLI is a `.cmd` shim, and node cannot spawn it
    // without a shell. Reading the help through the shim's JavaScript entry is
    // what makes introspection work there at all: before this, `--help`
    // answered nothing, the profile was saved with an empty argv, and the
    // prompt reached the CLI as a bare positional argument.
    const node = findBinary('node', home)
    const target = spawnTarget(binary, args, { ...(node ? { node } : {}), allowShell: true })
    if (!target) {
      resolve({ stdout: '', stderr: '', failed: true })
      return
    }

    execFile(
      target.file,
      target.args,
      {
        timeout,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, ...target.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          failed: Boolean(error)
        })
      }
    )
  })
}

function enumValues(text: string): string[] {
  const candidates: string[] = []

  for (const match of text.matchAll(/[<\[{]([^<>[\]{}]{2,120})[>\]}]/g)) {
    const inner = match[1] ?? ''
    if (/[|,]/.test(inner)) candidates.push(inner)
  }

  const quoted = [...text.matchAll(/"([a-z0-9][\w.-]*)"/gi)].map((match) => match[1] ?? '')
  if (quoted.length >= 2) candidates.push(quoted.join(','))

  const choices = text.match(
    /(?:choices?|possible values|one of|values?|formats?|options?)\s*[:=]\s*([a-z0-9][\w.-]*(?:\s*[,|]\s*[a-z0-9][\w.-]*)+)/i
  )
  if (choices?.[1]) candidates.push(choices[1])

  for (const candidate of candidates) {
    // `possible values: low, medium, high` keeps only the part after the colon.
    const cleaned = candidate.replace(/^[^:]*:\s*/, '')
    const values = cleaned
      .split(/[|,]/)
      .map((value) => value.trim().replace(/^["']|["']$/g, ''))
      .filter(
        (value) =>
          /^[a-z0-9][\w.-]*$/i.test(value) && !/^(and|or|the|default|none)$/i.test(value)
      )
    if (values.length >= 2) return [...new Set(values)].slice(0, 8)
  }

  return []
}

/**
 * Parses the flag table out of a help screen. Only lines that start with a
 * flag are considered, so prose that mentions `--model` in a description is
 * never mistaken for the flag itself.
 */
export function parseHelpFlags(help: string): HelpFlag[] {
  const flags: HelpFlag[] = []

  for (const raw of stripAnsi(help).split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('-')) continue

    // Help aligns descriptions with two spaces or a tab. Everything before
    // that is the flag signature: `-m, --model <id>`.
    const split = trimmed.search(/\s{2,}|\t/)
    const signature = (split < 0 ? trimmed : trimmed.slice(0, split)).trim()
    const description = (split < 0 ? '' : trimmed.slice(split)).trim()

    const tokens = [...signature.matchAll(FLAG_TOKEN)].map((match) => match[2] ?? '')
    const name = tokens.find((token) => token.startsWith('--'))
    const short = tokens.find((token) => token.startsWith('-') && !token.startsWith('--'))
    if (!name && !short) continue

    // Whatever remains after removing the flag tokens is the value placeholder.
    const rest = signature.replace(FLAG_TOKEN, ' ').replace(/[,\s]/g, '')
    const takesValue = rest.length > 0

    flags.push({
      name: name ?? short!,
      ...(name && short ? { short } : {}),
      takesValue,
      description,
      values: enumValues(`${signature} ${description}`)
    })
  }

  return flags
}

function pickFlag(flags: HelpFlag[], names: string[]): HelpFlag | undefined {
  for (const name of names) {
    const found = flags.find((flag) => flag.name === name)
    if (found) return found
  }
  return undefined
}

/** Effort words in the order the description lists them, not our own order. */
function effortWords(description: string): string[] {
  const matches = [
    ...description.matchAll(
      /\b(minimal|low|medium|standard|high|maximum|max|deep|extended|light)\b/gi
    )
  ]
    .map((match) => ({
      index: match.index ?? 0,
      value: (match[1] ?? '').toLowerCase()
    }))
    .sort((a, b) => a.index - b.index)

  const values = [...new Set(matches.map((match) => match.value))]
  return values.length >= 2 ? values.slice(0, 8) : []
}

/** Subcommands listed in a `Commands:` section, never words from prose. */
function commandNames(help: string): string[] {
  const names: string[] = []
  let inSection = false

  for (const line of stripAnsi(help).split('\n')) {
    if (/^\s*(available\s+)?(commands|subcommands)\s*:?\s*$/i.test(line)) {
      inSection = true
      continue
    }
    if (!inSection) continue
    if (!line.trim()) {
      if (names.length > 0) break
      continue
    }
    if (!/^\s+/.test(line)) break

    const name = line.trim().split(/\s{2,}/)[0]?.split(/\s+/)[0]
    if (name && /^[a-z][\w-]*$/i.test(name)) names.push(name)
    if (names.length >= 30) break
  }

  return names
}

/**
 * Subcommands that run one non-interactive turn. Ordered by how common the
 * spelling is, never by vendor: a CLI that lists one of these in its `Commands:`
 * section wants `tool run "prompt"`, and a bare positional is something else
 * entirely (a project folder for every TUI-first CLI).
 */
const RUN_COMMANDS = ['run', 'exec', 'ask', 'prompt', 'send', 'chat', 'generate', 'complete']

/** The subcommand that answers one prompt, when the help lists one. */
export function runSubcommand(help: string): string | undefined {
  const commands = commandNames(help)
  return RUN_COMMANDS.find((name) => commands.includes(name))
}

/**
 * True when the argv says how the prompt gets to the CLI: a `{prompt}`
 * placeholder, a prompt-ish flag, or a non-interactive subcommand first. A
 * profile without any of them can only be spawned in a way that fails.
 */
export function hasPromptMechanism(args: string[]): boolean {
  if (args.some((arg) => arg.includes('{prompt}'))) return true
  if (
    args.some((arg) =>
      /^(-p|--print|--prompt|--message|--instruction|--input|--query|--ask)$/.test(arg)
    )
  ) {
    return true
  }
  const first = args.find((arg) => !arg.startsWith('-'))
  return first ? RUN_COMMANDS.includes(first) : false
}

/**
 * Turns help text into a profile proposal. Pure on purpose: the interesting
 * logic is testable without spawning anything.
 */
export function proposalFromHelp(
  help: string,
  baseArgs: string[] = []
): Pick<CliIntrospection, 'proposal' | 'findings' | 'warnings'> {
  const flags = parseHelpFlags(help)
  const args = [...baseArgs]
  const findings: CliFinding[] = []
  const warnings: string[] = []
  const proposal: Partial<CliProfile> = {}

  const hasArg = (flag: string): boolean =>
    args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))

  const addArgs = (values: string[]): boolean => {
    const flag = values[0]
    if (!flag || hasArg(flag)) return false
    args.push(...values)
    return true
  }

  /* ------------------------- headless / prompt ------------------------- */

  // The subcommand comes first in the argv and wins over a `--prompt` flag:
  // on a TUI-first CLI that flag only pre-fills the interface, so the turn
  // would open a screen, print nothing and look like a hang.
  const sub = runSubcommand(help)
  if (sub) {
    if (!args.includes(sub)) args.unshift(sub)
    findings.push({
      field: 'prompt',
      label: 'prompt',
      evidence: `${sub} (prompt in coda)`
    })
  }

  const headless = pickFlag(flags, [
    '--non-interactive',
    '--noninteractive',
    '--headless',
    '--one-shot',
    '--oneshot',
    '--batch'
  ])
  if (headless && !headless.takesValue && addArgs([headless.name])) {
    findings.push({
      field: 'args',
      label: 'modalità non interattiva',
      evidence: headless.name
    })
  }

  const print = sub ? undefined : pickFlag(flags, ['--print', '--prompt', '--message', '--instruction'])
  const printIsPrompt =
    print &&
    /(prompt|message|instruction|question|headless|non-?interactive|one[- ]shot|single|answer)/i.test(
      `${print.name} ${print.description}`
    )
  if (print && printIsPrompt && !args.some((arg) => arg.includes('{prompt}'))) {
    const added = print.takesValue
      ? addArgs([print.name, '{prompt}'])
      : addArgs([print.name])
    if (added) {
      findings.push({
        field: 'prompt',
        label: 'prompt',
        evidence: print.takesValue ? `${print.name} {prompt}` : `${print.name} (prompt in coda)`
      })
    }
  }

  /* ------------------------------- model ------------------------------- */

  const model =
    pickFlag(flags, ['--model', '--model-id', '--model-name', '--llm', '--model-key']) ??
    flags.find(
      (flag) =>
        (flag.short === '-m' || flag.name === '-m') &&
        /model/i.test(flag.description) &&
        !/message/i.test(flag.description)
    )

  if (model?.takesValue) {
    proposal.modelArgs = [model.name, '{model}']
    findings.push({ field: 'model', label: 'modello', evidence: `${model.name} {model}` })
  } else if (model) {
    warnings.push(
      `${model.name} sembra non accettare un valore: il modello resterà quello predefinito della CLI.`
    )
  } else {
    warnings.push(
      'Nessun flag per il modello riconosciuto: la CLI userà il suo modello predefinito.'
    )
  }

  /* ------------------------------- effort ------------------------------ */

  const effort = pickFlag(flags, [
    '--effort',
    '--reasoning-effort',
    '--thinking-effort',
    '--reasoning',
    '--thinking',
    '--variant',
    '--intensity'
  ])
  if (effort?.takesValue) {
    proposal.effortArgs = [effort.name, '{effort}']
    const values = effort.values.length >= 2 ? effort.values : effortWords(effort.description)
    if (values.length >= 2) proposal.effortValues = values
    findings.push({
      field: 'effort',
      label: 'effort',
      evidence: `${effort.name} {effort}${values.length ? ` (${values.join(', ')})` : ''}`
    })
  }

  /* --------------------------- plan / auto ----------------------------- */

  const readOnly = pickFlag(flags, ['--read-only', '--readonly', '--plan', '--dry-run', '--dryrun'])
  const sandbox = pickFlag(flags, ['--sandbox'])
  const permission = pickFlag(flags, ['--permission-mode', '--approval-mode'])

  const planArgs = readOnly
    ? [readOnly.name]
    : sandbox?.values.includes('read-only')
      ? [sandbox.name, 'read-only']
      : permission?.values.includes('plan')
        ? [permission.name, 'plan']
        : undefined

  if (planArgs) {
    proposal.planArgs = planArgs
    findings.push({ field: 'plan', label: 'sola lettura', evidence: planArgs.join(' ') })
  }

  const autoValue = permission
    ? ['auto', 'yolo', 'bypass', 'full-auto', 'accept-edits', 'never'].find((value) =>
        permission.values.includes(value)
      )
    : undefined
  const autoFlag = pickFlag(flags, [
    '--yes',
    '--auto',
    '--auto-approve',
    '--dangerously-skip-permissions',
    '--yolo',
    '--full-auto',
    '--no-confirm'
  ])

  const autoArgs = autoValue
    ? [permission!.name, autoValue]
    : autoFlag && !autoFlag.takesValue
      ? [autoFlag.name]
      : undefined

  if (autoArgs) {
    proposal.autoArgs = autoArgs
    findings.push({ field: 'auto', label: 'scrittura automatica', evidence: autoArgs.join(' ') })
  }

  /* ------------------------------- output ------------------------------ */

  const output = pickFlag(flags, ['--output-format', '--output', '--format'])
  if (output?.takesValue) {
    if (output.values.includes('stream-json')) {
      if (addArgs([output.name, 'stream-json'])) {
        proposal.output = 'stream-json'
        findings.push({
          field: 'output',
          label: 'output',
          evidence: `${output.name} stream-json`
        })
      }
    } else if (output.values.includes('json')) {
      if (addArgs([output.name, 'json'])) {
        proposal.output = 'auto'
        findings.push({ field: 'output', label: 'output', evidence: `${output.name} json` })
        warnings.push(
          'La CLI stampa JSON: se l’output è su più righe, indica il percorso del testo nelle opzioni avanzate.'
        )
      }
    }
  } else {
    const json = pickFlag(flags, ['--json'])
    if (json && !json.takesValue && addArgs([json.name])) {
      proposal.output = 'auto'
      findings.push({ field: 'output', label: 'output', evidence: json.name })
      warnings.push(
        'La CLI stampa JSON: se l’output è su più righe, indica il percorso del testo nelle opzioni avanzate.'
      )
    }
  }

  /* ------------------------------- models ------------------------------ */

  const modelsFlag = pickFlag(flags, ['--list-models', '--models'])
  if (modelsFlag && !modelsFlag.takesValue) {
    proposal.modelsArgs = [modelsFlag.name]
    findings.push({ field: 'models', label: 'modelli', evidence: modelsFlag.name })
  } else {
    const commands = commandNames(help)
    if (commands.includes('models')) {
      proposal.modelsArgs = ['models']
      findings.push({ field: 'models', label: 'modelli', evidence: 'models' })
    } else if (commands.includes('model')) {
      proposal.modelsArgs = ['model', 'list']
      findings.push({ field: 'models', label: 'modelli', evidence: 'model list' })
    }
  }

  if (findings.length === 0) {
    warnings.push(
      'Non ho riconosciuto flag utili in --help: il profilo resta compilabile a mano.'
    )
  }

  return {
    proposal: {
      ...proposal,
      ...(args.length > 0 ? { args } : {})
    },
    findings,
    warnings
  }
}

async function versionOf(binary: string, home?: string): Promise<string | undefined> {
  for (const flag of ['--version', '-V']) {
    const result = await capture(binary, [flag], 1_500, home)
    if (result.failed) continue
    const line = stripAnsi(`${result.stdout}\n${result.stderr}`)
      .split('\n')
      .map((entry) => entry.trim())
      .find(Boolean)
    if (line && line.length <= 160) return line
  }
  return undefined
}

async function helpText(binary: string, timeout: number, home?: string): Promise<string> {
  for (const args of [['--help'], ['-h'], ['help']]) {
    const result = await capture(binary, args, timeout, home)
    const output = stripAnsi([result.stdout, result.stderr].filter(Boolean).join('\n')).trim()
    if (output.length < 20) continue
    // Some tools answer an unknown flag with a one-line error and exit 1.
    if (/unknown (option|argument|command)|unrecognized|invalid option|not recognized/i.test(output.slice(0, 300))) {
      continue
    }
    return output
  }
  return ''
}

function excerpt(text: string, max = 4_000): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text
}

/**
 * Resolves the command, reads its version and help, and returns a proposal.
 * A missing binary is a normal outcome, not an exception: the panel shows the
 * warning next to the field the user is typing in.
 */
export async function introspectCli(
  command: string,
  options: IntrospectOptions = {}
): Promise<CliIntrospection> {
  const cleaned = command.trim()
  if (!cleaned) throw new Error('Scrivi il comando della CLI da analizzare.')

  const binary = findBinary(cleaned, options.home, options.workspace)
  if (!binary) {
    return {
      command: cleaned,
      helpRead: false,
      proposal: {},
      findings: [],
      warnings: [`Comando "${cleaned}" non trovato nel PATH.`]
    }
  }

  const [version, help] = await Promise.all([
    versionOf(binary, options.home),
    helpText(binary, options.timeoutMs ?? 4_000, options.home)
  ])

  if (!help) {
    return {
      command: cleaned,
      path: binary,
      ...(version ? { version } : {}),
      helpRead: false,
      proposal: {},
      findings: [],
      warnings: [
        'La CLI non ha risposto a --help, -h o help: compila gli argomenti a mano oppure prova il profilo con il pulsante di test.'
      ]
    }
  }

  return {
    command: cleaned,
    path: binary,
    ...(version ? { version } : {}),
    helpRead: true,
    helpExcerpt: excerpt(help),
    ...proposalFromHelp(help, options.args ?? [])
  }
}
