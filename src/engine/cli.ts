import { existsSync } from 'node:fs'
import { findModel, loadCatalog } from './catalog'
import { streamChat } from './client'
import {
  CONFIG_FILE,
  CREDENTIALS_FILE,
  loadConfig,
  maskKey,
  resolveApiKey
} from './config'
import { createPlatform } from './platform'
import { formatProbeTable, probeModels } from './probe'
import { describeNetworkError } from './errors'
import type { CharlieConfig, EffortLevel, ModelEntry } from './types'

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code: number) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
const bold = paint(1)
const dim = paint(2)
const green = paint(32)
const yellow = paint(33)
const red = paint(31)
const cyan = paint(36)

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function has(name: string): boolean {
  return process.argv.includes(name)
}

function positional(after: number): string[] {
  return process.argv.slice(after).filter((arg) => !arg.startsWith('--'))
}

function fail(message: string): never {
  console.error(`${red('✖')} ${message}`)
  process.exit(1)
}

function resolveModel(config: CharlieConfig, models: ModelEntry[]): ModelEntry {
  const explicit = flag('--model')
  if (explicit) {
    const model = findModel(models, explicit)
    if (!model) fail(`Modello "${explicit}" non trovato. Usa \`pnpm models\` per l'elenco.`)
    return model
  }
  if (config.defaultModel) {
    const model = findModel(models, config.defaultModel)
    if (model) return model
  }
  const withTools = models.find((model) => model.caps.tools)
  const fallback = withTools ?? models[0]
  if (!fallback) fail('Nessun modello disponibile: controlla il router e le API key (pnpm charlie:doctor).')
  return fallback
}

async function commandDoctor(): Promise<void> {
  const platform = createPlatform()
  const { config, path, created } = await loadConfig(platform)

  console.log(bold('\nCharlie · doctor'))
  console.log(`${dim('piattaforma')}      ${platform.id}`)
  console.log(`${dim('config dir')}     ${platform.configDir}`)
  console.log(`${dim('config file')}    ${path}${created ? green(' (creato ora)') : ''}`)
  console.log(
    `${dim('credentials')}    ${platform.configPath(CREDENTIALS_FILE)}${
      existsSync(platform.configPath(CREDENTIALS_FILE)) ? '' : dim(' (assente)')
    }`
  )

  let problems = 0
  for (const provider of config.providers) {
    const label = `${provider.label} ${dim(`[${provider.id}]`)}`
    if (!provider.enabled) {
      console.log(`\n${label} ${yellow('disabilitato')}`)
      continue
    }

    const key = await resolveApiKey(platform, provider)
    console.log(`\n${label}`)
    console.log(`  ${dim('baseUrl')}     ${provider.baseUrl}`)
    console.log(
      `  ${dim('api key')}     ${
        key.apiKey ? `${green(maskKey(key.apiKey))} ${dim(key.hint)}` : `${yellow('mancante')} ${dim(key.hint)}`
      }`
    )

    try {
      const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
        headers: key.apiKey ? { Authorization: `Bearer ${key.apiKey}` } : undefined,
        signal: AbortSignal.timeout(5000)
      })
      console.log(`  ${dim('stato')}       ${green(`raggiungibile (HTTP ${response.status})`)}`)
      if (!response.ok) {
        problems++
        const body = (await response.text().catch(() => '')).slice(0, 160)
        console.log(`  ${dim('risposta')}    ${red(body || response.statusText)}`)
      }
    } catch (error) {
      problems++
      const message = describeNetworkError(error)
      console.log(`  ${dim('stato')}       ${red('non raggiungibile')}`)
      console.log(`  ${dim('dettaglio')}    ${message}`)
      if (provider.kind === 'router') {
        console.log(
          `  ${dim('suggerimento')} avvia FreeLLMAPI (porta 3001) oppure imposta CHARLIE_BASE_URL`
        )
      }
    }
  }

  console.log('')
  if (problems > 0) {
    console.log(yellow(`⚠ ${problems} problema/i da risolvere.`))
    console.log(
      dim(
        `  1. avvia il router (es. FreeLLMAPI su http://localhost:3001)\n` +
          `  2. aggiungi la unified key:  export FREELLMAPI_KEY=freellmapi-...\n` +
          `     oppure scrivila in ${platform.configPath(CREDENTIALS_FILE)}:\n` +
          `     { "freellmapi": { "apiKey": "freellmapi-..." } }`
      )
    )
  } else {
    console.log(green('✔ tutto pronto.'))
  }
}

