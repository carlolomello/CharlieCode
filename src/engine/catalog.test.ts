import { describe, expect, it } from 'vitest'
import { applyOverrides, findModel, guessCaps, guessEfforts, isChatModel } from './catalog'
import type { CharlieCodeConfig, ModelEntry } from './types'

describe('guessEfforts', () => {
  it('offre tutti i livelli ai modelli di ragionamento', () => {
    expect(guessEfforts('deepseek-v4.1-flash')).toEqual(['none', 'low', 'high', 'max'])
    expect(guessEfforts('gpt-5-thinking')).toEqual(['none', 'low', 'high', 'max'])
  })

  it('limita i modelli leggeri al solo none', () => {
    expect(guessEfforts('llama-3.2-3b')).toEqual(['none'])
    expect(guessEfforts('deepseek-v4.1-flash-free')).toEqual(['none'])
  })

  it('dà low/high ai modelli generici', () => {
    expect(guessEfforts('mistral-large')).toEqual(['none', 'low', 'high'])
  })
})

describe('isChatModel', () => {
  it('scarta embedding e modelli media', () => {
    expect(isChatModel('text-embedding-3-small')).toBe(false)
    expect(isChatModel('whisper-large-v3')).toBe(false)
    expect(isChatModel('flux-schnell')).toBe(false)
    expect(isChatModel('mock/echo-fast')).toBe(true)
    expect(isChatModel('deepseek-v4.1-flash')).toBe(true)
  })
})

describe('guessCaps', () => {
  it('riconosce i modelli con vision', () => {
    expect(guessCaps('qwen2.5-vl-72b').vision).toBe(true)
    expect(guessCaps('gemini-2.5-flash').vision).toBe(true)
    expect(guessCaps('llama-3.3-70b').vision).toBe(false)
  })

  it('parte da un context window conservativo', () => {
    expect(guessCaps('whatever').contextWindow).toBe(32768)
  })
})

const baseModel: ModelEntry = {
  key: 'freellmapi::mock/echo-fast',
  providerId: 'freellmapi',
  providerLabel: 'FreeLLMAPI',
  id: 'mock/echo-fast',
  label: 'Mock Echo Fast',
  caps: { tools: true, vision: false, contextWindow: 32768 },
  capsConfidence: 'guess',
  effort: 'none',
  efforts: ['none', 'low', 'high']
}

function config(overrides: CharlieCodeConfig['modelOverrides']): CharlieCodeConfig {
  return {
    version: 1,
    providers: [],
    modelOverrides: overrides,
    fallbackModels: [],
    effort: 'none',
    recentWorkspaces: [],
    agents: { maxSteps: 24, subagentMaxSteps: 12, autoApprove: [], autoApproveCommands: [] }
  }
}

describe('applyOverrides', () => {
  it('applica override per chiave completa, marcandoli come manuali', () => {
    const [model] = applyOverrides(
      [baseModel],
      config({ 'freellmapi::mock/echo-fast': { caps: { tools: false }, effort: 'high' } })
    )

    expect(model?.caps.tools).toBe(false)
    expect(model?.caps.contextWindow).toBe(32768)
    expect(model?.capsConfidence).toBe('manual')
    expect(model?.effort).toBe('high')
  })

  it('accetta anche la sola id del modello', () => {
    const [model] = applyOverrides([baseModel], config({ 'mock/echo-fast': { label: 'Rinominato' } }))
    expect(model?.label).toBe('Rinominato')
  })

  it('senza override usa l effort globale', () => {
    const cfg = config({})
    cfg.effort = 'low'
    const [model] = applyOverrides([baseModel], cfg)
    expect(model?.effort).toBe('low')
    expect(model?.capsConfidence).toBe('guess')
  })
})

describe('findModel', () => {
  const models = [baseModel]

  it('trova per chiave, per id e per suffisso', () => {
    expect(findModel(models, 'freellmapi::mock/echo-fast')?.key).toBe(baseModel.key)
    expect(findModel(models, 'mock/echo-fast')?.key).toBe(baseModel.key)
    expect(findModel(models, 'echo-fast')).toBeUndefined()
  })
})
