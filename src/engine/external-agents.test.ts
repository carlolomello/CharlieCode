import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCliArgs,
  extractActivity,
  extractText,
  extractThinking,
  extractToolEvent,
  findBinary,
  formatCommand,
  profileEfforts,
  profileModels,
  rejectedFlags,
  resolveBinaryViaShell,
  runExternalAgent,
  searchBinaries
} from './external-agents'
import type { CliProfile } from './types'

function profile(overrides: Partial<CliProfile> = {}): CliProfile {
  return {
    id: 'test',
    label: 'CLI di prova',
    command: process.execPath,
    args: [],
    ...overrides
  }
}

/** Node is the one executable every test machine has. */
function node(script: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['-e', script] }
}

describe('buildCliArgs', () => {
  it('aggiunge il prompt come ultimo argomento', () => {
    const argv = buildCliArgs(profile({ args: ['run', '--format', 'json'] }), {
      prompt: 'ciao',
      workspace: '/tmp'
    })
    expect(argv).toEqual(['run', '--format', 'json', 'ciao'])
  })

  it('sostituisce i segnaposto', () => {
    const argv = buildCliArgs(
      profile({ args: ['--dir', '{workspace}', '--model', '{model}', '-p', '{prompt}'] }),
      { prompt: 'ciao', workspace: '/proj', model: 'm1' }
    )
    expect(argv).toEqual(['--dir', '/proj', '--model', 'm1', '-p', 'ciao'])
  })

  it('toglie gli argomenti che richiedono un modello quando non c’è', () => {
    const argv = buildCliArgs(
      profile({ args: ['run', '--model', '{model}', '{prompt}'] }),
      { prompt: 'ciao', workspace: '/proj' }
    )
    expect(argv).toEqual(['run', 'ciao'])
  })

  it('passa il modello con --model quando il profilo non dichiara il flag', () => {
    const argv = buildCliArgs(profile({ args: ['run'] }), {
      prompt: 'ciao',
      workspace: '/proj',
      model: 'sonnet-5.5'
    })
    expect(argv).toEqual(['run', '--model', 'sonnet-5.5', 'ciao'])
  })

  it('non aggiunge --model quando il modello è già un segnaposto', () => {
    const argv = buildCliArgs(profile({ args: ['--model', '{model}'] }), {
      prompt: 'ciao',
      workspace: '/proj',
      model: 'm1'
    })
    expect(argv).toEqual(['--model', 'm1', 'ciao'])
  })

  it('aggiunge modello, sola lettura e scrittura automatica', () => {
    const argv = buildCliArgs(
      profile({
        args: ['run'],
        modelArgs: ['-m', '{model}'],
        planArgs: ['--plan'],
        autoArgs: ['--yes']
      }),
      { prompt: 'ciao', workspace: '/proj', model: 'm1', plan: true, auto: true }
    )
    expect(argv).toEqual(['run', '-m', 'm1', '--plan', '--yes', 'ciao'])
  })

  it('traduce i livelli di effort nei valori dichiarati dalla CLI', () => {
    const base = profile({
      args: ['run'],
      effortArgs: ['--effort', '{effort}'],
      effortValues: ['low', 'medium', 'high']
    })
    const run = (effort?: 'none' | 'low' | 'high' | 'max'): string[] =>
      buildCliArgs(base, { prompt: 'x', workspace: '/p', ...(effort ? { effort } : {}) })

    expect(run('low')).toEqual(['run', '--effort', 'low', 'x'])
    expect(run('high')).toEqual(['run', '--effort', 'high', 'x'])
    expect(run('max')).toEqual(['run', '--effort', 'high', 'x'])
    expect(run('none')).toEqual(['run', 'x'])
    expect(run()).toEqual(['run', 'x'])
  })

  it('mette l’effort nel nome del modello e lo toglie quando è «nessuno»', () => {
    const base = profile({
      args: ['run'],
      modelArgs: ['--model', '{model}#{effort}'],
      effortValues: ['low', 'medium', 'high']
    })
    const run = (effort?: 'none' | 'low' | 'high' | 'max'): string[] =>
      buildCliArgs(base, {
        prompt: 'x',
        workspace: '/p',
        model: 'acme/uno',
        ...(effort ? { effort } : {})
      })

    expect(run('high')).toEqual(['run', '--model', 'acme/uno#high', 'x'])
    // No variant means the model alone: a leftover `#` would be a broken name.
    expect(run('none')).toEqual(['run', '--model', 'acme/uno', 'x'])
    expect(run()).toEqual(['run', '--model', 'acme/uno', 'x'])
  })

  it('accende i livelli di effort anche quando stanno nel modello', () => {
    expect(profileEfforts(profile({ effortArgs: ['--effort', '{effort}'] }))).toEqual([
      'none',
      'low',
      'high',
      'max'
    ])
    expect(profileEfforts(profile({ modelArgs: ['--model', '{model}#{effort}'] }))).toEqual([
      'none',
      'low',
      'high',
      'max'
    ])
    expect(profileEfforts(profile())).toEqual(['none'])
  })

  it('sposta un flag rifiutato prima del sottocomando, oppure lo toglie', () => {
    const base = profile({ args: ['run'], autoArgs: ['--yolo'] })
    const options = { prompt: 'x', workspace: '/p', auto: true }

    expect(buildCliArgs(base, options)).toEqual(['run', '--yolo', 'x'])
    expect(buildCliArgs(base, options, { placements: { auto: 'before' } })).toEqual([
      '--yolo',
      'run',
      'x'
    ])
    expect(buildCliArgs(base, options, { placements: { auto: 'off' } })).toEqual(['run', 'x'])
  })

  it('toglie dagli argomenti del profilo il flag rifiutato e il suo valore', () => {
    const base = profile({ args: ['run', '--yolo', '--print-models', 'json'] })
    const argv = buildCliArgs(
      base,
      { prompt: 'x', workspace: '/p' },
      { refusedArgs: ['--yolo', '--print-models'] }
    )
    expect(argv).toEqual(['run', 'x'])
  })

  it('con prompt su stdin non lo aggiunge agli argomenti', () => {
    const argv = buildCliArgs(profile({ args: ['run'], promptMode: 'stdin' }), {
      prompt: 'ciao',
      workspace: '/proj'
    })
    expect(argv).toEqual(['run'])
  })
})

