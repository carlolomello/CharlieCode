import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  connectCli,
  discoverModelCommand,
  modelNamesFromOutput,
  parseModelHint
} from './cli-connect'
import { readCliProfile, saveCliProfile } from './cli-profiles'
import { createPlatform, type Platform } from './platform'

describe('modelNamesFromOutput', () => {
  it('tiene gli id e scarta intestazioni, prosa ed errori', () => {
    const output = [
      'Available models:',
      '',
      '- anthropic/claude-sonnet-5-5',
      '* openai/gpt-6.1-terra',
      'anthropic/claude-sonnet-5-5',
      'error: no credentials found',
      'This is a long sentence that should not become a model id at all',
      'models'
    ].join('\n')

    expect(modelNamesFromOutput(output)).toEqual([
      'anthropic/claude-sonnet-5-5',
      'openai/gpt-6.1-terra'
    ])
  })

  it('pulisce tabelle e note accanto al nome', () => {
    const output = [
      'gpt-6.1-terra    (default)',
      'sonnet-5.5        Anthropic’s model',
      'acme/one   [free]',
      '  gpt-5-mini\tOpenAI'
    ].join('\n')

    // The note and the description are not part of the id passed to --model.
    expect(modelNamesFromOutput(output)).toEqual([
      'gpt-6.1-terra',
      'sonnet-5.5',
      'acme/one',
      'gpt-5-mini'
    ])
  })

  it('accetta i nomi di modello fatti di qualche parola', () => {
    expect(modelNamesFromOutput('Claude Sonnet 5.5')).toEqual(['Claude Sonnet 5.5'])
  })

  it('scarta help, usage ed errori invece di farne modelli', () => {
    const output = [
      'Unknown option: --list-models',
      'Try --help for usage',
      'Usage: axet-code [options]',
      'Options:',
      '  -m, --model <id>  Model to use',
      'openai/gpt-6.1-terra'
    ].join('\n')

    expect(modelNamesFromOutput(output)).toEqual(['openai/gpt-6.1-terra'])
  })
})

describe('parseModelHint', () => {
  it('legge il JSON anche con prosa e fence attorno', () => {
    expect(parseModelHint('Ecco:\n```json\n{"args":["models"],"format":"lines"}\n```')).toEqual({
      args: ['models'],
      format: 'lines'
    })
  })

  it('accetta un documento JSON con percorso', () => {
    expect(parseModelHint('{"args":["models","--json"],"format":"json","path":"data"}')).toEqual(
      { args: ['models', '--json'], format: 'json', path: 'data' }
    )
  })

  it('tratta args vuoto come “questa CLI non elenca i modelli”', () => {
    expect(parseModelHint('{"args":[]}')).toBeUndefined()
    expect(parseModelHint('nessun json qui')).toBeUndefined()
  })
})

