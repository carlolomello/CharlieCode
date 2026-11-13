import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Platform } from './platform'
import type { CharlieCodeConfig, ProviderConfig } from './types'

export const CONFIG_FILE = 'config.json'
export const CREDENTIALS_FILE = 'credentials.json'

export const DEFAULT_CONFIG: CharlieCodeConfig = {
  version: 1,
  providers: [
    {
      // Free by default: Zen serves deepseek-v4.1-flash-free at cost 0. It needs
      // either a free API key or falls back on Zen's anonymous free allowance.
      id: 'zen',
      label: 'OpenCode Zen',
      baseUrl: 'https://opencode.ai/zen/v1',
      kind: 'direct',
      enabled: true,
      apiKeyEnv: 'ZEN_API_KEY'
    },
    {
      id: 'freellmapi',
      label: 'FreeLLMAPI (local)',
      baseUrl: 'http://localhost:3001/v1',
      kind: 'router',
      enabled: true,
      apiKeyEnv: 'FREELLMAPI_KEY'
    }
  ],
  modelOverrides: {},
  defaultModel: 'zen::deepseek-v4.1-flash-free',
  fallbackModels: ['freellmapi::auto'],
  effort: 'none',
  recentWorkspaces: []
}

export function defaultConfig(): CharlieCodeConfig {
  return structuredClone(DEFAULT_CONFIG)
}

export async function ensureConfigDir(platform: Platform): Promise<void> {
  await mkdir(platform.configDir, { recursive: true })
}

function mergeConfig(partial: Partial<CharlieCodeConfig>): CharlieCodeConfig {
  const base = defaultConfig()
  const providers: ProviderConfig[] = [...(partial.providers ?? [])]

  // Always keep shipped defaults around so upgrading the app does not silently
  // drop a provider the user never touched.
  for (const provider of base.providers) {
    if (!providers.some((p) => p.id === provider.id)) providers.push(provider)
  }

  return {
    version: 1,
    providers,
    modelOverrides: partial.modelOverrides ?? {},
    defaultModel: partial.defaultModel ?? base.defaultModel,
    fallbackModels: partial.fallbackModels ?? base.fallbackModels,
    effort: partial.effort ?? base.effort,
    workspace: partial.workspace,
    recentWorkspaces: partial.recentWorkspaces ?? []
  }
}

export interface LoadConfigResult {
  config: CharlieCodeConfig
  path: string
  created: boolean
}

export async function loadConfig(platform: Platform): Promise<LoadConfigResult> {
  const path = platform.configPath(CONFIG_FILE)
  if (!existsSync(path)) {
    await ensureConfigDir(platform)
    const config = applyEnvOverrides(defaultConfig())
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    return { config, path, created: true }
  }

  const raw = await readFile(path, 'utf8')
  try {
    const config = applyEnvOverrides(mergeConfig(JSON.parse(raw) as Partial<CharlieCodeConfig>))
    return { config, path, created: false }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Config non valida in ${path}: ${reason}`)
  }
}

/**
 * `CHARLIECODE_BASE_URL` lets you point the app at another router (LAN, remote
 * gateway, test fixture) without editing the config file.
 */
function applyEnvOverrides(config: CharlieCodeConfig): CharlieCodeConfig {
  const baseUrl = process.env.CHARLIECODE_BASE_URL
  if (!baseUrl) return config
  return {
    ...config,
    providers: config.providers.map((provider) =>
      provider.kind === 'router' ? { ...provider, baseUrl } : provider
    )
  }
}

export async function saveConfig(platform: Platform, config: CharlieCodeConfig): Promise<string> {
  await ensureConfigDir(platform)
  const path = platform.configPath(CONFIG_FILE)
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return path
}

/**
 * `CHARLIECODE_CONFIG_DIR` exists so tests and CI never touch the real user config.
 */
export function configDirFor(platform: Platform, ...segments: string[]): string {
  return join(platform.configDir, ...segments)
}

export type ApiKeySource = 'env' | 'credentials' | 'none'

export interface ApiKeyResolution {
  apiKey?: string
  source: ApiKeySource
  hint: string
}

type CredentialsFile = Record<string, string | { apiKey?: string }>

async function readCredentials(platform: Platform): Promise<CredentialsFile> {
  const path = platform.configPath(CREDENTIALS_FILE)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CredentialsFile
  } catch {
    // A broken credentials file must not break the whole app: env keys still work.
    return {}
  }
}

export async function resolveApiKey(
  platform: Platform,
  provider: ProviderConfig
): Promise<ApiKeyResolution> {
  const globalOverride = process.env.CHARLIECODE_API_KEY
  if (globalOverride) {
    return { apiKey: globalOverride, source: 'env', hint: 'da CHARLIECODE_API_KEY' }
  }

  if (provider.apiKeyEnv) {
    const fromEnv = process.env[provider.apiKeyEnv]
    if (fromEnv) {
      return { apiKey: fromEnv, source: 'env', hint: `da $${provider.apiKeyEnv}` }
    }
  }

  const credentials = await readCredentials(platform)
  const entry = credentials[provider.id]
  const apiKey =
    typeof entry === 'string'
      ? entry
      : entry
        ? entry.apiKey
        : undefined

  if (apiKey) {
    return {
      apiKey,
      source: 'credentials',
      hint: `da ${platform.configPath(CREDENTIALS_FILE)}`
    }
  }

  return {
    source: 'none',
    hint: `imposta ${provider.apiKeyEnv ?? 'CHARLIECODE_API_KEY'} oppure ${platform.configPath(CREDENTIALS_FILE)}`
  }
}

export async function writeCredentials(
  platform: Platform,
  providerId: string,
  apiKey: string
): Promise<string> {
  await ensureConfigDir(platform)
  const path = platform.configPath(CREDENTIALS_FILE)
  const existing = await readCredentials(platform)
  existing[providerId] = { apiKey }
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  if (!platform.isWindows) {
    await chmod(path, 0o600).catch(() => undefined)
  }
  return path
}

export async function deleteCredential(
  platform: Platform,
  providerId: string
): Promise<string> {
  await ensureConfigDir(platform)
  const path = platform.configPath(CREDENTIALS_FILE)
  const existing = await readCredentials(platform)
  delete existing[providerId]
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  if (!platform.isWindows) {
    await chmod(path, 0o600).catch(() => undefined)
  }
  return path
}

export function maskKey(key: string | undefined): string {
  if (!key) return '(assente)'
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}
