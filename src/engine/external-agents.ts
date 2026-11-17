import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

/**
 * Existing agent CLIs as workers.
 *
 * The point is not to reimplement them: it is to let CharlieCode orchestrate a
 * CLI the user (or their company) already approved, without ever seeing its
 * credentials. Every model call stays inside that CLI, with its own auth, quota
 * and logs; we only spawn it, read its events, and show its diff.
 *
 * Shapes differ, so each CLI is a small spec: how to build argv for one task,
 * and how to pull text out of a line of output. Verified against the real
 * binaries where possible — OpenCode 2.3 `run --format json` emits
 * `step_start` / `text` / `step_finish`, and Cline's `--json` ends with a
 * `run_result` line.
 */

const run = promisify(execFile)

export type AgentCliKind = 'opencode' | 'cline' | 'claude' | 'kiro' | 'generic'

export interface AgentCliSpec {
  id: string
  label: string
  kind: AgentCliKind
  /** Binary names to look for, in order of preference. */
  binaries: string[]
  /** Directories outside PATH worth checking, relative to home. */
  homePaths?: string[]
  docs?: string
  /** Shown in the wizard: what works, what does not. */
  notes: string
  /** One-shot task argv. */
  args(options: AgentRunOptions): string[]
  /** Extracts visible text from one stdout line. */
  text?(line: string): string | undefined
  /** Extracts a tool/activity description from one stdout line. */
  activity?(line: string): string | undefined
  /** Command that prints the models this CLI can use, and how to read it. */
  modelsArgs?: string[]
  modelsFrom?(stdout: string): string[]
  /** The CLI can be told to only read, never write. */
  readOnlyFlag?: (options: AgentRunOptions) => string[]
  /** The CLI can write and run commands without asking. */
  autoFlag?: (options: AgentRunOptions) => string[]
}

export interface AgentRunOptions {
  prompt: string
  model?: string
  /** Let the CLI modify files and run commands. Off unless the user opts in. */
  auto?: boolean
  /** Read-only exploration. */
  plan?: boolean
  workspace: string
}

