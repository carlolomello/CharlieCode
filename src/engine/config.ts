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
      id: 'freellmapi',
      label: 'FreeLLMAPI (locale)',
      baseUrl: 'http://localhost:31415/v1',
      kind: 'router',
      enabled: false,
      apiKeyEnv: 'FREELLMAPI_KEY'
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      kind: 'direct',
      enabled: false,
      apiKeyEnv: 'OPENROUTER_API_KEY',
      docs: 'https://openrouter.ai/keys',
      free: true
    },
    // Free tiers, one click each. They ship disabled on purpose: the app starts
    // with no provider, no key and no model, and nothing leaves the machine
    // until you switch one on. Limits change often — the drawer links to the
    // provider's own page instead of quoting numbers that go stale.
    {
      id: 'gemini',
      label: 'Google AI Studio (Gemini)',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      kind: 'direct',
      enabled: false,
      apiKeyEnv: 'GEMINI_API_KEY',
      docs: 'https://aistudio.google.com/apikey',
      free: true
    },
    {
      id: 'groq',
      label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      kind: 'direct',
      enabled: false,
      apiKeyEnv: 'GROQ_API_KEY',
      docs: 'https://console.groq.com/keys',
      free: true
    },
    {
      id: 'cerebras',
      label: 'Cerebras',
      baseUrl: 'https://api.cerebras.ai/v1',
      kind: 'direct',
      enabled: false,
      apiKeyEnv: 'CEREBRAS_API_KEY',
      docs: 'https://cloud.cerebras.ai',
      free: true
    },
    {
      id: 'mistral',
      label: 'Mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      kind: 'direct',
      enabled: false,
      apiKeyEnv: 'MISTRAL_API_KEY',
      docs: 'https://console.mistral.ai/api-keys',
      free: true
    },
    {
      id: 'github-models',
      label: 'GitHub Models',
      baseUrl: 'https://models.github.ai/inference',
      kind: 'direct',
      enabled: false,
      apiKeyEnv: 'GITHUB_TOKEN',
      docs: 'https://github.com/settings/tokens',
      free: true
    },
    {
      id: 'ollama',
      label: 'Ollama (locale)',
      baseUrl: 'http://localhost:11434/v1',
      kind: 'direct',
      enabled: false,
      free: true
    }
  ],
  modelOverrides: {},
  fallbackModels: [],
  effort: 'none',
  recentWorkspaces: [],
  agents: {
    maxSteps: 24,
    subagentMaxSteps: 12,
    autoApprove: ['read', 'ls', 'glob', 'grep'],
    autoApproveCommands: []
  },
  // Built-in plugins ship enabled: they are useful in every project and each
  // one has a switch in the settings drawer.
  plugins: {
    memory: { enabled: true },
    advisor: { enabled: true },
    reach: { enabled: true }
  }
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
    recentWorkspaces: partial.recentWorkspaces ?? [],
    agents: {
      ...base.agents,
      ...(partial.agents ?? {}),
      autoApprove: partial.agents?.autoApprove ?? base.agents.autoApprove,
      autoApproveCommands: partial.agents?.autoApproveCommands ?? base.agents.autoApproveCommands
    },
    plugins: { ...base.plugins, ...(partial.plugins ?? {}) },
    ...(partial.external ? { external: partial.external } : {})
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
 * gateway, test fixture) without editing the config file. Pointing at a router
 * explicitly also turns it on: a provider that is configured by hand and still
 * ignored would be a trap.
 */
function applyEnvOverrides(config: CharlieCodeConfig): CharlieCodeConfig {
  const baseUrl = process.env.CHARLIECODE_BASE_URL
  if (!baseUrl) return config
  return {
    ...config,
    providers: config.providers.map((provider) =>
      provider.kind === 'router' ? { ...provider, baseUrl, enabled: true } : provider
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
