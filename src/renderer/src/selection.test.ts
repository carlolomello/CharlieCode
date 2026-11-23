import { describe, expect, it } from 'vitest'
import { parseSelection, withCliModel, withModelKey } from './selection'

describe('scelta del modello ricordata', () => {
  it('rilegge solo ciò che ha la forma scritta', () => {
    expect(parseSelection(null)).toEqual({})
    expect(parseSelection('non json')).toEqual({})
    expect(parseSelection('[]')).toEqual({})
    expect(parseSelection('{"modelKey":"openai::gpt-6","extra":1}')).toEqual({
      modelKey: 'openai::gpt-6'
    })
    expect(
      parseSelection('{"cliModels":{"opencode":"a/b","altro":42,"terzo":"  "}}')
    ).toEqual({ cliModels: { opencode: 'a/b' } })
  })

  it('tiene il modello di ogni CLI separato dagli altri', () => {
    let selection = withCliModel({}, 'opencode', 'opencode/gpt-6')
    selection = withCliModel(selection, 'agent-two', 'fast')
    expect(selection.cliModels).toEqual({
      opencode: 'opencode/gpt-6',
      'agent-two': 'fast'
    })

    // Svuotare il campo di una CLI non tocca le altre.
    selection = withCliModel(selection, 'opencode', '')
    expect(selection.cliModels).toEqual({ 'agent-two': 'fast' })
  })

  it('cambiare backend non dimentica i modelli delle CLI', () => {
    const selection = withModelKey(
      withCliModel({ modelKey: 'cli:opencode' }, 'opencode', 'opencode/gpt-6'),
      'openai::gpt-6'
    )
    expect(selection).toEqual({
      modelKey: 'openai::gpt-6',
      cliModels: { opencode: 'opencode/gpt-6' }
    })
  })
})