describe('extractText', () => {
  it('legge le forme più comuni senza conoscere il prodotto', () => {
    expect(extractText({ type: 'text', text: 'ciao' })).toBe('ciao')
    expect(extractText({ type: 'text', part: { text: 'ciao' } })).toBe('ciao')
    expect(extractText({ type: 'run_result', text: 'fatto' })).toBe('fatto')
    expect(extractText({ type: 'result', result: 'fatto' })).toBe('fatto')
    expect(extractText({ choices: [{ delta: { content: 'ciao' } }] })).toBe('ciao')
    expect(
      extractText({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'un ' }, { type: 'text', text: 'due' }] }
      })
    ).toBe('un due')
  })

  it('rispetta un percorso esplicito', () => {
    expect(extractText({ data: { answer: 'ok' } }, 'data.answer')).toBe('ok')
  })

  it('ignora eventi senza testo', () => {
    expect(extractText({ type: 'step_start' })).toBeUndefined()
  })
})

describe('extractActivity', () => {
  it('legge i tool dalle forme comuni', () => {
    expect(extractActivity({ type: 'tool', part: { tool: 'read' } })).toBe('read')
    expect(
      extractActivity({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'bash' }] }
      })
    ).toBe('bash')
    expect(extractActivity({ type: 'tool_call', name: 'grep' })).toBe('grep')
  })
})

describe('formatCommand', () => {
  it('cita solo ciò che ne ha bisogno', () => {
    expect(formatCommand('agent', ['run', 'ciao mondo'])).toBe('agent run "ciao mondo"')
  })
})

