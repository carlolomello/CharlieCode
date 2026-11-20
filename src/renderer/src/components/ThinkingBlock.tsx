import { useEffect, useState } from 'react'

/**
 * The reasoning a CLI streamed before its answer.
 *
 * Freebuff, opencode and claudecode all show this: while the model thinks the
 * block is open and growing, and when the turn ends it folds away so it never
 * sits between the user and the result. Clicking the header reopens it.
 *
 * It is deliberately ephemeral: reasoning is the model's monologue, so it is
 * not stored in the session and never comes back on the next turn.
 */
export function ThinkingBlock({
  text,
  live
}: {
  text: string
  live: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(live)

  // A new turn reopens it: the user asked to watch it reason, not to find a
  // closed box.
  useEffect(() => setOpen(live), [live])

  const trimmed = text.trim()
  if (!trimmed) return null

  return (
    <div className={`thinking ${live ? 'live' : 'done'}`}>
      <button className="thinking-head" onClick={() => setOpen((value) => !value)}>
        <span className="thinking-caret">{open ? '▾' : '▸'}</span>
        <span className="thinking-title">Ragionamento</span>
        {live && <span className="thinking-pulse" />}
      </button>
      {open && <div className="thinking-body">{trimmed}</div>}
    </div>
  )
}
