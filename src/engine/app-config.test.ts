import { describe, expect, it } from 'vitest'
import { applyConfigPatch } from './app-config'
import { defaultConfig } from './config'

const KEYS = ['openai::gpt-4.1', 'groq::llama-3.3', 'ollama::qwen']

describe('applyConfigPatch', () => {
  it('applica modello, effort, fallback, agenti, plugin e provider', () => {
    const base = defaultConfig()
    base.providers[0]!.enabled = false

    const { config, changes } = applyConfigPatch(
      base,
      {
        defaultModel: 'openai::gpt-4.1',
        effort: 'high',
        fallbackModels: ['groq::llama-3.3', 'openai::gpt-4.1'],
        agents: { maxSteps: 40, subagentMaxSteps: 20, autoApprove: ['read', 'grep'] },
        plugins: { memory: { enabled: false } },
        providers: [{ id: base.providers[0]!.id, enabled: true }]
      },
      KEYS
    )

    expect(config.defaultModel).toBe('openai::gpt-4.1')
    expect(config.effort).toBe('high')
    // The default model is removed from the fallback chain on purpose.
    expect(config.fallbackModels).toEqual(['groq::llama-3.3'])
    expect(config.agents.maxSteps).toBe(40)
    expect(config.agents.subagentMaxSteps).toBe(20)
    expect(config.agents.autoApprove).toEqual(['read', 'grep'])
    expect(config.plugins?.memory?.enabled).toBe(false)
    expect(config.providers[0]!.enabled).toBe(true)

    expect(changes.join('\n')).toContain('modello predefinito')
    expect(changes.join('\n')).toContain('plugin memory: on → off')
  })

  it('rifiuta un modello inventato quando il catalogo è noto', () => {
    expect(() =>
      applyConfigPatch(defaultConfig(), { defaultModel: 'ghost::model' }, KEYS)
    ).toThrow(/modello sconosciuto/i)
  })

  it('non tocca il file originale', () => {
    const base = defaultConfig()
    const before = JSON.stringify(base)
    applyConfigPatch(base, { effort: 'max' }, KEYS)
    expect(JSON.stringify(base)).toBe(before)
  })

  it('unisce gli override senza perdere etichetta e capacità', () => {
    const base = defaultConfig()
    base.modelOverrides['openai::gpt-4.1'] = {
      label: 'Il mio modello',
      caps: { vision: true }
    }

    const { config } = applyConfigPatch(
      base,
      { modelOverrides: { 'openai::gpt-4.1': { effort: 'low', efforts: ['low', 'high', 'low'] } } },
      KEYS
    )

    expect(config.modelOverrides['openai::gpt-4.1']).toMatchObject({
      label: 'Il mio modello',
      caps: { vision: true },
      effort: 'low',
      efforts: ['low', 'high']
    })
  })

  it('valida plugin, provider, passi ed effort', () => {
    expect(() =>
      applyConfigPatch(defaultConfig(), { plugins: { ghost: { enabled: true } } }, KEYS)
    ).toThrow(/plugin sconosciuto/i)

    expect(() =>
      applyConfigPatch(defaultConfig(), { providers: [{ id: 'ghost', enabled: true }] }, KEYS)
    ).toThrow(/provider sconosciuto/i)

    expect(() =>
      applyConfigPatch(defaultConfig(), { agents: { maxSteps: 0 } }, KEYS)
    ).toThrow(/maxSteps/)

    expect(() =>
      applyConfigPatch(defaultConfig(), { effort: 'turbo' as never }, KEYS)
    ).toThrow(/effort non valido/i)
  })

  it('non permette di auto-approvare i tool che richiedono sempre conferma', () => {
    const { config, changes } = applyConfigPatch(
      defaultConfig(),
      { agents: { autoApprove: ['read', 'bash', 'write', 'edit', 'config', 'remember'] } },
      KEYS
    )

    expect(config.agents.autoApprove).toEqual(['read'])
    expect(changes.join('\n')).toContain('⚠')
    expect(changes.join('\n')).toContain('sempre confermati')
  })

  it('segnala quando una base URL porta la key su un host remoto', () => {
    const base = defaultConfig()
    const { config, changes } = applyConfigPatch(
      base,
      { providers: [{ id: base.providers[0]!.id, baseUrl: 'https://evil.example/v1' }] },
      KEYS
    )

    expect(config.providers[0]!.baseUrl).toBe('https://evil.example/v1')
    expect(changes.join('\n')).toContain('⚠')
    expect(changes.join('\n')).toContain('evil.example')
  })

  it('azzera il default e il modello dei subagenti con null', () => {
    const base = defaultConfig()
    base.defaultModel = 'openai::gpt-4.1'
    base.agents.subagentModel = 'groq::llama-3.3'

    const { config, changes } = applyConfigPatch(
      base,
      { defaultModel: null, agents: { subagentModel: null } },
      KEYS
    )

    expect(config.defaultModel).toBeUndefined()
    expect(config.agents.subagentModel).toBeUndefined()
    expect(changes.join('\n')).toContain('(nessuno)')
  })

  it('senza differenze non produce cambi', () => {
    const base = defaultConfig()
    base.effort = 'high'
    const { changes } = applyConfigPatch(base, { effort: 'high' }, KEYS)
    expect(changes).toEqual([])
  })
})
