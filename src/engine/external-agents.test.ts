import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCliArgs,
  extractActivity,
  extractText,
  findBinary,
  formatCommand,
  runExternalAgent
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

  it('rifiuta un file non eseguibile', async () => {
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

  it('un comando mancante rifiuta con un messaggio utile', async () => {
    await expect(
      runExternalAgent(
        profile({ command: 'charliecode-command-that-does-not-exist' }),
        { prompt: 'x', workspace: process.cwd() }
      )
    ).rejects.toThrow(/non trovato/)
  })
})
