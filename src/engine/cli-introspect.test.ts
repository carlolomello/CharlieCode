import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hasPromptMechanism,
  introspectCli,
  parseHelpFlags,
  proposalFromHelp
} from './cli-introspect'

const HELP = `Usage: agent [options]

Options:
  -m, --model <id>          Model to use
      --effort <level>      Reasoning effort [low|medium|high]
      --output-format <f>   Output format: text, json, stream-json
      --read-only           Do not write files
  -y, --yes                 Skip confirmation
      --list-models         List available models
  -p, --print <prompt>      Print one answer and exit
`

describe('parseHelpFlags', () => {
  it('legge nome, forma breve e valore dei flag', () => {
    const flags = parseHelpFlags(HELP)

    const model = flags.find((flag) => flag.name === '--model')
    expect(model).toMatchObject({ short: '-m', takesValue: true })

    expect(flags.find((flag) => flag.name === '--read-only')).toMatchObject({
      takesValue: false
    })
    expect(flags.find((flag) => flag.name === '--yes')).toMatchObject({ short: '-y' })
    expect(flags.find((flag) => flag.name === '--print')).toMatchObject({ takesValue: true })
  })

  it('riconosce i valori elencati nell’aiuto', () => {
    const flags = parseHelpFlags(HELP)
    expect(flags.find((flag) => flag.name === '--effort')?.values).toEqual([
      'low',
      'medium',
      'high'
    ])
    expect(flags.find((flag) => flag.name === '--output-format')?.values).toEqual([
      'text',
      'json',
      'stream-json'
    ])
  })

  it('ignora i flag citati solo nelle descrizioni', () => {
    const flags = parseHelpFlags('Options:\n  --verbose   Also prints --model and --effort\n')
    expect(flags.map((flag) => flag.name)).toEqual(['--verbose'])
  })
})

describe('proposalFromHelp', () => {
  it('propone modello, effort, sola lettura, auto, output e modelli', () => {
    const { proposal, findings } = proposalFromHelp(HELP)

    expect(proposal.modelArgs).toEqual(['--model', '{model}'])
    expect(proposal.effortArgs).toEqual(['--effort', '{effort}'])
    expect(proposal.effortValues).toEqual(['low', 'medium', 'high'])
    expect(proposal.planArgs).toEqual(['--read-only'])
    expect(proposal.autoArgs).toEqual(['--yes'])
    expect(proposal.output).toBe('stream-json')
    // The format is its own argv: `args` keeps only what makes the CLI answer.
    expect(proposal.outputArgs).toEqual(['--output-format', 'stream-json'])
    expect(proposal.args).toEqual(['--print', '{prompt}'])
    expect(proposal.modelsArgs).toEqual(['--list-models'])

    expect(findings.map((finding) => finding.field).sort()).toEqual([
      'auto',
      'effort',
      'model',
      'models',
      'output',
      'plan',
      'prompt'
    ])
  })

  it('mette l’effort nel nome del modello quando la CLI usa #variant', () => {
    const help = [
      'Usage: agent run [flags] [<message...>]',
      'FLAGS',
      '  --model, -m string        Model to use in the format provider/model#variant',
      '  --format choice           Output format (choices: default, json)'
    ].join('\n')

    const { proposal, findings } = proposalFromHelp(help)

    expect(proposal.modelArgs).toEqual(['--model', '{model}#{effort}'])
    expect(proposal.effortArgs).toBeUndefined()
    expect(findings.map((finding) => finding.field)).toContain('effort')
  })

  it('conserva gli argomenti già scritti e non duplica i flag', () => {
    const help = 'Options:\n  --output-format <f>   Output format: json, stream-json\n'
    const { proposal } = proposalFromHelp(help, ['run', '--output-format', 'json'])
    expect(proposal.args).toEqual(['run', '--output-format', 'json'])
  })

  it('riconosce il sottocomando models solo nella sezione comandi', () => {
    const help = `Usage: agent [options]

Commands:
  run <prompt>   Run one turn
  models         List models

Options:
  --verbose      More logs
`
    const { proposal } = proposalFromHelp(help)
    expect(proposal.modelsArgs).toEqual(['models'])
  })

  it('usa il sottocomando run e non il flag che apre l’interfaccia', () => {
    // The shape of a TUI-first CLI: `--prompt` only pre-fills the screen, while
    // `run` answers and exits. Passing the prompt as a bare argument is read as
    // a project folder.
    const help = `Usage: agent [options] [project]

Commands:
  run [message..]   Run one turn without the interface
  models            List models

Options:
  -m, --model <id>   Model to use
      --prompt       Prompt to pre-fill in the interface
`
    const { proposal, findings } = proposalFromHelp(help)

    expect(proposal.args).toEqual(['run'])
    expect(proposal.modelArgs).toEqual(['--model', '{model}'])
    expect(proposal.modelsArgs).toEqual(['models'])
    expect(findings.find((finding) => finding.field === 'prompt')?.evidence).toContain('run')
  })

  it('riconosce i modi in cui il prompt raggiunge la CLI', () => {
    expect(hasPromptMechanism([])).toBe(false)
    expect(hasPromptMechanism(['--json'])).toBe(false)
    expect(hasPromptMechanism(['run'])).toBe(true)
    expect(hasPromptMechanism(['exec', '{prompt}'])).toBe(true)
    expect(hasPromptMechanism(['-p'])).toBe(true)
    expect(hasPromptMechanism(['--print'])).toBe(true)
  })

  it('non inventa un flag per il modello quando non c’è', () => {
    const { proposal, warnings } = proposalFromHelp('Options:\n  --verbose   More logs\n')
    expect(proposal.modelArgs).toBeUndefined()
    expect(warnings.some((warning) => /modello/i.test(warning))).toBe(true)
  })

  it('preferisce la modalità di permesso con valore esplicito', () => {
    const help = `Options:
  --permission-mode <mode>   Permission mode [plan|accept-edits|auto]
  --model <id>               Model
`
    const { proposal } = proposalFromHelp(help)
    expect(proposal.planArgs).toEqual(['--permission-mode', 'plan'])
    expect(proposal.autoArgs).toEqual(['--permission-mode', 'auto'])
  })
})

