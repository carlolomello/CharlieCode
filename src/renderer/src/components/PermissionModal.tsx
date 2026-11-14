import type { PermissionDecision, PermissionRequest } from '../../../engine/types'
import { DiffView } from './DiffView'

interface PermissionModalProps {
  request: PermissionRequest
  onDecide: (decision: PermissionDecision) => void
}

const RISK_LABEL: Record<PermissionRequest['risk'], string> = {
  low: 'rischio basso',
  medium: 'rischio medio',
  high: 'rischio alto'
}

export function PermissionModal({ request, onDecide }: PermissionModalProps): React.JSX.Element {
  return (
    <div className="overlay permission-overlay">
      <div className="permission" role="dialog" aria-modal="true">
        <div className="permission-head">
          <span className={`risk-pill ${request.risk}`}>{RISK_LABEL[request.risk]}</span>
          <h2>{request.title}</h2>
        </div>

        <p className="permission-detail">{request.detail}</p>

        {request.command && (
          <pre className="permission-command">
            <span className="prompt">$</span> {request.command}
          </pre>
        )}

        {request.diff && <DiffView diff={request.diff} defaultOpen />}

        <div className="permission-actions">
          <button className="ghost" onClick={() => onDecide('deny')}>
            Nega
          </button>
          <button className="ghost" onClick={() => onDecide('allow-always')}>
            Consenti sempre
          </button>
          <button className="primary" onClick={() => onDecide('allow')}>
            Una volta
          </button>
        </div>
        <p className="permission-foot">
          «Consenti sempre» salva la scelta in <code>config.json</code>: potrai revocarla dalle
          impostazioni.
        </p>
      </div>
    </div>
  )
}
