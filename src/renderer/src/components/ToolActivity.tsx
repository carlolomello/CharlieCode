import { useMemo, useState } from 'react'
import type { ToolLog } from '../../../engine/types'
import { DiffView } from './DiffView'
import { Markdown } from './Markdown'

export interface SubagentRun {
  agentId: string
  name: string
  description: string
  modelKey: string
  status: 'running' | 'ok' | 'error'
  summary?: string
  /** Text streamed by the worker while it runs. */
  text?: string
  ms?: number
  /** Tokens the worker spent, when its backend reports them. */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  steps?: number
}

interface ToolActivityProps {
  logs: ToolLog[]
  subagents: SubagentRun[]
  /** A permission is pending: keep the activity visible even if empty. */
  busy?: boolean
  /** Stops one worker without stopping the turn. */
  onCancel?: (agentId: string) => void
  /** Runs a failed worker again, without repeating the whole request. */
  onRetry?: (agentId: string) => void
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

const TOOL_ICONS: Record<string, string> = {
  read: '▤',
  ls: '☰',
  glob: '✧',
  grep: '⌕',
  write: '✎',
  edit: '✎',
  bash: '⌘',
  task: '❖'
}

function statusLabel(status: ToolLog['status']): string {
  switch (status) {
    case 'running':
      return 'in corso'
    case 'ok':
      return 'ok'
    case 'error':
      return 'errore'
    case 'denied':
      return 'negato'
  }
}

function ToolRow({ log }: { log: ToolLog }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hasDetail = Boolean(log.output || log.diff)

  return (
    <div className={`tool ${log.status}`}>
      <button className="tool-head" onClick={() => hasDetail && setOpen((value) => !value)}>
        <span className="tool-icon">{TOOL_ICONS[log.name] ?? '•'}</span>
        <span className="tool-title" title={log.title}>
          {log.title}
        </span>
        <span className={`tool-dot ${log.status}`} />
        <span className="tool-state">{statusLabel(log.status)}</span>
        {typeof log.ms === 'number' && log.status !== 'running' && (
          <span className="tool-ms">{log.ms < 1000 ? `${log.ms}ms` : `${(log.ms / 1000).toFixed(1)}s`}</span>
        )}
        {hasDetail && <span className="tool-caret">{open ? '▾' : '▸'}</span>}
      </button>

      {log.summary && !open && <div className="tool-summary">{log.summary}</div>}

      {open && (
        <div className="tool-detail">
          {log.diff && <DiffView diff={log.diff} defaultOpen />}
          {log.output && (
            <pre className="tool-output">{log.output}</pre>
          )}
          {!log.output && log.summary && <div className="tool-summary">{log.summary}</div>}
        </div>
      )}
    </div>
  )
}

function SubagentCard({
  run,
  logs,
  onCancel,
  onRetry
}: {
  run: SubagentRun
  logs: ToolLog[]
  onCancel?: (agentId: string) => void
  onRetry?: (agentId: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const outputTokens = run.usage?.outputTokens
  return (
    <div className={`subagent ${run.status}`}>
      <div className="subagent-head">
        <button className="subagent-toggle" onClick={() => setOpen((value) => !value)}>
          <span className="subagent-caret">{open ? '▾' : '▸'}</span>
          <span className="subagent-glyph">❖</span>
          <span className="subagent-body">
            <span className="subagent-name">{run.name}</span>
            <span className="subagent-model">{run.modelKey.split('::').pop()}</span>
          </span>
          <span className={`tool-dot ${run.status}`} />
          {typeof run.ms === 'number' && (
            <span className="tool-ms">
              {run.ms < 1000 ? `${run.ms}ms` : `${(run.ms / 1000).toFixed(1)}s`}
            </span>
          )}
          {typeof outputTokens === 'number' && (
            <span className="tool-ms">{formatTokens(outputTokens)} tok</span>
          )}
        </button>
        {run.status === 'running' && onCancel && (
          <button
            className="subagent-stop"
            title="Ferma questo subagente"
            aria-label={`Ferma ${run.name}`}
            onClick={() => onCancel(run.agentId)}
          >
            ■
          </button>
        )}
        {run.status === 'error' && onRetry && (
          <button
            className="subagent-retry"
            title="Riprova questo subagente: gli altri restano come sono"
            aria-label={`Riprova ${run.name}`}
            onClick={() => onRetry(run.agentId)}
          >
            ↻
          </button>
        )}
      </div>
      {open && (
        <div className="subagent-content">
          <p className="subagent-task">{run.description}</p>
          {logs.length > 0 && (
            <div className="subagent-tools">
              {logs.map((log) => (
                <ToolRow key={log.id} log={log} />
              ))}
            </div>
          )}
          {run.text && run.status === 'running' && (
            <div className="subagent-live">
              <Markdown text={run.text} dense />
            </div>
          )}
          {run.summary && <div className="subagent-summary">{run.summary}</div>}
        </div>
      )}
    </div>
  )
}

export function ToolActivity({
  logs,
  subagents,
  busy,
  onCancel,
  onRetry
}: ToolActivityProps): React.JSX.Element | null {
  const mainLogs = useMemo(() => logs.filter((log) => !log.agentId), [logs])
  const byAgent = useMemo(() => {
    const map = new Map<string, ToolLog[]>()
    for (const log of logs) {
      if (!log.agentId) continue
      const list = map.get(log.agentId) ?? []
      list.push(log)
      map.set(log.agentId, list)
    }
    return map
  }, [logs])

  if (mainLogs.length === 0 && subagents.length === 0 && !busy) return null

  return (
    <div className="activity">
      {subagents.map((run) => (
        <SubagentCard
          key={run.agentId}
          run={run}
          logs={byAgent.get(run.agentId) ?? []}
          {...(onCancel ? { onCancel } : {})}
          {...(onRetry ? { onRetry } : {})}
        />
      ))}
      {mainLogs.length > 0 && (
        <div className="tool-list">
          {mainLogs.map((log) => (
            <ToolRow key={log.id} log={log} />
          ))}
        </div>
      )}
    </div>
  )
}
