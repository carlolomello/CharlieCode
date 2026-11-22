import type { UpdateStatus } from '../../../shared/ipc'

/**
 * Progress of an update the user accepted.
 *
 * The question is a native dialog in the main process, because it must be
 * answered before anything is downloaded. Once the answer is yes, the download
 * is a minute of silence on a slow line: this banner is what makes it visible,
 * and the only place the failure is explained with a way out.
 */
export function UpdateBanner({
  status,
  onDismiss
}: {
  status: UpdateStatus
  onDismiss: () => void
}): React.JSX.Element {
  const percent =
    status.state === 'downloading' && status.total > 0
      ? Math.min(100, Math.round((status.received / status.total) * 100))
      : undefined
  const megabytes =
    status.state === 'downloading' ? Math.round(status.received / (1024 * 1024)) : 0
  const releaseUrl = status.state === 'error' ? status.url : undefined

  return (
    <div className={`banner update ${status.state === 'error' ? 'error' : ''}`}>
      <button
        className="banner-close"
        onClick={onDismiss}
        title="Chiudi"
        aria-label="Chiudi l’avviso di aggiornamento"
      >
        ✕
      </button>

      {status.state === 'downloading' && (
        <>
          <strong>Aggiornamento {status.version}</strong>: scarico l’installer…{' '}
          {percent !== undefined ? `${percent}%` : `${megabytes} MB`}
          <span
            className="update-bar"
            role="progressbar"
            aria-valuenow={percent ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${percent ?? 0}%` }} />
          </span>
        </>
      )}

      {status.state === 'installing' && (
        <>
          <strong>Aggiornamento {status.version}</strong>: installo e riavvio l’app…
        </>
      )}

      {status.state === 'error' && (
        <>
          <strong>Aggiornamento non riuscito</strong>: {status.message}
          {releaseUrl && (
            <>
              {' '}
              <button
                className="link"
                onClick={() => void window.charliecode.openExternal(releaseUrl)}
              >
                Apri la pagina della release
              </button>
            </>
          )}
        </>
      )}
    </div>
  )
}
