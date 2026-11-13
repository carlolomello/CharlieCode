import type { ProviderConfig } from './types'

/**
 * The same router ships on different ports depending on how it runs:
 * FreeLLMAPI desktop listens on 31415, Docker/self-host defaults to 3001,
 * LiteLLM and friends use 4000/8000, Ollama 11434.
 *
 * Instead of forcing the user to hunt for the right port, we probe the common
 * ones — but only after the configured URL has already failed.
 */
export const COMMON_ROUTER_PORTS = [3001, 31415, 8080, 8000, 4000, 11434] as const

/** Builds the list of alternative base URLs for the same host, replacing only the port. */
export function candidateBaseUrls(
  baseUrl: string,
  ports: readonly number[] = COMMON_ROUTER_PORTS
): string[] {
  const trimmed = baseUrl.replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return []
  }

  const candidates: string[] = []
  for (const port of ports) {
    const next = new URL(trimmed)
    next.port = String(port)
    const candidate = next.toString().replace(/\/+$/, '')
    if (candidate !== trimmed && !candidates.includes(candidate)) candidates.push(candidate)
  }
  return candidates
}

/**
 * Any HTTP answer (even 401) proves something is listening. A network error
 * means nothing is there.
 */
export async function probeBaseUrl(baseUrl: string, timeoutMs = 700): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    await response.body?.cancel().catch(() => undefined)
    return true
  } catch {
    return false
  }
}

export interface DetectOptions {
  ports?: readonly number[]
  timeoutMs?: number
}

export async function detectRouterBaseUrl(
  provider: ProviderConfig,
  options: DetectOptions = {}
): Promise<string | undefined> {
  const candidates = candidateBaseUrls(provider.baseUrl, options.ports)
  for (const candidate of candidates) {
    if (await probeBaseUrl(candidate, options.timeoutMs)) return candidate
  }
  return undefined
}

const detected = new Map<string, string>()

export function rememberDetectedBaseUrl(providerId: string, baseUrl: string): void {
  detected.set(providerId, baseUrl)
}

export function getDetectedBaseUrl(providerId: string): string | undefined {
  return detected.get(providerId)
}

export function resetDetectedBaseUrls(): void {
  detected.clear()
}