function parseJson(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

export const AGENT_CLIS: AgentCliSpec[] = [
  {
    id: 'opencode',
    label: 'OpenCode',
    kind: 'opencode',
    binaries: ['opencode', 'opencode2'],
    homePaths: ['.opencode/bin', '.local/bin'],
    docs: 'https://opencode.ai',
    notes:
      'Parla --format json: vediamo testo, step e fine turno. Con --agent usa i suoi agenti; con --auto accetta i permessi da sé.',
    args: (options) => [
      'run',
      '--format',
      'json',
      ...(options.model ? ['-m', options.model] : []),
      ...(options.plan ? ['--agent', 'plan'] : []),
      ...(options.auto ? ['--auto'] : []),
      options.prompt
    ],
    text: (line) => {
      const event = parseJson(line)
      if (!event) return undefined
      const part = asRecord(event.part)
      if (event.type === 'text' && typeof part?.text === 'string') return part.text
      return undefined
    },
    activity: (line) => {
      const event = parseJson(line)
      if (!event) return undefined
      const part = asRecord(event.part)
      if (event.type === 'tool' && typeof part?.tool === 'string') return part.tool
      return undefined
    },
    modelsArgs: ['models'],
    modelsFrom: (stdout) =>
      stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('/') && !line.includes(' '))
  },
  {
    id: 'cline',
    label: 'Cline',
    kind: 'cline',
    binaries: ['cline'],
    docs: 'https://docs.cline.bot/usage/cli-overview',
    notes:
      'Headless con --json: l’ultima riga run_result contiene la risposta. --auto-approve resta spento salvo tuo consenso.',
    args: (options) => [
      '--json',
      ...(options.model ? ['-m', options.model] : []),
      ...(options.plan ? ['-p'] : []),
      ...(options.auto ? ['--auto-approve', 'true'] : ['--auto-approve', 'false']),
      '--cwd',
      options.workspace,
      options.prompt
    ],
    text: (line) => {
      const event = parseJson(line)
      if (!event) return undefined
      if (event.type === 'run_result' && typeof event.text === 'string') return event.text
      return undefined
    },
    modelsFrom: (stdout) =>
      stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.length < 80 && !line.startsWith('{'))
  },
  {
    id: 'claude',
    label: 'Claude Code',
    kind: 'claude',
    binaries: ['claude'],
    docs: 'https://docs.anthropic.com/en/docs/claude-code',
    notes:
      'Modalità -p (non interattiva). --permission-mode plan per la sola lettura; senza, scrive dove può.',
    args: (options) => [
      '-p',
      options.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      ...(options.model ? ['--model', options.model] : []),
      ...(options.plan ? ['--permission-mode', 'plan'] : [])
    ],
    text: (line) => {
      const event = parseJson(line)
      if (!event) return undefined
      if (event.type !== 'assistant') return undefined
      const message = asRecord(event.message)
      const content = Array.isArray(message?.content) ? message.content : []
      return content
        .map((part) => {
          const entry = asRecord(part)
          return entry?.type === 'text' && typeof entry.text === 'string' ? entry.text : ''
        })
        .join('')
    },
    activity: (line) => {
      const event = parseJson(line)
      if (!event || event.type !== 'assistant') return undefined
      const message = asRecord(event.message)
      const content = Array.isArray(message?.content) ? message.content : []
      for (const part of content) {
        const entry = asRecord(part)
        if (entry?.type === 'tool_use' && typeof entry.name === 'string') return entry.name
      }
      return undefined
    }
  },
  {
    id: 'gaia',
    label: 'Gaia Axet (fork Cline)',
    kind: 'generic',
    binaries: ['gaia', 'gaia-axet', 'axet'],
    notes:
      'Presumo la stessa interfaccia di Cline (--json, run_result). Se la tua build differisce, il wizard lo dice quando la prova fallisce.',
    args: (options) => [
      '--json',
      ...(options.model ? ['-m', options.model] : []),
      ...(options.plan ? ['-p'] : []),
      ...(options.auto ? ['--auto-approve', 'true'] : ['--auto-approve', 'false']),
      '--cwd',
      options.workspace,
      options.prompt
    ],
    text: (line) => {
      const event = parseJson(line)
      if (!event) return undefined
      if (event.type === 'run_result' && typeof event.text === 'string') return event.text
      return undefined
    }
  },
  {
    id: 'kiro',
    label: 'Kiro CLI',
    kind: 'kiro',
    binaries: ['kiro-cli'],
    homePaths: ['.local/bin'],
    notes:
      'Sperimentale: non ha un formato JSON stabile, quindi il testo è quello che stampa. Usalo come worker, non come orchestratore.',
    args: (options) => ['chat', '--no-interactive', options.prompt]
  }
]