describe('findBinary', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-bin-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('accetta un percorso assoluto eseguibile', async () => {
    const script = join(dir, 'tool')
    await writeFile(script, '#!/bin/sh\necho ok\n')
    await chmod(script, 0o755)
    expect(findBinary(script)).toBe(script)
  })

  // Windows has no executable bit: there is nothing to reject here, and the
  // test would only assert a POSIX permission model.
  it.runIf(process.platform !== 'win32')('rifiuta un file non eseguibile', async () => {
    const script = join(dir, 'plain')
    await writeFile(script, 'niente')
    await chmod(script, 0o644)
    expect(findBinary(script)).toBeUndefined()
  })

  it.runIf(process.platform !== 'win32')('risolve un percorso relativo al progetto', async () => {
    const scripts = join(dir, 'scripts')
    await mkdir(scripts)
    const script = join(scripts, 'agent')
    await writeFile(script, '#!/bin/sh\necho ok\n')
    await chmod(script, 0o755)
    expect(findBinary('scripts/agent', dir, dir)).toBe(script)
  })

  // Installers often put the binary in `<home>/<tool>/bin` and only add that
  // directory to the user's shell profile; the app started from Finder does not
  // see it. The fallback is generic, so any such tool is found by name.
  it.runIf(process.platform !== 'win32')('trova un comando in <home>/<tool>/bin', async () => {
    const bin = join(dir, '.tool', 'bin')
    await mkdir(bin, { recursive: true })
    const script = join(bin, 'nested-agent-xyz')
    await writeFile(script, '#!/bin/sh\necho ok\n')
    await chmod(script, 0o755)

    expect(findBinary('nested-agent-xyz', dir)).toBe(script)
  })
})

