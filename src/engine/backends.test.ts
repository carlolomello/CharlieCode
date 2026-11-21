import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCliBriefing, cliModelEntries, runCliTurn } from './backends'
import { cliModelKey, parseCliModelKey } from '../shared/cli-key'
import type { CliProfile, EngineEvent } from './types'
import type { CliProfileInfo } from '../shared/ipc'

const git = promisify(execFile)

const profile: CliProfile = {
  id: 'agent-one',
  label: 'Agente uno',
  command: process.execPath,
  args: ['-e', 'process.stdout.write("ciao dalla CLI")']
}

function info(overrides: Partial<CliProfileInfo> = {}): CliProfileInfo {
  return { profile, available: true, path: process.execPath, ...overrides }
}

describe('cli-key', () => {
  it('codifica profilo e modello nella stessa chiave', () => {
    expect(cliModelKey('agent-one')).toBe('cli:agent-one')
    expect(cliModelKey('agent-one', 'fast')).toBe('cli:agent-one::fast')
  })

  it('riconosce solo le chiavi CLI', () => {
    expect(parseCliModelKey('cli:agent-one::fast')).toEqual({
      profileId: 'agent-one',
      model: 'fast'
    })
    expect(parseCliModelKey('openai::gpt')).toBeUndefined()
    expect(parseCliModelKey('cli:')).toBeUndefined()
  })
})

describe('cliModelEntries', () => {
  it('mette le CLI disponibili nel selettore, con i livelli di effort', () => {
    const entries = cliModelEntries([
      info(),
      info({
        profile: { ...profile, id: 'agent-two', label: 'Agente due', effortArgs: ['--effort', '{effort}'] }
      }),
      info({ profile: { ...profile, id: 'missing', label: 'Mancante' }, available: false })
    ])

    expect(entries.map((entry) => entry.key).sort()).toEqual([
      'cli:agent-one',
      'cli:agent-two'
    ])
    expect(entries.find((entry) => entry.key === 'cli:agent-one')?.efforts).toEqual(['none'])
    expect(entries.find((entry) => entry.key === 'cli:agent-two')?.efforts).toEqual([
      'none',
      'low',
      'high',
      'max'
    ])
    expect(entries[0]?.providerLabel).toBe('CLI esterne')
  })

  it('offre i livelli di effort quando la CLI li porta nel modello', () => {
    const entries = cliModelEntries([
      info({
        profile: {
          ...profile,
          id: 'variant',
          label: 'Variant',
          modelArgs: ['--model', '{model}#{effort}']
        }
      })
    ])

    expect(entries[0]?.efforts).toEqual(['none', 'low', 'high', 'max'])
  })
})

describe('buildCliBriefing', () => {
  it('include istruzioni, cronologia e richiesta attuale una sola volta', () => {
    const briefing = buildCliBriefing({
      system: 'Usa TypeScript.',
      messages: [
        { role: 'user', content: 'prima domanda' },
        { role: 'assistant', content: 'prima risposta' },
        { role: 'user', content: 'richiesta attuale' }
      ],
      prompt: 'richiesta attuale',
      mode: 'plan'
    })

    expect(briefing).toContain('Usa TypeScript.')
    expect(briefing).toContain('prima domanda')
    expect(briefing).toContain('prima risposta')
    expect(briefing).toContain('Modalità piano')
    expect(briefing.match(/richiesta attuale/g)).toHaveLength(1)
  })

  it('elenca gli allegati con il percorso su disco', () => {
    const briefing = buildCliBriefing({
      messages: [],
      prompt: 'guarda lo screenshot',
      attachments: [{ name: 'screen.png', path: '/tmp/screen.png' }]
    })
    expect(briefing).toContain('Allegati di questo turno')
    expect(briefing).toContain('- screen.png: /tmp/screen.png')
  })

  it('riassume i messaggi che non entrano nel briefing', () => {
    const messages = Array.from({ length: 200 }, (_, index) => ({
      role: 'user' as const,
      content: `messaggio ${index} ${'x'.repeat(500)}`
    }))
    const briefing = buildCliBriefing({ messages, prompt: 'ultima' })
    expect(briefing).toMatch(/messaggi precedenti non entrano nel briefing/)
    expect(briefing).toContain('Riepilogo automatico')
    expect(briefing).toContain('Richiesta attuale:\nultima')
  })
})

