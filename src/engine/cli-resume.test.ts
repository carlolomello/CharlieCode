import { describe, expect, it } from 'vitest'
import { buildCliArgs, failedFast, type ExternalRunResult } from './external-agents'
import { buildCliResumePrompt } from './backends'
import { proposalFromHelp } from './cli-introspect'
import { validateCliProfile } from './cli-profiles'
import type { CliProfile } from './types'

const base: CliProfile = {
  id: 'axet',
  label: 'Axet',
  command: 'axet-code',
  args: ['run', '{prompt}'],
  continueArgs: ['--continue']
}

function result(overrides: Partial<ExternalRunResult> = {}): ExternalRunResult {
  return {
    text: '',
    raw: '',
    code: 0,
    stderr: '',
    ms: 10,
    timedOut: false,
    aborted: false,
    ...overrides
  }
}

describe('continuing a CLI session', () => {
  it('adds the continue flag only when the turn asks for it', () => {
    const options = { prompt: 'ciao', workspace: '/project' }

    expect(buildCliArgs(base, options)).toEqual(['run', 'ciao'])
    // `{prompt}` is part of the profile's own argv, so the extra group follows
    // it. A CLI that only accepts the flag before the prompt moves it on the
    // first refused turn (the learned placement handles it).
    expect(buildCliArgs(base, { ...options, continueSession: true })).toEqual([
      'run',
      'ciao',
      '--continue'
    ])
  })

  it('does nothing when the profile has no continue arguments', () => {
    const profile: CliProfile = { ...base, continueArgs: undefined }
    expect(buildCliArgs(profile, { prompt: 'ciao', workspace: '/p', continueSession: true })).toEqual([
      'run',
      'ciao'
    ])
  })

  it('expands placeholders in the continue arguments', () => {
    const profile: CliProfile = { ...base, continueArgs: ['--continue', '{workspace}'] }
    expect(
      buildCliArgs(profile, { prompt: 'ciao', workspace: '/project', continueSession: true })
    ).toEqual(['run', 'ciao', '--continue', '/project'])
  })

  it('sends only the new request when the session continues', () => {
    const prompt = buildCliResumePrompt({
      prompt: '  aggiungi il test  ',
      mode: 'build',
      attachments: [{ name: 'shot.png', path: '/tmp/shot.png' }]
    })

    expect(prompt).toContain('Continui la sessione precedente')
    expect(prompt).toContain('Richiesta attuale:\naggiungi il test')
    expect(prompt).toContain('shot.png')
    // The history is the CLI's job now: no conversation block is rebuilt.
    expect(prompt).not.toContain('Conversazione finita qui')
  })

  it('says plan mode out loud, because the CLI would otherwise write', () => {
    expect(buildCliResumePrompt({ prompt: 'guarda', mode: 'plan' })).toContain(
      'non modificare file'
    )
  })
})

describe('failedFast', () => {
  it('recognises a rejected argument', () => {
    expect(failedFast(result({ code: 1, error: 'unknown flag', ms: 900 }))).toBe(true)
  })

  it('never treats real work, an abort or a timeout as an argument problem', () => {
    expect(failedFast(result({ code: 1, error: 'x', text: 'fatto', ms: 900 }))).toBe(false)
    expect(failedFast(result({ code: 1, error: 'x', ms: 60_000 }))).toBe(false)
    expect(failedFast(result({ code: -1, error: 'x', aborted: true }))).toBe(false)
    expect(failedFast(result({ code: -1, error: 'x', timedOut: true }))).toBe(false)
    expect(failedFast(result({ code: 0 }))).toBe(false)
  })
})

describe('discovering the continue flag', () => {
  it('proposes --continue when the help lists it without a value', () => {
    const help = [
      'Options:',
      '  -c, --continue              Continue the most recent session',
      '  -m, --model <id>            Model to use'
    ].join('\n')

    const { proposal, findings } = proposalFromHelp(help)
    expect(proposal.continueArgs).toEqual(['--continue'])
    expect(findings.some((finding) => finding.field === 'continue')).toBe(true)
  })

  it('ignores --resume when it needs an id the app does not have', () => {
    const help = ['Options:', '  --resume <id>               Resume a specific session'].join('\n')
    expect(proposalFromHelp(help).proposal.continueArgs).toBeUndefined()
  })
})

describe('profile validation', () => {
  it('keeps continueArgs as a list of strings', () => {
    const profile = validateCliProfile({
      label: 'Axet',
      command: 'axet-code',
      args: ['run', '{prompt}'],
      continueArgs: ['--continue']
    })
    expect(profile.continueArgs).toEqual(['--continue'])
  })

  it('rejects a continueArgs that is not a list', () => {
    expect(() =>
      validateCliProfile({
        label: 'Axet',
        command: 'axet-code',
        args: ['run'],
        continueArgs: '--continue'
      })
    ).toThrow(/continueArgs|continuare/)
  })
})
