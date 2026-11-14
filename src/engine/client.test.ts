import { describe, expect, it } from 'vitest'
import { resolveCandidates } from './client'
import type { CharlieCodeConfig, ModelEntry } from './types'

const provider = {
  id: 'freellmapi',
  label: 'FreeLLMAPI',
  baseUrl: 'http://localhost:3001/v1',
  kind: 'router' as const,
  enabled: true
}

function model(id: string): ModelEntry {
  return {
    key: `freellmapi::${id}`,
    providerId: 'freellmapi',
    providerLabel: 'FreeLLMAPI',
    id,
    label: id,
    caps: { tools: true, vision: false, contextWindow: 32768 },
    capsConfidence: 'guess',
    effort: 'none',
    efforts: ['none', 'low', 'high']
  }
}

const config: CharlieCodeConfig = {
  version: 1,
  providers: [provider],
  modelOverrides: {},
  fallbackModels: ['freellmapi::second', 'freellmapi::missing'],
  effort: 'none',
  recentWorkspaces: [],
  agents: { maxSteps: 24, subagentMaxSteps: 12, autoApprove: [], autoApproveCommands: [] }
}

const models = [model('first'), model('second'), model('third')]
const deps = { platform: {} as never, config, models }
const request = { modelKey: 'freellmapi::first', messages: [] }

describe('resolveCandidates', () => {
  it('mette il modello richiesto per primo e poi la fallback chain', () => {
    const { candidates } = resolveCandidates(request, deps)
    expect(candidates.map((candidate) => candidate.model.id)).toEqual(['first', 'second'])
  })

  it('scarta le chiavi di fallback inesistenti senza duplicare', () => {
    const { candidates } = resolveCandidates(
      { ...request, modelKey: 'freellmapi::second' },
      { ...deps, config: { ...config, fallbackModels: ['freellmapi::second', 'freellmapi::first'] } }
    )
    expect(candidates.map((candidate) => candidate.model.id)).toEqual(['second', 'first'])
  })

  it('restituisce un errore leggibile per un modello sconosciuto', () => {
    const { candidates, error } = resolveCandidates({ ...request, modelKey: 'nope' }, deps)
    expect(candidates).toHaveLength(0)
    expect(error).toContain('nope')
  })

  it('ignora i modelli il cui provider non è configurato', () => {
    const orphan = { ...model('orphan'), providerId: 'ghost' }
    const { candidates } = resolveCandidates(request, { ...deps, models: [...models, orphan] })
    expect(candidates.some((candidate) => candidate.model.providerId === 'ghost')).toBe(false)
  })
})