describe('runCliTurn', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('esegue la CLI e importa testo e fine turno', async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-backend-'))
    const events: EngineEvent[] = []

    const result = await runCliTurn({
      profile,
      mode: 'build',
      prompt: 'dimmi ciao',
      history: [{ role: 'user', content: 'dimmi ciao' }],
      workspace: dir,
      home: dir,
      emit: (event) => events.push(event)
    })

    expect(result.text).toBe('ciao dalla CLI')
    expect(result.aborted).toBe(false)
    expect(events.some((event) => event.type === 'start')).toBe(true)
    expect(events.some((event) => event.type === 'delta')).toBe(true)
    const done = events.find((event) => event.type === 'done')
    expect(done).toMatchObject({ modelKey: 'cli:agent-one', steps: 1 })
  })

  it('importa come diff i file scritti dalla CLI', async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-backend-'))
    await git('git', ['-C', dir, 'init'])
    await writeFile(join(dir, 'a.txt'), 'vecchio\n')
    await git('git', ['-C', dir, 'add', 'a.txt'])
    await git('git', [
      '-C',
      dir,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-m',
      'init'
    ])

    const events: EngineEvent[] = []
    const result = await runCliTurn({
      profile: {
        ...profile,
        args: [
          '-e',
          'require("fs").writeFileSync("a.txt", "nuovo\\n"); process.stdout.write("fatto")'
        ]
      },
      mode: 'build',
      prompt: 'cambia il file',
      history: [],
      workspace: dir,
      home: dir,
      emit: (event) => events.push(event)
    })

    expect(result.text).toBe('fatto')
    const written = events.find(
      (event) => event.type === 'tool-result' && event.name === 'cli-write'
    )
    expect(written).toMatchObject({
      ok: true,
      diff: { path: 'a.txt', added: 1, removed: 1 }
    })
  })

  it('propaga un errore della CLI senza perdere il turno', async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-backend-'))
    const events: EngineEvent[] = []

    const result = await runCliTurn({
      profile: {
        ...profile,
        args: ['-e', 'process.stderr.write("rotto"); process.exit(3)']
      },
      mode: 'build',
      prompt: 'fai qualcosa',
      history: [],
      workspace: dir,
      home: dir,
      emit: (event) => events.push(event)
    })

    expect(result.error).toMatch(/codice 3/)
    expect(result.aborted).toBe(false)
    expect(events.some((event) => event.type === 'done')).toBe(true)
  })

  it('rifiuta la modalità piano quando il profilo non ha planArgs', async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-backend-'))
    const withoutPlan = { ...profile }
    delete withoutPlan.planArgs
    const events: EngineEvent[] = []

    const result = await runCliTurn({
      profile: withoutPlan,
      mode: 'plan',
      prompt: 'esplora',
      history: [{ role: 'user', content: 'esplora' }],
      workspace: dir,
      home: dir,
      emit: (event) => events.push(event)
    })

    expect(result.error).toMatch(/planArgs/)
    expect(result.text).toBe('')
    expect(events.some((event) => event.type === 'error')).toBe(true)
  })

  it('segnala i file scritti anche in un progetto senza git', async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-backend-'))
    const events: EngineEvent[] = []

    const result = await runCliTurn({
      profile: {
        ...profile,
        args: [
          '-e',
          'require("fs").writeFileSync("nuovo.txt", "contenuto"); process.stdout.write("fatto")'
        ]
      },
      mode: 'build',
      prompt: 'crea il file',
      history: [],
      workspace: dir,
      home: dir,
      emit: (event) => events.push(event)
    })

    expect(result.text).toBe('fatto')
    const written = events.find(
      (event) => event.type === 'tool-result' && event.name === 'cli-write'
    )
    expect(written).toMatchObject({
      ok: true,
      summary: 'file modificato (progetto senza git)'
    })
  })

  it('mostra i tool che la CLI riporta in formato strutturato', async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-backend-'))
    const events: EngineEvent[] = []
    // The shape opencode prints with `--format json`: one event per line.
    const script = `
const lines = [
  { type: 'tool_use', part: { id: 'p1', type: 'tool', tool: 'shell', state: { status: 'completed', input: { command: 'ls -1' }, output: 'a.txt', time: { start: 1, end: 5 } } } },
  { type: 'tool_use', part: { id: 'p2', type: 'tool', tool: 'write', state: { status: 'completed', input: { path: 'nota.txt' }, output: 'ok' } } },
  { type: 'text', part: { type: 'text', text: 'fatto' } }
]
process.stdout.write(lines.map((line) => JSON.stringify(line)).join('\\n'))
`

    const result = await runCliTurn({
      profile: { ...profile, args: ['-e', script] },
      mode: 'build',
      prompt: 'elenca i file',
      history: [],
      workspace: dir,
      home: dir,
      emit: (event) => events.push(event)
    })

    expect(result.text).toBe('fatto')
    const calls = events.filter((event) => event.type === 'tool-call')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ name: 'bash', title: 'ls -1' })
    expect(calls[1]).toMatchObject({ name: 'write', title: 'nota.txt' })
    expect(events.find((event) => event.type === 'tool-result')).toMatchObject({
      ok: true,
      output: 'a.txt'
    })
    expect(result.toolCalls).toBe(2)
  })

  it('apre una card per il worker che la CLI delega e la chiude col turno', async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-backend-'))
    const events: EngineEvent[] = []
    const script = `
const lines = [
  { type: 'tool_use', part: { id: 's1', type: 'tool', tool: 'subagent', state: { status: 'completed', input: { agent: 'general', description: 'Crea nota', prompt: 'crea nota.txt' }, output: 'working in the background' } } },
  { type: 'text', part: { type: 'text', text: 'delegato' } }
]
process.stdout.write(lines.map((line) => JSON.stringify(line)).join('\\n'))
`

    const result = await runCliTurn({
      profile: { ...profile, args: ['-e', script] },
      mode: 'build',
      prompt: 'delega il lavoro',
      history: [],
      workspace: dir,
      home: dir,
      emit: (event) => events.push(event)
    })

    expect(result.text).toBe('delegato')
    expect(events.find((event) => event.type === 'subagent-start')).toMatchObject({
      name: 'Crea nota',
      description: 'crea nota.txt'
    })
    expect(events.find((event) => event.type === 'subagent-end')).toMatchObject({ ok: true })
    // The worker has its own card: it is not also a row in the tool list.
    expect(events.some((event) => event.type === 'tool-call' && event.name === 'task')).toBe(false)
  })
})

