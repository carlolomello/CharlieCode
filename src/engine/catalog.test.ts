import { describe, expect, it } from 'vitest'
import {
  applyOverrides,
  collapseRouterModels,
  findModel,
  guessCaps,
  guessEfforts,
  isChatModel,
  pickDefaultModel
} from './catalog'
import type { CharlieCodeConfig, ModelEntry } from './types'

describe('guessEfforts', () => {
  it('offre tutti i livelli ai modelli che supportano reasoning', () => {
    expect(guessEfforts('deepseek-v4.1-flash')).toEqual(['none', 'low', 'high', 'max'])
    expect(guessEfforts('gpt-5-thinking')).toEqual(['none', 'low', 'high', 'max'])
    expect(guessEfforts('deepseek-v4.1-flash-free')).toEqual(['none', 'low', 'high', 'max'])
  })

  it('limita i modelli ultraleggeri senza reasoning a none', () => {
    expect(guessEfforts('gpt-4o-mini')).toEqual(['none'])
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

const router = {
  id: 'freellmapi',
  label: 'FreeLLMAPI',
  baseUrl: 'http://localhost:31415/v1',
  kind: 'router' as const,
  enabled: true
}

describe('collapseRouterModels', () => {
  it('riduce un router a una sola voce automatica', () => {
    const models = [baseModel, { ...baseModel, key: 'freellmapi::auto', id: 'auto' }]
    const collapsed = collapseRouterModels(models, router)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.id).toBe('auto')
    expect(collapsed[0]?.label).toBe('Automatico (il router sceglie il modello)')
  })

  it('tiene una voce automatica anche quando il router non ha modelli utilizzabili', () => {
    // FreeLLMAPI senza key dei provider: la lista è vuota ma il selettore non
    // deve restare senza scelte.
    const collapsed = collapseRouterModels([], router)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.key).toBe('freellmapi::auto')
    expect(collapsed[0]?.id).toBe('auto')
  })

  it('non tocca i provider diretti né showAllModels', () => {
    const direct = collapseRouterModels([baseModel], { ...router, kind: 'direct' })
    expect(direct).toHaveLength(1)
    expect(direct[0]?.key).toBe(baseModel.key)

    const all = collapseRouterModels([baseModel], { ...router, showAllModels: true })
    expect(all).toHaveLength(1)
    expect(all[0]?.key).toBe(baseModel.key)
  })
})

describe('pickDefaultModel', () => {
  const other: ModelEntry = {
    ...baseModel,
    key: 'openrouter::deepseek',
    providerId: 'openrouter',
    id: 'deepseek',
    caps: { tools: false, vision: false, contextWindow: 32768 }
  }

  it('preferisce il default configurato', () => {
    const cfg = config({})
    cfg.defaultModel = 'openrouter::deepseek'
    expect(pickDefaultModel([baseModel, other], cfg)?.key).toBe('openrouter::deepseek')
  })

  it('senza default sceglie la voce automatica del router', () => {
    const auto: ModelEntry = { ...baseModel, key: 'freellmapi::auto', id: 'auto' }
    const cfg = config({})
    cfg.providers = [router]
    expect(pickDefaultModel([other, auto, baseModel], cfg)?.key).toBe('freellmapi::auto')
  })

  it('ignora un default che non esiste più', () => {
    const cfg = config({})
    cfg.defaultModel = 'zen::deepseek-v4.1-flash-free'
    expect(pickDefaultModel([baseModel], cfg)?.key).toBe(baseModel.key)
  })

  it('restituisce undefined senza modelli', () => {
    expect(pickDefaultModel([], config({}))).toBeUndefined()
  })
})