describe('connectCli', () => {
  let dir: string
  let platform: Platform
  let binary: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-connect-'))
    platform = createPlatform({ id: 'darwin', env: { HOME: dir } })
    binary = join(dir, 'agent-one')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeCli(): Promise<void> {
    await writeFile(
      binary,
      `#!/bin/sh
case "$1" in
  --version) echo "agent-one 2.0.0"; exit 0 ;;
  --help)
    cat <<'EOF'
Usage: agent-one [options]

Options:
  --model <id>        Model to use
  --effort <level>    Effort [low|medium|high]
  --print <prompt>    One-shot prompt
EOF
    exit 0 ;;
  models)
    cat <<'EOF'
anthropic/claude-sonnet-5-5
openai/gpt-6.1-terra
EOF
    exit 0 ;;
esac
exit 0
`
    )
    await chmod(binary, 0o755)
  }

  it.runIf(process.platform !== 'win32')(
    'collega una CLI da solo comando: flag, modelli e profilo salvato',
    async () => {
      await writeCli()

      const result = await connectCli(platform, { command: binary, workspace: dir })

      expect(result.path).toBe(binary)
      expect(result.version).toBe('agent-one 2.0.0')
      expect(result.helpRead).toBe(true)
      expect(result.existing).toBe(false)
      expect(result.profile.id).toBe('agent-one')
      expect(result.profile.command).toBe(binary)
      expect(result.profile.modelArgs).toEqual(['--model', '{model}'])
      expect(result.profile.effortValues).toEqual(['low', 'medium', 'high'])
      // The help does not list a models command: the probe found it.
      expect(result.profile.modelsArgs).toEqual(['models'])
      expect(result.models).toEqual([
        'anthropic/claude-sonnet-5-5',
        'openai/gpt-6.1-terra'
      ])
      expect(result.modelsCommand).toContain('models')
      expect(result.findings.some((finding) => finding.field === 'models')).toBe(true)

      const saved = await readCliProfile(platform, 'agent-one')
      expect(saved?.modelsArgs).toEqual(['models'])
    }
  )

  it.runIf(process.platform !== 'win32')(
    'ricollegare non cancella gli argomenti scelti dall’utente',
    async () => {
      await writeCli()
      await saveCliProfile(platform, {
        id: 'agent-one',
        label: 'Agent One',
        command: binary,
        args: ['run', '--custom']
      })

      const result = await connectCli(platform, { command: binary, workspace: dir })

      expect(result.existing).toBe(true)
      expect(result.profile.label).toBe('Agent One')
      expect(result.profile.args).toEqual(['run', '--custom'])
      expect(result.profile.modelsArgs).toEqual(['models'])
      expect(result.models).toHaveLength(2)
    }
  )

  it.runIf(process.platform !== 'win32')(
    'chiede al modello quale comando stampa i modelli quando nessun probe funziona',
    async () => {
      await writeFile(
        binary,
        `#!/bin/sh
case "$1" in
  --version) echo "agent-four 1.0.0"; exit 0 ;;
  --help) echo "Usage: agent-four [options]"; exit 0 ;;
  --print-models) echo "acme/one"; echo "acme/two"; exit 0 ;;
esac
exit 1
`
      )
      await chmod(binary, 0o755)

      const prompts: string[] = []
      const result = await connectCli(platform, {
        command: binary,
        workspace: dir,
        ask: async (prompt) => {
          prompts.push(prompt)
          return '```json\n{"args":["--print-models"],"format":"lines"}\n```'
        }
      })

      // The help text is what the model reads: the CLI is the one place that
      // says how it lists its models.
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain('--help')
      expect(result.models).toEqual(['acme/one', 'acme/two'])
      expect(result.profile.modelsArgs).toEqual(['--print-models'])
      expect(result.profile.modelsFormat).toBe('lines')

      const saved = await readCliProfile(platform, 'agent-one')
      expect(saved?.modelsArgs).toEqual(['--print-models'])
    }
  )

  it.runIf(process.platform !== 'win32')(
    'non salva un comando che non stampa modelli, anche se il modello lo propone',
    async () => {
      await writeFile(binary, '#!/bin/sh\nexit 1\n')
      await chmod(binary, 0o755)

      const result = await connectCli(platform, {
        command: binary,
        ask: async () => '{"args":["models"]}'
      })

      expect(result.models).toEqual([])
      expect(result.profile.modelsArgs).toBeUndefined()
    }
  )

  it('spiega un comando che non esiste', async () => {
    await expect(
      connectCli(platform, { command: 'comando-che-non-esiste-xyz' })
    ).rejects.toThrow(/non trovato/i)
  })
})

describe('discoverModelCommand', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-probe-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it.runIf(process.platform !== 'win32')('prova le grafie finché una risponde', async () => {
    const binary = join(dir, 'agent-two')
    await writeFile(
      binary,
      `#!/bin/sh
case "$1 $2" in
  "model list") echo "model-a"; echo "model-b"; exit 0 ;;
esac
exit 1
`
    )
    await chmod(binary, 0o755)

    const found = await discoverModelCommand(binary, { timeoutMs: 2_000 })
    expect(found?.args).toEqual(['model', 'list'])
    expect(found?.models).toEqual(['model-a', 'model-b'])
  })

  it.runIf(process.platform !== 'win32')('restituisce undefined se nessuna grafia funziona', async () => {
    const binary = join(dir, 'agent-three')
    await writeFile(binary, '#!/bin/sh\nexit 1\n')
    await chmod(binary, 0o755)

    expect(await discoverModelCommand(binary, { timeoutMs: 2_000 })).toBeUndefined()
  })
})
