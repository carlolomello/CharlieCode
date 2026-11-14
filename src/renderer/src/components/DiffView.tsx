import { useMemo, useState } from 'react'
import type { FileDiff } from '../../../engine/types'

interface DiffViewProps {
  diff: FileDiff
  /** Collapsed by default inside a tool card; expanded in the side panel. */
  defaultOpen?: boolean
  maxLines?: number
}

interface Line {
  kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx'
  text: string
}

function parse(unified: string): Line[] {
  return unified.split('\n').map((raw) => {
    if (raw.startsWith('+++') || raw.startsWith('---')) return { kind: 'meta', text: raw }
    if (raw.startsWith('@@')) return { kind: 'hunk', text: raw }
    if (raw.startsWith('+')) return { kind: 'add', text: raw }
    if (raw.startsWith('-')) return { kind: 'del', text: raw }
    return { kind: 'ctx', text: raw }
  })
}

export function DiffView({ diff, defaultOpen = false, maxLines = 400 }: DiffViewProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const lines = useMemo(() => parse(diff.unified), [diff.unified])
  const shown = lines.length > maxLines ? lines.slice(0, maxLines) : lines

  return (
    <div className={`diff ${open ? 'open' : ''}`}>
      <button className="diff-head" onClick={() => setOpen((value) => !value)}>
        <span className="diff-caret">{open ? '▾' : '▸'}</span>
        <span className="diff-path" title={diff.path}>
          {diff.displayPath}
        </span>
        {diff.created && <span className="diff-badge new">nuovo</span>}
        <span className="diff-stats">
          <span className="add">+{diff.added}</span>
          <span className="del">-{diff.removed}</span>
        </span>
      </button>

      {open && (
        <div className="diff-body">
          {shown.map((line, index) => (
            <div key={index} className={`diff-line ${line.kind}`}>
              <span className="diff-sign">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
              </span>
              <span className="diff-text">{line.text.replace(/^[+-]/, '')}</span>
            </div>
          ))}
          {lines.length > maxLines && (
            <div className="diff-more">… {lines.length - maxLines} righe non mostrate</div>
          )}
        </div>
      )}
    </div>
  )
}
