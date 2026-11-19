import { memo, useDeferredValue, useMemo, type ReactNode } from 'react'

/**
 * A small, dependency-free Markdown renderer.
 *
 * The agent streams Markdown (`**bold**`, fenced code, lists, tables), so
 * showing it as pre-wrapped plain text produced the "strano markup" effect:
 * literal asterisks and backticks all over the chat. This renders the common
 * subset into React elements — no `dangerouslySetInnerHTML`, so a model cannot
 * inject HTML or script into the app.
 */

interface MarkdownProps {
  text: string
  /** Compact spacing for quotes and subagent summaries. */
  dense?: boolean
}

/**
 * Source, not a shared RegExp: `renderInline` recurses into bold/italic bodies,
 * and a module-level /g regex would have its `lastIndex` clobbered by the inner
 * call — which turns the outer scan into an infinite loop.
 */
const INLINE_SOURCE = [
  '(`[^`\\n]+`)', // inline code
  '(\\*\\*(?:[^*\\n]|\\*(?!\\*))+\\*\\*)', // **bold** (may contain *italic*)
  '(__[^_\\n]+__)', // __bold__
  '(~~[^~\\n]+~~)', // ~~strike~~
  '(\\*(?!\\*)[^*\\n]+\\*)', // *italic*
  '(?<![\\w_])(_[^_\\n]+_)(?![\\w_])', // _italic_, not snake_case
  '(!?\\[[^\\]\\n]*\\]\\([^)\\s]+\\))', // [label](url) / ![alt](url)
  '(https?://[^\\s<>()"]+)' // bare url
].join('|')

function openLink(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  void window.charliecode.openExternal(url).catch(() => undefined)
}

function Link({ href, children }: { href: string; children: ReactNode }): React.JSX.Element {
  return (
    <a
      className="md-link"
      href={href}
      onClick={(event) => {
        event.preventDefault()
        openLink(href)
      }}
      title={href}
    >
      {children}
    </a>
  )
}

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  // Fresh regex per call: this function recurses, so a shared /g instance
  // would corrupt the outer scan.
  const pattern = new RegExp(INLINE_SOURCE, 'g')

  while ((match = pattern.exec(text)) !== null) {
    const token = match[0]
    const index = match.index
    // A zero-length match would keep `exec` in place forever.
    if (token.length === 0) {
      pattern.lastIndex = index + 1
      continue
    }
    if (index > lastIndex) nodes.push(text.slice(lastIndex, index))
    lastIndex = index + token.length
    const key = `${keyBase}-${index}`

    if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="md-inline-code">
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(
        <strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>
      )
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={key}>{renderInline(token.slice(2, -2), key)}</del>)
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>)
    } else if (token.startsWith('[') || token.startsWith('![')) {
      const linkMatch = /^!?\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token)
      if (linkMatch) {
        const label = linkMatch[1] ?? ''
        const href = linkMatch[2] ?? ''
        nodes.push(
          <Link key={key} href={href}>
            {label || href}
          </Link>
        )
      } else {
        nodes.push(token)
      }
    } else if (/^https?:\/\//i.test(token)) {
      nodes.push(
        <Link key={key} href={token}>
          {token}
        </Link>
      )
    }
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

interface Block {
  type: 'paragraph' | 'heading' | 'code' | 'list' | 'quote' | 'hr' | 'table'
  level?: number
  lang?: string
  ordered?: boolean
  start?: number
  items?: { text: string; depth: number }[]
  rows?: string[][]
  header?: string[]
  lines?: string[]
  text?: string
}

