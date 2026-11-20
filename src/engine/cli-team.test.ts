import { describe, expect, it } from 'vitest'
import {
  integrationPrompt,
  maxWorkersOf,
  parseCliPlan,
  planPrompt,
  scheduleWaves,
  workerPrompt,
  type CliPlanItem
} from './cli-team'

const item = (title: string, files: string[]): CliPlanItem => ({
  title,
  files,
  instructions: `fai ${title}`
})

describe('parseCliPlan', () => {
  it('legge il piano anche dentro un blocco di codice', () => {
    const plan = parseCliPlan(
      [
        'Ecco il piano:',
        '```json',
        JSON.stringify({
          items: [
            { title: 'Campo A', files: ['objects/A.field-meta.xml'], instructions: 'crea A' },
            { title: 'Campo B', files: ['./objects/B.field-meta.xml'], instructions: 'crea B' }
          ]
        }),
        '```'
      ].join('\n')
    )

    expect(plan?.items).toHaveLength(2)
    expect(plan?.items[1]?.files).toEqual(['objects/B.field-meta.xml'])
  })

  it('accetta "tasks" e le voci scritte come stringhe', () => {
    const plan = parseCliPlan('{"tasks":["crea il campo X","crea il campo Y"]}')
    expect(plan?.items.map((entry) => entry.instructions)).toEqual([
      'crea il campo X',
      'crea il campo Y'
    ])
  })

  it('scarta percorsi assoluti e che escono dal progetto', () => {
    const plan = parseCliPlan(
      JSON.stringify({
        items: [
          {
            title: 'x',
            files: ['/etc/passwd', '../fuori.txt', 'objects/ok.field-meta.xml'],
            instructions: 'crea'
          }
        ]
      })
    )
    expect(plan?.items[0]?.files).toEqual(['objects/ok.field-meta.xml'])
  })

  it('non inventa un piano da testo senza JSON', () => {
    expect(parseCliPlan('Ho creato tutto, niente da pianificare.')).toBeUndefined()
    expect(parseCliPlan('{"items":[]}')).toBeUndefined()
    expect(parseCliPlan('{"items":[{"title":"vuoto"}]}')).toBeUndefined()
  })

  it('toglie i duplicati e non supera il tetto di voci', () => {
    const many = Array.from({ length: 20 }, (_value, index) => ({
      title: `t${index}`,
      files: [`f${index}.txt`],
      instructions: `fai ${index}`
    }))
    const plan = parseCliPlan(JSON.stringify({ items: [...many, many[0]] }))
    expect(plan?.items).toHaveLength(8)
  })
})

describe('scheduleWaves', () => {
  it('mette in parallelo i lavori che non condividono file', () => {
    const waves = scheduleWaves(
      [item('a', ['a.txt']), item('b', ['b.txt']), item('c', ['c.txt'])],
      3
    )
    expect(waves).toHaveLength(1)
    expect(waves[0]?.map((entry) => entry.title)).toEqual(['a', 'b', 'c'])
  })

  it('serializza i lavori che toccano lo stesso file', () => {
    const waves = scheduleWaves(
      [item('a', ['stesso.txt']), item('b', ['stesso.txt'])],
      3
    )
    expect(waves).toHaveLength(2)
  })

  it('rispetta il tetto di worker per ondata', () => {
    const waves = scheduleWaves(
      [item('a', []), item('b', []), item('c', []), item('d', [])],
      2
    )
    expect(waves.map((wave) => wave.length)).toEqual([2, 2])
  })

  it('non supera mai sei worker', () => {
    const items = Array.from({ length: 10 }, (_value, index) => item(`t${index}`, []))
    expect(scheduleWaves(items, 50)[0]).toHaveLength(6)
  })
})

describe('maxWorkersOf', () => {
  it('parte da tre e resta tra due e sei', () => {
    expect(maxWorkersOf(undefined)).toBe(3)
    expect(maxWorkersOf(1)).toBe(2)
    expect(maxWorkersOf(4)).toBe(4)
    expect(maxWorkersOf(99)).toBe(6)
  })
})

describe('prompts', () => {
  it('il piano vieta di modificare file e chiede solo JSON', () => {
    const prompt = planPrompt({ prompt: 'crea 10 campi', maxWorkers: 3 })
    expect(prompt).toMatch(/Non modificare file/)
    expect(prompt).toContain('"items"')
    expect(prompt).toContain('crea 10 campi')
  })

  it('il worker conosce la sua parte e i file che può toccare', () => {
    const prompt = workerPrompt({
      item: item('Campo A', ['objects/A.field-meta.xml']),
      index: 2,
      total: 3,
      workspace: '/progetto'
    })
    expect(prompt).toContain('worker 2 di 3')
    expect(prompt).toContain('objects/A.field-meta.xml')
    expect(prompt).toMatch(/solo i file elencati/)
  })

  it('l’integrazione riporta i rapporti e l’errore di un worker', () => {
    const prompt = integrationPrompt({
      prompt: 'crea 2 campi',
      workers: [
        { item: item('A', []), text: 'fatto A' },
        { item: item('B', []), text: '', error: 'timeout' }
      ]
    })
    expect(prompt).toContain('fatto A')
    expect(prompt).toContain('ERRORE: timeout')
  })
})