describe('resolveBinaryViaShell', () => {
  it.runIf(process.platform !== 'win32')(
    'risolve un comando tramite la shell dell’utente',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'charliecode-shell-'))
      const oldPath = process.env.PATH
      try {
        const script = join(dir, 'shell-agent-xyz')
        await writeFile(script, '#!/bin/sh\necho ok\n')
        await chmod(script, 0o755)
        process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`

        expect(
          await resolveBinaryViaShell('shell-agent-xyz', { home: dir, timeoutMs: 5_000 })
        ).toBe(script)
      } finally {
        process.env.PATH = oldPath
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it('rifiuta un comando con metacaratteri', async () => {
    expect(await resolveBinaryViaShell('agent; rm -rf /')).toBeUndefined()
    expect(await resolveBinaryViaShell('agent $(whoami)')).toBeUndefined()
  })
})

describe('profileModels', () => {
  // The picker's second selector only has something to show if this works for a
  // command that is not on the app's PATH.
  it.runIf(process.platform !== 'win32')(
    'legge i modelli di un comando che conosce solo la shell',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'charliecode-models-'))
      const oldShell = process.env.SHELL
      try {
        const bin = join(root, 'bin')
        await mkdir(bin, { recursive: true })
        const script = join(bin, 'shell-models-xyz')
        await writeFile(
          script,
          '#!/bin/sh\nif [ "$1" = "models" ]; then printf "sonnet-5.5\\ngpt-6.1-terra\\n"; fi\n'
        )
        await chmod(script, 0o755)

        const wrapper = join(root, 'shell')
        await writeFile(
          wrapper,
          `#!/bin/sh\nPATH="${bin}:$PATH"\nexport PATH\nexec /bin/sh "$@"\n`
        )
        await chmod(wrapper, 0o755)
        process.env.SHELL = wrapper

        const home = join(root, 'home')
        await mkdir(home, { recursive: true })

        expect(
          await profileModels(
            {
              id: 'x',
              label: 'X',
              command: 'shell-models-xyz',
              args: [],
              modelsArgs: ['models']
            },
            home
          )
        ).toEqual(['sonnet-5.5', 'gpt-6.1-terra'])
      } finally {
        if (oldShell === undefined) delete process.env.SHELL
        else process.env.SHELL = oldShell
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

describe('searchBinaries', () => {
  let dir: string
  let oldPath: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-search-'))
    oldPath = process.env.PATH
    process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`
  })

  afterEach(async () => {
    process.env.PATH = oldPath
    await rm(dir, { recursive: true, force: true })
  })

  it.runIf(process.platform !== 'win32')('trova un comando esatto e ne legge la versione', async () => {
    const binary = join(dir, 'agent-one')
    await writeFile(binary, '#!/bin/sh\necho 1.2.3\n')
    await chmod(binary, 0o755)

    const matches = await searchBinaries('agent-one', dir)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.path).toBe(binary)
    expect(matches[0]?.version).toBe('1.2.3')
  })

  it.runIf(process.platform !== 'win32')('trova per prefisso mentre si scrive', async () => {
    const binary = join(dir, 'agent-one')
    await writeFile(binary, '#!/bin/sh\nexit 0\n')
    await chmod(binary, 0o755)

    const matches = await searchBinaries('agent', dir)
    expect(matches.map((match) => match.name)).toContain('agent-one')
  })

  it('non scansiona con una sola lettera', async () => {
    expect(await searchBinaries('a', dir)).toEqual([])
  })

  it('restituisce una lista vuota quando non c’è nulla', async () => {
    expect(await searchBinaries('comando-che-non-esiste-123', dir)).toEqual([])
  })
})

describe('runExternalAgent', () => {
  it('legge il testo e restituisce codice zero', async () => {
    const result = await runExternalAgent(
      profile({ ...node('process.stdout.write("ciao\\n")'), output: 'text' }),
      { prompt: 'ignorato', workspace: process.cwd() }
    )
    expect(result.text).toBe('ciao')
    expect(result.code).toBe(0)
    expect(result.error).toBeUndefined()
  })

  it('legge una riga JSON per evento', async () => {
    const result = await runExternalAgent(
      profile({
        ...node('process.stdout.write(JSON.stringify({ type: "text", text: "ok" }) + "\\n")'),
        output: 'json-lines'
      }),
      { prompt: 'ignorato', workspace: process.cwd() }
    )
    expect(result.text).toBe('ok')
  })

  it('un exit non zero è un fallimento, anche con output', async () => {
    const result = await runExternalAgent(
      profile({
        ...node('process.stdout.write("parziale\\n"); process.exit(3)'),
        output: 'text'
      }),
      { prompt: 'ignorato', workspace: process.cwd() }
    )
    expect(result.code).toBe(3)
    expect(result.error).toMatch(/codice 3/)
  })

  it('il timeout uccide il processo e lo segnala', async () => {
    const result = await runExternalAgent(
      profile({
        ...node('setTimeout(() => {}, 5000)'),
        output: 'text'
      }),
      { prompt: 'ignorato', workspace: process.cwd() },
      { timeoutMs: 150 }
    )
    expect(result.timedOut).toBe(true)
    expect(result.error).toMatch(/non ha risposto/)
  })

  it('l’abort interrompe il turno', async () => {
    const controller = new AbortController()
    const pending = runExternalAgent(
      profile({
        ...node('setTimeout(() => {}, 5000)'),
        output: 'text'
      }),
      { prompt: 'ignorato', workspace: process.cwd() },
      { signal: controller.signal, timeoutMs: 10_000 }
    )
    setTimeout(() => controller.abort(), 100)
    const result = await pending
    expect(result.aborted).toBe(true)
    expect(result.error).toMatch(/interrotta/)
  })

  it('ripete senza modello quando la CLI lo rifiuta subito', async () => {
    // `--` hands the flags to the script instead of node itself.
    const cli = node(
      'if (process.argv.includes("--model")) process.exit(1); process.stdout.write("ok\\n")'
    )
    const result = await runExternalAgent(
      profile({ ...cli, args: [...cli.args, '--'], output: 'text' }),
      { prompt: 'ignorato', model: 'acme/uno', workspace: process.cwd() }
    )

    // The turn is usable on the CLI default, and the note says why.
    expect(result.text).toBe('ok')
    expect(result.code).toBe(0)
    expect(result.error).toBeUndefined()
    expect(result.warning).toMatch(/acme\/uno/)
  })

  it('riconosce il ragionamento in più forme', () => {
    expect(extractThinking({ type: 'thinking', text: 'a' })).toBe('a')
    expect(extractThinking({ type: 'reasoning_delta', delta: 'b' })).toBe('b')
    expect(extractThinking({ type: 'message', message: { reasoning: 'c' } })).toBe('c')
    expect(
      extractThinking({ message: { content: [{ type: 'reasoning', text: 'd' }] } })
    ).toBe('d')
    expect(extractThinking({ choices: [{ delta: { reasoning_content: 'e' } }] })).toBe('e')
    expect(extractThinking({ type: 'text', text: 'risposta' })).toBeUndefined()
  })

  it('manda il ragionamento a parte, mai dentro la risposta', async () => {
    const cli = node(
      'process.stdout.write(JSON.stringify({ type: "thinking", text: "sto leggendo il progetto" }) + "\\n"); process.stdout.write(JSON.stringify({ type: "text", text: "risposta" }) + "\\n")'
    )
    const seen: string[] = []
    const result = await runExternalAgent(
      profile({ ...cli, output: 'json-lines' }),
      { prompt: 'ignorato', workspace: process.cwd() },
      { onThinking: (text) => seen.push(text) }
    )

    expect(seen).toEqual(['sto leggendo il progetto'])
    expect(result.text).toBe('risposta')
  })

  it('riconosce il flag che la CLI dichiara sconosciuto', () => {
    expect(rejectedFlags('ERROR | Unknown flag: --yolo. | Try --help for usage.')).toEqual([
      '--yolo'
    ])
    expect(rejectedFlags("error: unexpected argument '--full-auto' found")).toEqual(['--full-auto'])
    expect(rejectedFlags('--effort is not a valid option')).toEqual(['--effort'])
    expect(rejectedFlags('ERROR: nessun flag qui')).toEqual([])
  })

  it('ripete il turno senza un flag che sta negli argomenti del profilo', async () => {
    const cli = node(
      'if (process.argv.includes("--yolo")) { console.error("ERROR | Unknown flag: --yolo. | Try --help for usage."); process.exit(1) } process.stdout.write("ok\\n")'
    )
    const result = await runExternalAgent(
      profile({
        ...cli,
        args: [...cli.args, '--', 'run', '--yolo'],
        output: 'text'
      }),
      { prompt: 'ignorato', workspace: process.cwd() }
    )

    expect(result.text).toBe('ok')
    expect(result.code).toBe(0)
    expect(result.warning).toMatch(/--yolo/)
  })

  it('ripete il turno senza il flag che la CLI rifiuta', async () => {
    // A CLI that documents `--yolo` but refuses it where the prompt runs: the
    // turn must not die on a flag the user never typed.
    const cli = node(
      'if (process.argv.includes("--yolo")) { console.error("ERROR | Unknown flag: --yolo. | Try --help for usage."); process.exit(1) } process.stdout.write("ok\\n")'
    )
    const result = await runExternalAgent(
      profile({
        ...cli,
        args: [...cli.args, '--'],
        autoArgs: ['--yolo'],
        output: 'text'
      }),
      { prompt: 'ignorato', auto: true, workspace: process.cwd() }
    )

    expect(result.text).toBe('ok')
    expect(result.code).toBe(0)
    expect(result.error).toBeUndefined()
    expect(result.warning).toMatch(/--yolo/)
  })

  it('ripete il turno senza variant quando la CLI rifiuta l’effort', async () => {
    // opencode answers `Variant unavailable for provider/model: high` before any
    // request: the model the user picked must survive, only the variant goes.
    const cli = node(
      'const args = process.argv.slice(1); if (args.some((arg) => arg.includes("#"))) { process.stderr.write("Variant unavailable for acme/uno: high\\n"); process.exit(1) } process.stdout.write("risposta\\n")'
    )
    const result = await runExternalAgent(
      profile({
        ...cli,
        args: [...cli.args, '--', 'run'],
        modelArgs: ['--model', '{model}#{effort}'],
        output: 'text'
      }),
      { prompt: 'ignorato', model: 'acme/uno', effort: 'high', workspace: process.cwd() }
    )

    expect(result.text).toBe('risposta')
    expect(result.warning).toMatch(/effort "high"/)
    expect(result.command).toContain('--model acme/uno')
    expect(result.command).not.toContain('acme/uno#')
  })

  it('ricorda il flag rifiutato anche dopo un riavvio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'charliecode-learned-'))
    const cli = node(
      'if (process.argv.includes("--yolo")) { console.error("ERROR | Unknown flag: --yolo. | Try --help for usage."); process.exit(1) } process.stdout.write("ok\\n")'
    )
    const learned = profile({
      ...cli,
      args: [...cli.args, '--', 'run', '--yolo'],
      output: 'text'
    })

    try {
      vi.resetModules()
      const first: typeof import('./external-agents') = await import('./external-agents')
      const one = await first.runExternalAgent(
        learned,
        { prompt: 'ignorato', workspace: process.cwd() },
        { stateDir: dir }
      )
      expect(one.text).toBe('ok')
      expect(one.warning).toMatch(/--yolo/)

      const saved = JSON.parse(await readFile(join(dir, 'cli-learned.json'), 'utf8'))
      expect(saved[learned.id].refusedArgs).toEqual(['--yolo'])

      // A fresh module is what the next launch of the app looks like: the file
      // is the only memory left, and it has to be enough to skip the failure.
      vi.resetModules()
      const second: typeof import('./external-agents') = await import('./external-agents')
      const two = await second.runExternalAgent(
        learned,
        { prompt: 'ignorato', workspace: process.cwd() },
        { stateDir: dir }
      )
      expect(two.text).toBe('ok')
      expect(two.code).toBe(0)
      expect(two.warning).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('non ripete un turno che ha già prodotto testo', async () => {
    const cli = node('process.stdout.write("parziale\\n"); process.exit(2)')
    const result = await runExternalAgent(
      profile({ ...cli, args: [...cli.args, '--'], output: 'text' }),
      { prompt: 'ignorato', model: 'acme/uno', workspace: process.cwd() }
    )

    expect(result.code).toBe(2)
    expect(result.error).toMatch(/codice 2/)
    expect(result.warning).toBeUndefined()
  })

  it('un comando mancante rifiuta con un messaggio utile', async () => {
    await expect(
      runExternalAgent(
        profile({ command: 'charliecode-command-that-does-not-exist' }),
        { prompt: 'x', workspace: process.cwd() }
      )
    ).rejects.toThrow(/non trovato/)
  })
})

describe('profileModels', () => {
  it.runIf(process.platform !== 'win32')(
    'legge la lista anche quando arriva su stderr con codice 1',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'charliecode-models-'))
      try {
        const binary = join(dir, 'agent-models')
        await writeFile(
          binary,
          `#!/bin/sh\necho
echo "acme/uno" >&2
echo "acme/due" >&2
exit 1\n`
        )
        await chmod(binary, 0o755)

        const models = await profileModels(
          profile({ command: binary, modelsArgs: ['models'] }),
          dir,
          dir
        )
        expect(models).toEqual(['acme/uno', 'acme/due'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
})

describe('extractToolEvent', () => {
  it('legge il tool di un evento a parti, con comando, stato e output', () => {
    const event = {
      type: 'tool_use',
      part: {
        id: 'prt_1',
        type: 'tool',
        tool: 'shell',
        state: {
          status: 'completed',
          input: { command: 'ls -1 .' },
          output: 'a.txt\nb.txt\n',
          title: 'shell',
          time: { start: 1000, end: 1042 }
        }
      }
    }

    expect(extractToolEvent(event)).toEqual({
      id: 'prt_1',
      name: 'bash',
      title: 'ls -1 .',
      status: 'ok',
      input: { command: 'ls -1 .' },
      output: 'a.txt\nb.txt\n',
      ms: 42
    })
  })

  it('usa il percorso come titolo per una lettura o una scrittura', () => {
    expect(
      extractToolEvent({
        type: 'tool_use',
        part: {
          id: 'p2',
          tool: 'read',
          state: { status: 'running', input: { path: 'src/app.ts' } }
        }
      })
    ).toMatchObject({ name: 'read', title: 'src/app.ts', status: 'running' })
  })

  it('riconosce un worker delegato dalla forma del suo input', () => {
    const event = {
      type: 'tool_use',
      part: {
        id: 'p3',
        tool: 'subagent',
        state: {
          status: 'completed',
          input: {
            agent: 'general',
            description: 'Crea nota.txt',
            prompt: 'crea il file nota.txt'
          },
          output: 'working in the background'
        }
      }
    }

    expect(extractToolEvent(event)?.subagent).toEqual({
      name: 'Crea nota.txt',
      description: 'crea il file nota.txt'
    })
  })

  it('legge i tool e i risultati dei messaggi in stile stream-json', () => {
    expect(
      extractToolEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } }]
        }
      })
    ).toMatchObject({ id: 't1', name: 'bash', title: 'pwd', status: 'running' })

    expect(
      extractToolEvent({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '/tmp' }] }
          ]
        }
      })
    ).toEqual({ id: 't1', name: '', title: '', status: 'ok', output: '/tmp' })
  })

  it('non scambia il testo per un tool', () => {
    expect(extractToolEvent({ type: 'text', part: { type: 'text', text: 'ciao' } })).toBeUndefined()
    expect(
      extractToolEvent({ type: 'step_start', part: { type: 'step-start' } })
    ).toBeUndefined()
  })
})
