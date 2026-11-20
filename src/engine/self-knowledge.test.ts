import { describe, expect, it } from 'vitest'
import { defaultConfig } from './config'
import { createPlatform } from './platform'
import { formatAppState, selfKnowledgePrompt } from './self-knowledge'
import type { CliProfileInfo } from '../shared/ipc'
import type { ModelEntry } from './types'

const platform = createPlatform({ id: 'darwin', env: { HOME: '/home/test' } })

const cli: CliProfileInfo = {
  profile: {
    id: 'agent-one',
    label: 'Agente uno',
    command: 'agent-one',
    args: ['run', '{prompt}']
  },
  available: true,
  path: '/usr/local/bin/agent-one'
}

const models: ModelEntry[] = [
  {
    key: 'openai::gpt-4.1',
    providerId: 'openai',
    providerLabel: 'OpenAI',
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    caps: { tools: true, vision: true, contextWindow: 128_000 },
    capsConfidence: 'manual',
    effort: 'none',
    efforts: ['none', 'low', 'high', 'max']
  }
]

describe('selfKnowledgePrompt', () => {
  it('descrive architettura, percorsi e stato attuale', () => {
    const config = defaultConfig()
    config.defaultModel = 'openai::gpt-4.1'
    config.plugins = { memory: { enabled: false } }

    const prompt = selfKnowledgePrompt(config, {
      platform,
      modelKey: 'openai::gpt-4.1',
      workspace: '/progetti/demo',
      cliProfiles: [cli],
      appVersion: '0.0.1',
      canApply: true
    })

    expect(prompt).toContain('conosci te stesso')
    expect(prompt).toContain('/home/test/.charliecode/config.json')
    expect(prompt).toContain('/home/test/.charliecode/credentials.json')
    expect(prompt).toContain('/home/test/.charliecode/clis')
    expect(prompt).toContain('routing.yaml')
    expect(prompt).toContain('Modello richiesto per questo turno: openai::gpt-4.1')
    expect(prompt).toContain('memory=off')
    expect(prompt).toContain('agent-one')
    expect(prompt).toContain('charliecode_config')
    expect(prompt).toContain('Non leggerle')
  })

  it('nel backend CLI dice di guidare l’utente invece di applicare', () => {
    const prompt = selfKnowledgePrompt(defaultConfig(), {
      platform,
      canApply: false
    })

    expect(prompt).toContain('non hai il tool `charliecode_config`')
    expect(prompt).toContain('guida l’utente')
  })
})

describe('formatAppState', () => {
  it('mostra lo stato esatto senza esporre chiavi', () => {
    const config = defaultConfig()
    config.defaultModel = 'openai::gpt-4.1'
    config.fallbackModels = ['groq::llama']

    const output = formatAppState({
      config,
      configPath: '/home/test/.charliecode/config.json',
      appVersion: '0.0.1',
      workspace: '/progetti/demo',
      modelKey: 'openai::gpt-4.1',
      models,
      providerKeys: { freellmapi: false, groq: true },
      cliProfiles: [cli],
      routing: { enabled: false, roles: {} },
      skills: [{ id: 'typecheck', source: 'project' }]
    })

    expect(output).toContain('CONFIGURAZIONE DI CHARLIECODE')
    expect(output).toContain('/home/test/.charliecode/config.json')
    expect(output).toContain('modello predefinito: openai::gpt-4.1')
    expect(output).toContain('openai::gpt-4.1 — GPT-4.1')
    expect(output).toContain('key=si')
    expect(output).toContain('agent-one')
    expect(output).toContain('typecheck (project)')
    expect(output).not.toMatch(/sk-[a-z0-9]/i)
  })
})