/** Searches PATH plus the usual per-user install directories. */
export function findBinary(names: string[], home = homedir()): string | undefined {
  const directories = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .concat([
      join(home, '.opencode', 'bin'),
      join(home, '.local', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, 'Library', 'pnpm'),
      '/opt/homebrew/bin',
      '/usr/local/bin'
    ])

  for (const name of names) {
    if (isAbsolute(name)) {
      if (isExecutable(name)) return name
      continue
    }
    for (const directory of directories) {
      const candidate = join(directory, name)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface DetectedAgent {
  id: string
  label: string
  path: string
  /** `--version` output, first line. */
  version?: string
  notes: string
  docs?: string
  /** Whether the wizard can offer models for it. */
  canListModels: boolean
}

/** Probes the machine for agent CLIs. Never installs anything. */
export async function detectAgentClis(home = homedir()): Promise<DetectedAgent[]> {
  const found: DetectedAgent[] = []

  for (const spec of AGENT_CLIS) {
    const path = findBinary(spec.binaries, home)
    if (!path) continue
    let version: string | undefined
    try {
      const { stdout } = await run(path, ['--version'], { timeout: 8000, windowsHide: true })
      version = stdout.split('\n')[0]?.trim() || undefined
    } catch {
      // A CLI that cannot answer --version is still usable; we just say so.
    }
    found.push({
      id: spec.id,
      label: spec.label,
      path,
      ...(version ? { version } : {}),
      notes: spec.notes,
      ...(spec.docs ? { docs: spec.docs } : {}),
      canListModels: Boolean(spec.modelsArgs)
    })
  }

  return found
}

export function agentSpec(id: string): AgentCliSpec | undefined {
  return AGENT_CLIS.find((spec) => spec.id === id)
}

/** Models the CLI already has access to. No key ever reaches this process. */
export async function agentModels(id: string, home = homedir()): Promise<string[]> {
  const spec = agentSpec(id)
  if (!spec?.modelsArgs || !spec.modelsFrom) return []
  const binary = findBinary(spec.binaries, home)
  if (!binary) return []
  try {
    const { stdout } = await run(binary, spec.modelsArgs, {
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    })
    return spec.modelsFrom(stdout).slice(0, 400)
  } catch {
    return []
  }
}

export interface ExternalRunResult {
  text: string
  code: number
  stderr: string
  ms: number
  /** The process had to be killed for exceeding the timeout. */
  timedOut: boolean
}

const MAX_OUTPUT = 2 * 1024 * 1024

/**
 * Runs one task through an external CLI.
 *
 * `spawn` with an argument array and no shell: the prompt is data. Output is
 * read line by line so the UI can show progress, and capped so a runaway CLI
 * cannot fill memory.
 */
export function runExternalAgent(
  id: string,
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
  const spec = agentSpec(id)
  if (!spec) return Promise.reject(new Error(`CLI sconosciuta: ${id}`))
  const binary = findBinary(spec.binaries, hooks.home ?? homedir())
  if (!binary) {
    return Promise.reject(
      new Error(`${spec.label} non è nel PATH. Installala o indica il percorso nelle impostazioni.`)
    )
  }

  const argv = spec.args(options)
  const started = Date.now()
  const timeoutMs = hooks.timeoutMs ?? 10 * 60_000

  return new Promise<ExternalRunResult>((resolve, reject) => {
    const child = spawn(binary, argv, {
      cwd: options.workspace,
      shell: false,
      windowsHide: true,
      env: { ...process.env, CI: '1', NO_COLOR: '1' }
    })

    let text = ''
    let stderr = ''
    let buffer = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // Some CLIs ignore SIGTERM while a tool is running.
      setTimeout(() => child.kill('SIGKILL'), 5000)
    }, timeoutMs)

    const stop = (): void => {
      clearTimeout(timer)
      child.kill('SIGTERM')
    }
    hooks.signal?.addEventListener('abort', stop, { once: true })

    const consume = (line: string): void => {
      if (!line.trim()) return
      const activity = spec.activity?.(line)
      if (activity) hooks.onActivity?.(activity)

      if (spec.text) {
        const piece = spec.text(line)
        if (piece) {
          text += piece
          hooks.onText?.(piece)
        }
        return
      }

      // No structured format: everything the CLI prints is the answer.
      text += `${line}\n`
      hooks.onText?.(`${line}\n`)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_OUTPUT) buffer = buffer.slice(-MAX_OUTPUT)
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        consume(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_OUTPUT)
      for (const line of chunk.split('\n')) {
        if (line.trim()) hooks.onStderr?.(line)
      }
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      hooks.signal?.removeEventListener('abort', stop)
      reject(error)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      hooks.signal?.removeEventListener('abort', stop)
      if (buffer.trim()) consume(buffer)
      const result: ExternalRunResult = {
        text: text.trim(),
        code: code ?? 0,
        stderr: stderr.trim(),
        ms: Date.now() - started,
        timedOut
      }
      if (code !== 0 && !result.text) {
        reject(
          new Error(
            timedOut
              ? `${spec.label} non ha risposto entro ${Math.round(timeoutMs / 1000)}s`
              : `${spec.label} è uscita con codice ${code}${stderr ? `: ${stderr.split('\n')[0]}` : ''}`
          )
        )
        return
      }
      resolve(result)
    })
  })
}

/** True when the binary exists: the wizard uses it to enable a row. */
export function agentAvailable(id: string, home = homedir()): boolean {
  const spec = agentSpec(id)
  return Boolean(spec && findBinary(spec.binaries, home))
}

/** Absolute path, for display. */
export function agentPath(id: string, home = homedir()): string | undefined {
  const spec = agentSpec(id)
  return spec ? findBinary(spec.binaries, home) : undefined
}

export function isKnownAgent(id: string): boolean {
  return AGENT_CLIS.some((spec) => spec.id === id)
}

/** Used by the wizard to explain a folder that has a CLI but no PATH entry. */
export function looksInstalled(spec: AgentCliSpec, home = homedir()): boolean {
  return (spec.homePaths ?? []).some((relative) => existsSync(join(home, relative)))
}
