import { describe, expect, it } from 'vitest'
import { candidateBaseUrls, COMMON_ROUTER_PORTS } from './discovery'

describe('candidateBaseUrls', () => {
  it('sostituisce solo la porta, mai il path', () => {
    const urls = candidateBaseUrls('http://localhost:3001/v1')

    expect(urls).toContain('http://localhost:31415/v1')
    expect(urls).not.toContain('http://localhost:3001/v1')
    expect(urls.every((url) => url.startsWith('http://localhost:'))).toBe(true)
    expect(urls).toHaveLength(COMMON_ROUTER_PORTS.length - 1)
  })

  it('mantiene host, schema e path non standard', () => {
    const [first] = candidateBaseUrls('https://llm.example.com/openai/v1/')
    expect(first).toMatch(/^https:\/\/llm\.example\.com:\d+\/openai\/v1$/)
  })

  it('non produce duplicati se la porta è già in elenco', () => {
    expect(candidateBaseUrls('http://localhost:3001/v1', [3001, 3001, 31415])).toEqual([
      'http://localhost:31415/v1'
    ])
  })

  it('torna vuoto per base URL non valide', () => {
    expect(candidateBaseUrls('non-una-url')).toEqual([])
  })
})
