import { describe, expect, it } from 'vitest'
import {
  parseSelection,
  withCliModel,
  withModelKey,
  withToggledFavorite
} from './selection'

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

describe('modelli preferiti', () => {
  it('rilegge le stelle salvate, scartando il resto', () => {
    expect(parseSelection('{"favorites":["a::b","a::b","  ",7,"c::d"]}')).toEqual({
      favorites: ['a::b', 'c::d']
    })
  })

  it('la stella si mette e si toglie, senza toccare il modello scelto', () => {
    let selection = withToggledFavorite({ modelKey: 'a::b', cliModels: { c: 'x/y' } }, 'a::b')
    expect(selection).toEqual({
      modelKey: 'a::b',
      cliModels: { c: 'x/y' },
      favorites: ['a::b']
    })

    selection = withToggledFavorite(selection, 'c::d')
    expect(selection.favorites).toEqual(['a::b', 'c::d'])

    selection = withToggledFavorite(selection, 'a::b')
    expect(selection).toEqual({ modelKey: 'a::b', cliModels: { c: 'x/y' }, favorites: ['c::d'] })
  })

  it('cambiare modello o CLI non spegne le stelle', () => {
    const selection = withModelKey(
      withCliModel(withToggledFavorite({}, 'a::b'), 'opencode', 'x/y'),
      'c::d'
    )
    expect(selection).toEqual({
      modelKey: 'c::d',
      cliModels: { opencode: 'x/y' },
      favorites: ['a::b']
    })
  })
})
