import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './Markdown'

const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />)

describe('Markdown', () => {
  it('renders emphasis, code and links without leaking markup', () => {
    const html = render('Ho letto **sfdc-project.json** e `src/index.ts`, vedi [la doc](https://a.b).')
    expect(html).toContain('<strong>sfdc-project.json</strong>')
    expect(html).toContain('md-inline-code')
    expect(html).toContain('href="https://a.b"')
    expect(html).not.toContain('**')
  })

  it('nests inline emphasis without hanging', () => {
    // Regression: a shared /g regex used to clobber lastIndex on recursion and
    // spin forever, crashing the renderer.
    const html = render('**grassetto con *corsivo* dentro** e *altro*')
    expect(html).toContain('<strong>')
    expect(html).toContain('<em>')
  })

  it('renders fenced code blocks verbatim', () => {
    const html = render('```ts\nconst a = 1 < 2\n```')
    expect(html).toContain('md-code')
    expect(html).toContain('const a = 1 &lt; 2')
  })

  it('renders headings, lists and tables', () => {
    const html = render('## Passi\n\n1. primo\n2. secondo\n\n| file | azione |\n| --- | --- |\n| a.ts | nuovo |')
    expect(html).toContain('md-h2')
    expect(html).toContain('<ol')
    expect(html).toContain('<table')
    expect(html).toContain('<th>file</th>')
  })

  it('keeps an unterminated fence from swallowing the rest silently', () => {
    const html = render('testo\n\n```\nnon chiuso')
    expect(html).toContain('md-code')
  })
})
