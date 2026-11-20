import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCliArgs,
  extractActivity,
  extractText,
  findBinary,
  formatCommand,
  profileModels,
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
