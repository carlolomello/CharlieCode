import type { FileDiff } from './types'

/**
 * Minimal line diff, good enough for the permission prompt and the viewer.
 *
 * LCS over lines with a size cap: a 5k x 5k table is already 25M cells, so above
 * that we fall back to a coarse "whole file replaced" view instead of freezing
 * the UI on a generated bundle.
 */

const MAX_LINES = 1500

interface Op {
  type: 'ctx' | 'add' | 'del'
  text: string
  oldNo?: number
  newNo?: number
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // A trailing newline is a file terminator, not an extra empty line.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function lcsOps(before: string[], after: string[]): Op[] {
  const n = before.length
  const m = after.length
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))

  for (let i = n - 1; i >= 0; i--) {
    const row = table[i]!
    const next = table[i + 1]!
    for (let j = m - 1; j >= 0; j--) {
      row[j] = before[i] === after[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!)
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: 'ctx', text: before[i]!, oldNo: i + 1, newNo: j + 1 })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ type: 'del', text: before[i]!, oldNo: i + 1 })
      i++
    } else {
      ops.push({ type: 'add', text: after[j]!, newNo: j + 1 })
      j++
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: before[i]!, oldNo: i + 1 })
    i++
  }
  while (j < m) {
    ops.push({ type: 'add', text: after[j]!, newNo: j + 1 })
    j++
  }
  return ops
}

function coarseOps(before: string[], after: string[]): Op[] {
  return [
    ...before.map((text, index) => ({ type: 'del' as const, text, oldNo: index + 1 })),
    ...after.map((text, index) => ({ type: 'add' as const, text, newNo: index + 1 }))
  ]
}

/** Groups ops into unified hunks with `context` lines around each change. */
function toUnified(ops: Op[], context = 3): string {
  const lines: string[] = []
  const changed = ops.map((op) => op.type !== 'ctx')
  let index = 0

  while (index < ops.length) {
    if (!changed[index]) {
      index++
      continue
    }

    const start = Math.max(0, index - context)
    let end = index
    while (end < ops.length) {
      if (changed[end]) {
        end++
        continue
      }
      // Keep going while a change is within 2*context lines.
      let lookahead = end
      while (lookahead < ops.length && !changed[lookahead] && lookahead - end < context * 2) lookahead++
      if (lookahead < ops.length && changed[lookahead]) {
        end = lookahead
        continue
      }
      break
    }
    const sliceEnd = Math.min(ops.length, end + context)

    const slice = ops.slice(start, sliceEnd)
    const oldStart = slice.find((op) => op.oldNo !== undefined)?.oldNo ?? 1
    const newStart = slice.find((op) => op.newNo !== undefined)?.newNo ?? 1
    const oldCount = slice.filter((op) => op.type !== 'add').length
    const newCount = slice.filter((op) => op.type !== 'del').length

    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const op of slice) {
      const prefix = op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '
      lines.push(`${prefix}${op.text}`)
    }

    index = sliceEnd
  }

  return lines.join('\n')
}

export function createDiff(path: string, before: string, after: string, displayPath = path): FileDiff {
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  const tooBig = beforeLines.length > MAX_LINES || afterLines.length > MAX_LINES

  const ops = tooBig ? coarseOps(beforeLines, afterLines) : lcsOps(beforeLines, afterLines)
  const added = ops.filter((op) => op.type === 'add').length
  const removed = ops.filter((op) => op.type === 'del').length
  const unified = toUnified(ops)

  return {
    path,
    displayPath,
    added,
    removed,
    created: before.length === 0 && after.length > 0,
    unified: unified.length > 0 ? unified : 'Nessuna differenza.'
  }
}

export function diffSummary(diff: FileDiff): string {
  if (diff.created) return `${diff.displayPath} · nuovo file (+${diff.added})`
  if (diff.removed === 0) return `${diff.displayPath} · +${diff.added}`
  if (diff.added === 0) return `${diff.displayPath} · -${diff.removed}`
  return `${diff.displayPath} · +${diff.added} / -${diff.removed}`
}
