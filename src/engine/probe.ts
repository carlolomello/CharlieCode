import { writeFile } from 'node:fs/promises'
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { findModel } from './catalog'
import { providerFor, resetProviderCache } from './client'
import { loadConfig, saveConfig } from './config'
import type { Platform } from './platform'
import type { CharlieConfig, ModelEntry, ProbeResult } from './types'

export const PROBE_REPORT_FILE = 'probe-report.json'

export interface ProbeOptions {
  limit?: number
  modelKeys?: string[]
  timeoutMs?: number
  /** Persist probed capabilities into config.modelOverrides. */
  saveOverrides?: boolean
  onProgress?: (result: ProbeResult, index: number, total: number) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function probeOne(
  platform: Platform,
  config: CharlieConfig,
  model: ModelEntry,
  timeoutMs: number
): Promise<ProbeResult> {
  const provider = config.providers.find((p) => p.id === model.providerId)
  const base: ProbeResult = {
    modelKey: model.key,
    label: model.label,
    providerId: model.providerId,
    modelId: model.id,
    ok: false,
    tools: null,
    latencyMs: null,
    ttftMs: null,
    probedAt: new Date().toISOString()
  }

  if (!provider) {
    return { ...base, error: `Provider ${model.providerId} non configurato` }
  }

  const startedAt = Date.now()
  try {
    const compat = await providerFor(platform, provider)
    const result = await generateText({
      model: compat.chatModel(model.id),
      prompt:
        'You are a capability probe. Call the tool `charlie_ping` exactly once with nonce="hello". Do not reply with text.',
      tools: {
        charlie_ping: tool({
          description: 'Ping tool used to detect native tool-calling support.',
          inputSchema: z.object({ nonce: z.string().describe('A nonce to echo back') })
        })
      },
      stopWhen: stepCountIs(1),
      maxOutputTokens: 64,
      temperature: 0,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs)
    })

    const latencyMs = Date.now() - startedAt
    return {
      ...base,
      ok: true,
      tools: result.toolCalls.length > 0,
      latencyMs,
      ttftMs: latencyMs
    }
  } catch (error) {
    return {
      ...base,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Probes a shortlist of models and produces the capability matrix that the
 * public model lists never give you: does it really emit tool calls?
 */
export async function probeModels(
  platform: Platform,
  config: CharlieConfig,
  models: ModelEntry[],
  options: ProbeOptions = {}
): Promise<ProbeResult[]> {
  const timeoutMs = options.timeoutMs ?? 25_000
  let shortlist = models
  if (options.modelKeys && options.modelKeys.length > 0) {
    shortlist = options.modelKeys
      .map((key) => findModel(models, key))
      .filter((model): model is ModelEntry => Boolean(model))
  }
  if (options.limit !== undefined) shortlist = shortlist.slice(0, options.limit)

  const results: ProbeResult[] = []
  resetProviderCache()

  for (let index = 0; index < shortlist.length; index++) {
    const model = shortlist[index]
    if (!model) continue
    const result = await probeOne(platform, config, model, timeoutMs)
    results.push(result)
    options.onProgress?.(result, index, shortlist.length)

    // Free tiers are aggressive with RPM limits: never probe in parallel.
    if (index < shortlist.length - 1) await sleep(400)
  }

  const path = platform.configPath(PROBE_REPORT_FILE)
  await writeFile(
    path,
    `${JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2)}\n`,
    'utf8'
  )

  if (options.saveOverrides) {
    const next: CharlieConfig = { ...config, modelOverrides: { ...config.modelOverrides } }
    for (const result of results) {
      if (!result.ok) continue
      const existing = next.modelOverrides[result.modelKey] ?? {}
      next.modelOverrides[result.modelKey] = {
        ...existing,
        caps: {
          ...existing.caps,
          tools: result.tools === true
        }
      }
    }
    await saveConfig(platform, next)
  }

  return results
}

export function formatProbeTable(results: ProbeResult[]): string {
  const header = ['MODELLO', 'OK', 'TOOLS', 'LATENZA', 'ERRORE']
  const rows = results.map((result) => [
    `${result.providerId}::${result.modelId}`,
    result.ok ? 'sì' : 'no',
    result.tools === null ? '?' : result.tools ? 'sì' : 'NO',
    result.latencyMs === null ? '-' : `${(result.latencyMs / 1000).toFixed(1)}s`,
    (result.error ?? '').slice(0, 70)
  ])

  const all = [header, ...rows]
  const widths = header.map((_, column) =>
    Math.max(...all.map((row) => (row[column] ?? '').length))
  )

  return all
    .map((row, index) => {
      const line = row
        .map((cell, column) => (cell ?? '').padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd()
      return index === 0 ? `${line}\n${'-'.repeat(line.length)}` : line
    })
    .join('\n')
}

export { loadConfig }
