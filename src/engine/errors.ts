/**
 * Network errors from `fetch` are useless as-is ("fetch failed"), and the same
 * happens on every OS with different wording. This turns them into something a
 * user (or a log) can act on.
 */
export function describeNetworkError(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } } | undefined)?.cause
  const code = cause?.code

  if (code === 'ECONNREFUSED') return 'connessione rifiutata (router non in esecuzione)'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host non risolvibile (DNS)'
  if (code === 'ECONNRESET') return 'connessione interrotta dal provider'
  if (code === 'ETIMEDOUT') return 'timeout di connessione'
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout di connessione'
  if (error instanceof Error && /fetch failed/i.test(error.message)) {
    return cause?.message ? `fetch fallita (${cause.message})` : 'fetch fallita'
  }

  return error instanceof Error ? error.message : String(error)
}