/** A CLI that plans two items, works on one per prompt, then integrates. */
const teamScript = `
const fs = require('fs')
const prompt = process.argv[process.argv.length - 1]
if (prompt.includes('Rispondi SOLO con un oggetto JSON')) {
  process.stdout.write(JSON.stringify({ items: [
    { title: 'A', files: ['a.txt'], instructions: 'crea a' },
    { title: 'B', files: ['b.txt'], instructions: 'crea b' }
  ] }))
} else if (prompt.includes('Sei il worker')) {
  const target = prompt.includes('a.txt') ? 'a.txt' : 'b.txt'
  const end = Date.now() + 250
  while (Date.now() < end) {}
  fs.writeFileSync(target, 'x')
  process.stdout.write('fatto ' + target)
} else {
  process.stdout.write('integrazione completata')
}
`

describe('runCliTurn in squadra', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('pianifica, esegue i lavori in parallelo e integra', async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-team-'))
    const events: EngineEvent[] = []

    const result = await runCliTurn({
      profile: { ...profile, args: ['-e', teamScript] },
      mode: 'build',
      team: true,
      prompt: 'crea due file',
      history: [{ role: 'user', content: 'crea due file' }],
      workspace: dir,
      home: dir,
      emit: (event) => events.push(event)
    })

    expect(result.text).toBe('integrazione completata')
    expect(events.some((event) => event.type === 'tool-call' && event.name === 'cli-plan')).toBe(
      true
    )

    const starts = events.filter((event) => event.type === 'subagent-start')
    const ends = events.filter((event) => event.type === 'subagent-end')
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    expect(ends.every((event) => event.type === 'subagent-end' && event.ok)).toBe(true)

    // Both workers started before either finished: they ran at the same time.
    const firstEnd = events.findIndex((event) => event.type === 'subagent-end')
    const lastStart = events.map((event) => event.type).lastIndexOf('subagent-start')
    expect(lastStart).toBeLessThan(firstEnd)

    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('x')
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('x')
  })

  it('con un solo lavoro nel piano fa un turno normale', async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-team-'))
    const events: EngineEvent[] = []
    const single = `
const prompt = process.argv[process.argv.length - 1]
if (prompt.includes('Rispondi SOLO con un oggetto JSON')) {
  process.stdout.write(JSON.stringify({ items: [{ title: 'unico', files: ['a.txt'], instructions: 'crea a' }] }))
} else {
  process.stdout.write('risposta singola')
}
`

    const result = await runCliTurn({
      profile: { ...profile, args: ['-e', single] },
      mode: 'build',
      team: true,
      prompt: 'crea un file',
      history: [{ role: 'user', content: 'crea un file' }],
      workspace: dir,
      home: dir,
      emit: (event) => events.push(event)
    })

    expect(result.text).toBe('risposta singola')
    expect(events.some((event) => event.type === 'subagent-start')).toBe(false)
  })
})
