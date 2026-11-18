import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Local model runtimes: Ollama, LM Studio, vLLM, llama.cpp/LocalAI, and any
 * container exposing an OpenAI-compatible port. Nothing here is Electron-aware:
 * the wizard and the CLI share the same probe.
 */

export interface LocalPreset {
  id: string
  label: string
  baseUrl: string
  /** Whether the runtime usually needs an API key. */
  needsKey: boolean
  docs?: string
  /** Copy-paste command to start it, shown in the wizard. */
  startCommand?: string
  /** Docker variant of the same thing. */
  container?: string
}

export const LOCAL_PRESETS: LocalPreset[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    docs: 'https://ollama.com/download',
    startCommand: 'brew install ollama && ollama serve',
    container: 'docker run -d --name ollama -p 11434:11434 -v ollama:/root/.ollama ollama/ollama'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    needsKey: false,
    docs: 'https://lmstudio.ai',
    startCommand: 'Apri LM Studio → Developer → Start Server'
  },
  {
    id: 'vllm',
    label: 'vLLM',
    baseUrl: 'http://localhost:8000/v1',
    needsKey: true,
    docs: 'https://docs.vllm.ai',
    container:
      'docker run --gpus all -p 8000:8000 vllm/vllm-openai:latest --model Qwen/Qwen3-8B'
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp / LocalAI',
    baseUrl: 'http://localhost:8080/v1',
    needsKey: false,
    docs: 'https://github.com/ggml-org/llama.cpp',
    container: 'docker run -p 8080:8080 -v ~/.cache/llama.cpp:/models ghcr.io/ggml-org/llama.cpp:server -m /models/model.gguf'
  }
]

export interface ProbeResult {
  ok: boolean
  baseUrl: string
  models?: number
  error?: string
  latencyMs: number
}

export async function probeEndpoint(baseUrl: string, timeoutMs = 900): Promise<ProbeResult> {
  const started = Date.now()
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    const latencyMs = Date.now() - started
    if (!response.ok) {
      return { ok: false, baseUrl, latencyMs, error: `HTTP ${response.status}` }
    }
    const body: unknown = await response.json().catch(() => undefined)
    const record = body as { data?: unknown[]; models?: unknown[] } | undefined
    const list = record?.data ?? record?.models
    return { ok: true, baseUrl, latencyMs, models: Array.isArray(list) ? list.length : undefined }
  } catch (error) {
    return {
      ok: false,
      baseUrl,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export interface DetectedEndpoint extends ProbeResult {
  preset: LocalPreset
}

export async function scanLocalEndpoints(): Promise<DetectedEndpoint[]> {
  const results = await Promise.all(
    LOCAL_PRESETS.map(async (preset) => ({ preset, probe: await probeEndpoint(preset.baseUrl) }))
  )
  return results
    .filter((entry) => entry.probe.ok)
    .map((entry) => ({ ...entry.probe, preset: entry.preset }))
}

/** True when a local binary exists, without launching it. */
export function hasBinary(name: string, extraPaths: string[] = []): boolean {
  const candidates = [
    ...extraPaths,
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/bin/${name}`
  ]
  if (candidates.some((path) => existsSync(path))) return true

  const pathEnv = process.env.PATH ?? process.env.Path ?? ''
  const directories = pathEnv.split(delimiter).filter(Boolean)
  // Windows resolves executables through PATHEXT: `ollama` is `ollama.exe`.
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']

  return directories.some((directory) =>
    extensions.some((extension) => existsSync(join(directory, `${name}${extension}`)))
  )
}

/** Asks Docker whether its daemon is up; used to suggest container commands. */
export async function dockerAvailable(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const child = spawn('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore'
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(false)
    }, timeoutMs)
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
  })
}