describe('introspectCli', () => {
  let dir: string
  let oldPath: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'charliecode-introspect-'))
    oldPath = process.env.PATH
    process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`
  })

  afterEach(async () => {
    process.env.PATH = oldPath
    await rm(dir, { recursive: true, force: true })
  })

  it.runIf(process.platform !== 'win32')(
    'legge versione e aiuto di un comando reale',
    async () => {
      const binary = join(dir, 'agent-one')
      await writeFile(
        binary,
        `#!/bin/sh
case "$1" in
  --version) echo "agent-one 1.2.3"; exit 0 ;;
  --help)
    cat <<'EOF'
Usage: agent-one [options]

Options:
  --model <id>        Model to use
  --effort <level>    Effort [low|medium|high]
  --read-only         Do not write
EOF
    exit 0 ;;
esac
exit 0
`
      )
      await chmod(binary, 0o755)

      const result = await introspectCli('agent-one', { home: dir })
      expect(result.path).toBe(binary)
      expect(result.version).toBe('agent-one 1.2.3')
      expect(result.helpRead).toBe(true)
      expect(result.proposal.modelArgs).toEqual(['--model', '{model}'])
      expect(result.proposal.effortValues).toEqual(['low', 'medium', 'high'])
      expect(result.proposal.planArgs).toEqual(['--read-only'])
      expect(result.helpExcerpt).toContain('Usage: agent-one')
    }
  )

  it.runIf(process.platform !== 'win32')(
    'legge l’aiuto anche quando arriva su stderr con codice diverso da zero',
    async () => {
      const binary = join(dir, 'agent-two')
      await writeFile(
        binary,
        `#!/bin/sh
case "$1" in
  --version) exit 2 ;;
  --help)
    echo "Usage: agent-two [options]" >&2
    echo "  --model <id>   Model" >&2
    exit 1 ;;
esac
exit 0
`
      )
      await chmod(binary, 0o755)

      const result = await introspectCli('agent-two', { home: dir })
      expect(result.helpRead).toBe(true)
      expect(result.proposal.modelArgs).toEqual(['--model', '{model}'])
      expect(result.version).toBeUndefined()
    }
  )

  it('riporta un comando mancante senza lanciare eccezioni', async () => {
    const result = await introspectCli('comando-che-non-esiste-xyz', { home: dir })
    expect(result.helpRead).toBe(false)
    expect(result.path).toBeUndefined()
    expect(result.warnings[0]).toMatch(/non trovato/i)
  })
})
