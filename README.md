# Charlie

Assistente di codice multi-agente, con GUI desktop (macOS + Windows) e modelli
free serviti da un router OpenAI-compatible (default: FreeLLMAPI).

**Stato attuale: Fase 0** — tubo end-to-end che funziona: catalog modelli,
streaming, stop, fallback e capability probe. Nessun tool, nessun permesso,
nessun multi-agente: quelli sono Fase 1+.

## Requisiti

- Node 24 LTS (`nvm use` legge `.nvmrc`)
- pnpm 12+
- Un endpoint OpenAI-compatible raggiungibile (FreeLLMAPI in locale, oppure qualunque gateway)

## Setup

```bash
nvm use
pnpm install
pnpm charlie:doctor     # stato di config, key e provider
```

Se `charlie:doctor` dice `non raggiungibile`, il router non è in esecuzione.
Avvia FreeLLMAPI (porta 3001), aggiungi almeno una key free nella dashboard
(Google AI Studio, Groq, Cerebras, OpenRouter) e copia la unified key:

```bash
export FREELLMAPI_KEY=freellmapi-...
```

oppure, in modo persistente:

```bash
mkdir -p ~/.charlie
printf '{ "freellmapi": { "apiKey": "freellmapi-..." } }\n' > ~/.charlie/credentials.json
chmod 600 ~/.charlie/credentials.json
```

Poi:

```bash
pnpm models            # elenco modelli con caps stimati
pnpm probe --limit 8   # matrice reale di tool-calling (RPM-safe, sequenziale)
pnpm smoke "ciao"      # streaming end-to-end da CLI, senza GUI
pnpm dev               # app desktop
```

## Comandi

| Comando | Cosa fa |
| --- | --- |
| `pnpm dev` | app Electron in dev con HMR |
| `pnpm build` | build di produzione in `out/` |
| `pnpm typecheck` | TypeScript su engine, main, preload, renderer |
| `pnpm charlie:doctor` | config, key, raggiungibilità, suggerimenti |
| `pnpm models [--all] [--json]` | catalog modelli con caps stimati |
| `pnpm probe [--limit N] [--model chiave] [--save]` | testa il tool-calling reale dei modelli |
| `pnpm smoke "prompt"` | streaming da CLI con statistiche |

Nota: `pnpm doctor` **no** — è un comando interno di pnpm. Usa `pnpm charlie:doctor`.

## Test e CI

```bash
pnpm test        # unit test dell'engine
pnpm mock        # router OpenAI-compatible finto sulla porta 3999 (per test locali)
```

Il layer `platform` è testato **emulando** Windows da macOS (shell, separatori,
CRLF), quindi le regressioni cross-platform si vedono prima di toccare il PC
aziendale. `.github/workflows/ci.yml` esegue su `macos-latest` **e**
`windows-latest`: unit test, typecheck, build e un e2e completo contro il mock
router (catalog → streaming → 429 → fallback → probe).

## Configurazione

Tutto vive in `~/.charlie/` (override con `CHARLIE_CONFIG_DIR`):

| File | Contenuto |
| --- | --- |
| `config.json` | provider, override dei caps, modello default, fallback chain |
| `credentials.json` | API key per provider (permessi `600`) |
| `probe-report.json` | ultimo risultato del probe |

Esempio di `config.json` con un secondo provider:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "freellmapi",
      "label": "FreeLLMAPI (local)",
      "baseUrl": "http://localhost:3001/v1",
      "kind": "router",
      "enabled": true,
      "apiKeyEnv": "FREELLMAPI_KEY"
    },
    {
      "id": "work-gateway",
      "label": "Gateway aziendale",
      "baseUrl": "https://llm.example.com/v1",
      "kind": "direct",
      "enabled": false,
      "apiKeyEnv": "WORK_LLM_KEY"
    }
  ],
  "modelOverrides": {
    "freellmapi::some-model": { "effort": "high", "caps": { "tools": true, "vision": true } }
  },
  "defaultModel": "freellmapi::some-model",
  "fallbackModels": [],
  "effort": "none"
}
```

Variabili d'ambiente utili:

- `CHARLIE_CONFIG_DIR` — cartella config alternativa (usata dai test/CI)
- `CHARLIE_BASE_URL` — forza la base URL del provider `router` senza toccare i file
- `FREELLMAPI_KEY` — unified key di FreeLLMAPI
- `CHARLIE_API_KEY` — key valida per qualsiasi provider
- `NO_COLOR` — output CLI senza colori

## Struttura

```
src/
  engine/     motore puro (zero import da electron) → CLI, test, utilityProcess
  main/       processo Electron principale + IPC
  preload/    contextBridge tipizzato
  shared/     tipi IPC condivisi
  renderer/   React 19 + Vite
```

L'engine non importa mai `electron`: gira headless, è testabile su macOS e
Windows in CI, e potrà essere spostato in un `utilityProcess` senza modifiche.

## Criteri di accettazione Fase 0

- [x] `pnpm typecheck` e `pnpm build` puliti
- [x] config creata al primo avvio, errori provider leggibili (`pnpm charlie:doctor`)
- [x] catalog `/v1/models` normalizzato, con caps stimati e override manuali
- [x] streaming token-by-token con `stop`
- [x] fallback su catena configurabile solo se non è ancora stato emesso testo
- [x] probe del tool-calling reale, sequenziale per non bruciare le RPM
- [ ] verifica manuale su Windows (quoting, path, CRLF)

## Prossime fasi

1. **Fase 1** — tool (`read`/`write`/`edit`/`glob`/`grep`/`bash`), `PermissionGate`
   con declina/consenti/always, diff viewer, workspace picker.
2. **Fase 2** — compaction, `AGENTS.md`, plan mode, sessioni persistenti.
3. **Fase 3** — `task` tool, orchestratore, subagenti readonly paralleli, worktree.
4. **Fase 4** — skills (`SKILL.md` + installer), MCP.
5. **Fase 5** — allegati e vision, `safeStorage`, packaging firmato, auto-update.

## Note

- Le free tier hanno limiti RPM bassi: il probe è sequenziale di proposito.
- `effort` per i modelli free è mappato su `reasoning_effort` solo se il provider
  lo supporta; altrimenti viene semplicemente ignorato dal router.
- I caps dei modelli sono euristiche finché non esegui `pnpm probe --save`.