const FENCE = /^\s*```(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const UL = /^(\s*)[-*+]\s+(.*)$/
const OL = /^(\s*)\d+[.)]\s+(.*)$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const lang = (fence[1] ?? '').trim()
      const body: string[] = []
      index += 1
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1 // closing fence
      blocks.push({ type: 'code', lang, text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' })
      index += 1
      continue
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' })
      index += 1
      continue
    }

    if (TABLE_SEPARATOR.test(line) && blocks.length > 0) {
      const previous = blocks[blocks.length - 1]
      // A header row is always a paragraph (the gather loop stops at the
      // separator) that contains at least one pipe.
      if (previous?.type === 'paragraph' && (previous.text ?? '').includes('|')) {
        const headerLine = (previous.text ?? '').split('\n').pop() ?? ''
        const header = splitRow(headerLine)
        const rows: string[][] = []
        index += 1
        while (
          index < lines.length &&
          (lines[index] ?? '').includes('|') &&
          (lines[index] ?? '').trim()
        ) {
          rows.push(splitRow(lines[index] ?? ''))
          index += 1
        }
        blocks.pop()
        blocks.push({ type: 'table', header, rows })
        continue
      }
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (index < lines.length && QUOTE.test(lines[index] ?? '')) {
        body.push(QUOTE.exec(lines[index] ?? '')?.[1] ?? '')
        index += 1
      }
      blocks.push({ type: 'quote', lines: body })
      continue
    }

    const ulMatch = UL.exec(line)
    const olMatch = OL.exec(line)
    if (ulMatch || olMatch) {
      const ordered = Boolean(olMatch)
      const items: { text: string; depth: number }[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const bullet = UL.exec(current)
        const numbered = OL.exec(current)
        const match = ordered ? numbered : bullet
        if (!match) break
        items.push({
          text: match[2] ?? '',
          depth: Math.floor((match[1] ?? '').length / 2)
        })
        index += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    // Paragraph: gather until a blank line or the start of another block.
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (
        !current.trim() ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        HR.test(current) ||
        QUOTE.test(current) ||
        UL.test(current) ||
        OL.test(current) ||
        // `| a | b |` followed by `| --- | --- |` is a table: stop before the
        // separator so the table branch can claim both lines.
        (paragraph.length > 0 && TABLE_SEPARATOR.test(current))
      ) {
        break
      }
      paragraph.push(current)
      index += 1
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
  }

  return blocks
}

function CodeBlock({ lang, text }: { lang?: string; text: string }): React.JSX.Element {
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'codice'}</span>
        <button
          className="md-code-copy"
          onClick={() => {
            void navigator.clipboard.writeText(text)
          }}
        >
          copia
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  )
}

function ListBlock({ block, keyBase }: { block: Block; keyBase: string }): React.JSX.Element {
  const items = block.items ?? []
  // Group by depth so nested lists render properly.
  const nodes: ReactNode[] = []
  let depth = 0
  let buffer: ReactNode[] = []

  const flush = (): void => {
    if (buffer.length === 0) return
    nodes.push(
      block.ordered ? (
        <ol key={`${keyBase}-l${nodes.length}`} className="md-list">{buffer}</ol>
      ) : (
        <ul key={`${keyBase}-l${nodes.length}`} className="md-list">{buffer}</ul>
      )
    )
    buffer = []
  }

  for (const [i, item] of items.entries()) {
    const itemDepth = Math.min(item.depth, 3)
    if (itemDepth !== depth) {
      flush()
      depth = itemDepth
    }
    buffer.push(
      <li key={`${keyBase}-i${i}`} style={depth > 0 ? { marginLeft: depth * 14 } : undefined}>
        {renderInline(item.text, `${keyBase}-i${i}`)}
      </li>
    )
  }
  flush()

  return <div className="md-list-wrap">{nodes}</div>
}

function MarkdownView({ text, dense }: MarkdownProps): React.JSX.Element {
  // During streaming `text` changes on every token. Parsing the deferred value
  // keeps the composer and the tool cards responsive; React catches up as soon
  // as the stream pauses.
  const deferred = useDeferredValue(text)
  const blocks = useMemo(() => parseBlocks(deferred), [deferred])
  return (
    <div className={`md ${dense ? 'dense' : ''}`}>
      {blocks.map((block, i) => {
        const key = `b${i}`
        switch (block.type) {
          case 'heading': {
            const level = Math.min(block.level ?? 1, 6)
            const Tag = `h${level}` as 'h1'
            return (
              <Tag key={key} className={`md-h md-h${level}`}>
                {renderInline(block.text ?? '', key)}
              </Tag>
            )
          }
          case 'code':
            return <CodeBlock key={key} lang={block.lang} text={block.text ?? ''} />
          case 'list':
            return <ListBlock key={key} block={block} keyBase={key} />
          case 'quote':
            return (
              <blockquote key={key} className="md-quote">
                {parseBlocks((block.lines ?? []).join('\n')).map((inner, j) =>
                  inner.type === 'paragraph' ? (
                    <p key={`${key}-q${j}`}>{renderInline(inner.text ?? '', `${key}-q${j}`)}</p>
                  ) : null
                )}
              </blockquote>
            )
          case 'hr':
            return <hr key={key} className="md-hr" />
          case 'table':
            return (
              <div key={key} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>
                      {(block.header ?? []).map((cell, j) => (
                        <th key={`${key}-h${j}`}>{renderInline(cell, `${key}-h${j}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(block.rows ?? []).map((row, r) => (
                      <tr key={`${key}-r${r}`}>
                        {row.map((cell, c) => (
                          <td key={`${key}-r${r}c${c}`}>{renderInline(cell, `${key}-r${r}c${c}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          default:
            return (
              <p key={key} className="md-p">
                {renderInline(block.text ?? '', key)}
              </p>
            )
        }
      })}
    </div>
  )
}

/** Memoised: tool events re-render the turn, not the Markdown inside it. */
export const Markdown = memo(MarkdownView)