async function commandModels(): Promise<void> {
  const platform = createPlatform()
  const { config } = await loadConfig(platform)
  const { models, errors } = await loadCatalog(platform, config)

  for (const error of errors) {
    console.error(`${red('✖')} ${error.providerLabel}: ${error.message}`)
  }

  if (has('--json')) {
    console.log(JSON.stringify({ models, errors }, null, 2))
    return
  }

  if (models.length === 0) {
    fail('Catalog vuoto. Esegui `pnpm charlie:doctor`.')
  }

  const limit = has('--all') ? models.length : 40
  console.log(bold(`\n${models.length} modelli chat (mostro ${Math.min(limit, models.length)})\n`))
  console.log(dim('MODELLO'.padEnd(52) + 'TOOLS  VISION  CONTEXT'))

  for (const model of models.slice(0, limit)) {
    const tools = model.caps.tools ? green('sì   ') : yellow('?    ')
    const vision = model.caps.vision ? cyan('sì    ') : dim('no    ')
    const context = `${Math.round(model.caps.contextWindow / 1024)}k`
    const label = model.key.length > 50 ? `${model.key.slice(0, 49)}…` : model.key
    console.log(`${label.padEnd(52)}${tools}  ${vision}  ${context}`)
  }

  console.log(
    dim(
      `\n${models.length > limit ? `…${models.length - limit} altri con --all\n` : ''}` +
        `I caps sono euristiche finché non esegui \`pnpm probe\`.\n` +
        `Imposta il default con: --model <chiave> oppure in ${platform.configPath(CONFIG_FILE)}`
    )
  )
}

async function commandSmoke(): Promise<void> {
  const platform = createPlatform()
  const { config } = await loadConfig(platform)
  const { models, errors } = await loadCatalog(platform, config)

  for (const error of errors) console.error(dim(`${yellow('!')} ${error.providerLabel}: ${error.message}`))

  const model = resolveModel(config, models)
  const prompt = positional(2).join(' ').trim() || 'Rispondi in una sola frase: sono operativo.'
  const effort = (flag('--effort') as EffortLevel | undefined) ?? config.effort

  console.log(`${dim('modello')} ${bold(model.key)}  ${dim('effort')} ${effort}\n`)

  let anyText = false
  for await (const event of streamChat(
    {
      modelKey: model.key,
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: Number(flag('--max-tokens') ?? 1024),
      effort
    },
    { platform, config, models }
  )) {
    if (event.type === 'delta') {
      anyText = true
      process.stdout.write(event.text)
    }
    if (event.type === 'start') {
      console.log(dim(`[${event.label}${event.fallbackFrom ? ` ← fallback da ${event.fallbackFrom}` : ''}]`))
    }
    if (event.type === 'done') {
      const usage = event.usage
      console.log(
        dim(
          `\n\n${event.modelKey} · ttft ${event.ttftMs}ms · total ${event.ms}ms` +
            (usage?.outputTokens ? ` · ${usage.outputTokens} token out` : '')
        )
      )
    }
    if (event.type === 'error') {
      console.error(`\n${red('✖')} ${event.message}`)
      process.exitCode = 1
    }
  }

  if (!anyText && process.exitCode !== 1) {
    console.error(yellow('\n⚠ nessun testo ricevuto dal modello.'))
    process.exitCode = 1
  }
}

async function commandProbe(): Promise<void> {
  const platform = createPlatform()
  const { config } = await loadConfig(platform)
  const { models, errors } = await loadCatalog(platform, config)
  for (const error of errors) console.error(dim(`${yellow('!')} ${error.providerLabel}: ${error.message}`))

  if (models.length === 0) fail('Catalog vuoto. Esegui `pnpm charlie:doctor`.')

  const limit = Number(flag('--limit') ?? 8)
  const modelKeys = flag('--model') ? [flag('--model') as string] : undefined

  console.log(bold(`\nProbe di ${modelKeys?.length ?? Math.min(limit, models.length)} modelli…\n`))

  const results = await probeModels(platform, config, models, {
    limit,
    modelKeys,
    saveOverrides: has('--save'),
    onProgress: (result, index, total) => {
      const status = result.ok ? (result.tools ? green('tools') : yellow('no-tools')) : red('errore')
      process.stdout.write(`\r${dim(`[${index + 1}/${total}]`)} ${result.modelKey.padEnd(48)} ${status}   `)
    }
  })

  process.stdout.write('\r'.padEnd(1) + ' '.repeat(90) + '\r')
  console.log(formatProbeTable(results))
  console.log(
    dim(
      `\nReport: ${platform.configPath('probe-report.json')}` +
        (has('--save') ? `\nOverride salvati in ${platform.configPath(CONFIG_FILE)}` : '\nUsa --save per salvare i caps in config')
    )
  )
}

function printHelp(): void {
  console.log(`
${bold('Charlie')} · engine CLI (Phase 0)

${bold('Comandi')}
  doctor                 stato config, key e raggiungibilità provider
  models [--all|--json]  elenco modelli dal catalog
  smoke [prompt] [--model chiave] [--effort none|low|high|max]
                         streaming di prova end-to-end
  probe [--limit N] [--model chiave] [--save]
                         matrice capacità reali (tool calling) dei modelli

${bold('Ambiente')}
  CHARLIE_CONFIG_DIR     cambia la cartella config (default ~/.charlie)
  FREELLMAPI_KEY         unified key di FreeLLMAPI
  CHARLIE_API_KEY        key valida per qualsiasi provider
`)
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help'
  switch (command) {
    case 'doctor':
      await commandDoctor()
      break
    case 'models':
      await commandModels()
      break
    case 'smoke':
      await commandSmoke()
      break
    case 'probe':
      await commandProbe()
      break
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      break
    default:
      fail(`Comando sconosciuto: ${command}`)
  }
}

main().catch((error: unknown) => {
  console.error(red(error instanceof Error ? error.stack ?? error.message : String(error)))
  process.exit(1)
})
