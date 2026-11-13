# CharlieCode

A desktop coding agent with a GUI — multi-agent, plan mode, local workspaces, `AGENTS.md`, skills and plugins. Powered by **free models** through [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi), or by any OpenAI-compatible endpoint you add yourself.

No account. No subscription. Your keys stay on your machine.

> **Status: Phase 0 + local workspace.** Model catalog, streaming chat, stop, retry/fallback, project picker, saved sessions, `AGENTS.md` and image/document attachments are implemented and tested. Tools, permissions, skills, plugins and the multi-agent orchestrator are the next phases — see [Roadmap](#roadmap). This README marks clearly what works today and what is planned.

---

## Contents

- [Why another coding agent](#why-another-coding-agent)
- [Install CharlieCode](#install-charliecode)
- [Connect models: FreeLLMAPI](#connect-models-freellmapi)
- [Add your own API (any OpenAI-compatible)](#add-your-own-api-any-openai-compatible)
- [Recommended free model](#recommended-free-model)
- [Using the app](#using-the-app)
- [CLI](#cli)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Roadmap](#roadmap)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [License](#license)

---

## Why another coding agent

CharlieCode is a personal, open prototype of the "agentic IDE" idea:

- **Desktop GUI**, not a terminal. macOS and Windows installers.
- **Free-first.** FreeLLMAPI stacks ~87 free provider tiers behind one OpenAI-compatible endpoint; CharlieCode speaks that protocol, so any free model works.
- **Bring your own model.** Every provider is a plain `{ baseUrl, apiKey }` entry — OpenCode Zen, OpenAI, OpenRouter, LM Studio, Ollama, vLLM, a corporate gateway.
- **Own engine.** No Electron imports in the engine, so it runs headless, is testable on CI for both OSes, and can move to a `utilityProcess` later.

## Install CharlieCode

### macOS

Download `CharlieCode-<version>.dmg` from [Releases](https://github.com/carlolomello/CharlieCode/releases) — pick `arm64` for Apple Silicon, the plain one for Intel — drag the app into *Applications*.

The build is **ad-hoc signed and not notarized**, so macOS blocks the first launch. Either right-click the app → **Open** → **Open**, or:

```bash
xattr -dr com.apple.quarantine /Applications/CharlieCode.app
```

### Windows

Download the `.exe` installer (NSIS, x64) from [Releases](https://github.com/carlolomello/CharlieCode/releases). The installer lets you choose the target folder. SmartScreen may warn about an unsigned binary: *More info* → *Run anyway*.

### From source

```bash
git clone https://github.com/carlolomello/CharlieCode.git
cd CharlieCode
nvm use            # Node 24 (see .nvmrc)
pnpm install
pnpm dev           # app with HMR
```

## Connect models: FreeLLMAPI

CharlieCode does not ship model credentials, and it does not proxy them. It talks to an **OpenAI-compatible `/v1` endpoint**. The easiest one to start with is FreeLLMAPI, which aggregates the free tiers of many providers behind a single URL and a single key.

**FreeLLMAPI is a separate project:** <https://github.com/tashfeenahmed/freellmapi>

### 1. Install and start FreeLLMAPI

Pick one:

| Platform | How |
| --- | --- |
| macOS / Windows | Download the desktop app from [FreeLLMAPI Releases](https://github.com/tashfeenahmed/freellmapi/releases/latest). It lives in the menu bar / tray and serves `http://127.0.0.1:31415`. |
| Docker / Linux / NAS | `curl -fsSL https://freellmapi.co/install.sh \| bash`, then open <http://localhost:3001> |
| From source | `git clone https://github.com/tashfeenahmed/freellmapi && npm install && npm run dev` |

> **Port matters.** The desktop app listens on **31415**; Docker and a source run default to **3001**. CharlieCode auto-detects the router across `3001`, `31415`, `8080`, `8000`, `4000`, `11434`, so you usually do not need to care.

### 2. Add at least one provider key

Open the dashboard (tray icon → *Open Dashboard*, or <http://127.0.0.1:31415>) and go to **Keys**. Add the free tiers you have accounts for — each is a free signup, a few minutes each:

- **Google AI Studio** — generous free tier
- **Groq** — very fast inference
- **Cerebras** — fast, high daily quota
- **OpenRouter** — `:free` models from many labs
- **OpenCode Zen** — hosts `deepseek-v4.1-flash-free` (see below)
- …plus ~80 more providers, or a **custom** OpenAI-compatible endpoint

Without at least one key the router has nothing to route to and returns HTTP 503 `no_providers_configured`. CharlieCode will show a yellow banner instead of a list of models that cannot answer — that is intentional.

### 3. Copy the unified key

On the **Keys** page, copy the unified key from the header. It looks like `freellmapi-…`. That single token is what any client uses; provider keys stay encrypted inside FreeLLMAPI's local database.

### 4. Point CharlieCode at it

The app reads `~/.charliecode/credentials.json`. Create it:

```bash
mkdir -p ~/.charliecode
cat > ~/.charliecode/credentials.json <<'JSON'
{ "freellmapi": { "apiKey": "freellmapi-YOUR-UNIFIED-KEY" } }
JSON
chmod 600 ~/.charliecode/credentials.json
```

Then verify:

```bash
pnpm charliecode:doctor    # → "✔ tutto pronto" and HTTP 200
pnpm models                # lists only models that can actually answer
```

Alternatively, skip the file and use the environment:

```bash
export FREELLMAPI_KEY=freellmapi-YOUR-UNIFIED-KEY
pnpm dev
```

CharlieCode re-reads the catalog on launch and whenever you press **↻**.

## Add your own API (any OpenAI-compatible)

FreeLLMAPI is optional. Anything that implements `/v1/chat/completions` works: a hosted API, a local model server, or a company gateway. Providers live in `~/.charliecode/config.json`:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "freellmapi",
      "label": "FreeLLMAPI (local)",
      "baseUrl": "http://localhost:31415/v1",
      "kind": "router",
      "enabled": true,
      "apiKeyEnv": "FREELLMAPI_KEY"
    },
    {
      "id": "zen",
      "label": "OpenCode Zen",
      "baseUrl": "https://opencode.ai/zen/v1",
      "kind": "direct",
      "enabled": true,
      "apiKeyEnv": "ZEN_API_KEY"
    },
    {
      "id": "lmstudio",
      "label": "LM Studio (local)",
      "baseUrl": "http://localhost:1234/v1",
      "kind": "direct",
      "enabled": false
    }
  ],
  "modelOverrides": {},
  "defaultModel": "zen::deepseek-v4.1-flash-free",
  "fallbackModels": ["freellmapi::auto"],
  "effort": "none"
}
```

and the matching keys in `~/.charliecode/credentials.json`:

```json
{
  "freellmapi": { "apiKey": "freellmapi-…" },
  "zen": { "apiKey": "sk-…" }
}
```

Notes:

- `id` is your name for the provider; it is also the `providerOptions` key used to pass `reasoning_effort`.
- `kind: "router"` enables port auto-detection. Use `"direct"` for fixed endpoints.
- `apiKeyEnv` is checked **before** the credentials file, so `export ZEN_API_KEY=…` also works.
- Local servers that need no key can omit `apiKeyEnv` entirely.
- Keys never leave your machine; requests go from your process straight to the endpoint.
- You can also add a **custom provider inside FreeLLMAPI** (Keys → *Custom*), which is the right move if you want its routing, quota tracking and failover on top of your endpoint.

### Multiple models and failover

`fallbackModels` is an ordered list. CharlieCode retries and then walks it — but **only while no text has been emitted**. Once the model starts answering, a failure surfaces as an error instead of silently switching, so you never get a Frankenstein answer from two models.

## Recommended free model

`deepseek-v4.1-flash-free` is free (cost 0) and is served by **OpenCode Zen**, not by DeepSeek directly:

```json
{
  "id": "zen",
  "label": "OpenCode Zen",
  "baseUrl": "https://opencode.ai/zen/v1",
  "kind": "direct",
  "enabled": true,
  "apiKeyEnv": "ZEN_API_KEY"
}
```

Get a key at <https://opencode.ai/zen>. Effort levels `low` / `high` / `max` map to `reasoning_effort`.

You can also add OpenCode Zen **inside** FreeLLMAPI (Keys → OpenCode Zen). Then the same model appears as `freellmapi::deepseek-v4.1-flash-free` and gains the router's failover. Using both and pointing one at the other via `fallbackModels` is a sensible setup for long agentic runs: free tiers have RPM/RPD caps, and a 429 mid-task is the normal failure mode.

## Using the app

- **Projects** — pick a local folder from the sidebar. The app remembers the last one and the recent list; every chat is tied to its project.
- **Sessions** — every conversation is saved under `~/.charliecode/sessions` as JSONL, listed in the sidebar with rename and delete. Closing the app never loses a chat.
- **Model picker** — grouped by provider, `★` marks free models, `deepseek-v4.1-flash-free` is preselected when available.
- **Effort** — `none` / `low` / `high` / `max`, forwarded as `reasoning_effort` when the provider supports it.
- **Attachments** — drag files onto the composer, paste a screenshot, or use **+ Allega**. Images go to vision models, documents (markdown, code, JSON, CSV…) are inlined as fenced blocks.
- **Project instructions** — `AGENTS.md`, `CHARLIECODE.md` and `CLAUDE.md` in the project root plus a global `~/.charliecode/AGENTS.md` are injected into the system prompt.
- **Providers** — the drawer lets you paste keys, disable a provider, or add any OpenAI-compatible endpoint.
- **Streaming with stop** — abort mid-answer; the UI keeps whatever was already produced.
- **Failure transparency** — the banner tells you how many models were hidden and why (`no_key`, `no_models`).
- **Setup screen** — if no model is available, the app explains what to start instead of failing silently.

## CLI

The same engine is usable headless — useful on a server, in CI, or when the GUI is overkill.

```bash
pnpm charliecode:doctor                    # config, keys, reachability, detected port
pnpm models [--all] [--json]               # catalog with estimated capabilities
pnpm probe [--limit N] [--model key] [--save]  # does the model really emit tool calls?
pnpm smoke "prompt" [--model key] [--effort high]  # end-to-end streaming
pnpm mock                                  # fake OpenAI-compatible router on :3999
```

`pnpm probe --save` writes the measured capabilities back into `config.json`, so the app stops guessing about tool support. Probes run sequentially on purpose: free tiers have low RPM limits.

## Configuration

Everything lives in `~/.charliecode/` (override with `CHARLIECODE_CONFIG_DIR`):

| File | Contents |
| --- | --- |
| `config.json` | providers, capability overrides, default model, fallback chain |
| `credentials.json` | API keys per provider (mode `600`) |
| `probe-report.json` | last capability probe |

Environment variables:

| Variable | Effect |
| --- | --- |
| `CHARLIECODE_CONFIG_DIR` | alternative config directory (used by tests and CI) |
| `CHARLIECODE_BASE_URL` | override the `router` provider's base URL |
| `CHARLIECODE_API_KEY` | key valid for any provider (highest priority) |
| `FREELLMAPI_KEY` / `ZEN_API_KEY` / … | per-provider key, from `apiKeyEnv` |
| `NO_COLOR` | plain CLI output |

## Architecture

```
src/
  engine/     pure TypeScript engine — never imports electron
    platform   per-OS shell, EOL and path handling (Windows emulated in tests)
    config     config + credentials, env overrides
    catalog    /v1/models normalization, capability heuristics, overrides
    discovery  router port auto-detection
    client     streaming, retry, fallback chain, provider cache
    probe      real tool-calling detection
    errors     network errors turned into actionable messages
    cli        doctor / models / smoke / probe
  main/       Electron main process, IPC, abort controllers
  preload/    typed contextBridge
  shared/     IPC types
  renderer/   React 19 + Vite
scripts/      mock OpenAI-compatible router (tests, CI)
```

Why this split: the engine is the part that will grow into the agent runtime, so it must be testable without Electron and portable to a `utilityProcess`. Platform differences are injected, not read from `process.platform`, which is why Windows bugs are caught on macOS in unit tests.

Tests: `pnpm test` (unit, including Windows emulation) and `pnpm build`. CI runs on `macos-latest` **and** `windows-latest`, plus an end-to-end pass against the mock router (catalog → streaming → 429 → fallback → probe).

## Roadmap

CharlieCode aims to be a GUI equivalent of Claude Code / OpenCode. The engine is built so each phase lands without a rewrite.

**Phase 0 — foundation (done)**

- [x] Headless engine, no Electron imports
- [x] OpenAI-compatible streaming with stop and retry
- [x] Fallback chain that never mixes two models in one answer
- [x] Model catalog with capability heuristics, manual overrides and real probing
- [x] Router port auto-detection, unusable models hidden with an explanation
- [x] Electron shell, typed IPC, React UI
- [x] macOS dmg (x64 + arm64) and Windows NSIS packaging
- [x] Unit tests + cross-OS CI + mock router e2e

**Phase 1 — a real agent (next)**

- [ ] Tools: `read`, `write`, `edit`, `glob`, `grep`, `bash`
- [ ] `PermissionGate`: deny / allow once / allow always, per tool and per command
- [ ] Diff viewer before any write lands
- [x] Workspace picker (work on a local project folder, not just chat)
- [x] Session persistence (JSONL now, SQLite later) with rename/delete and local history

**Phase 2 — project context**

- [x] `AGENTS.md` discovery and layering: global `~/.charliecode/AGENTS.md`, repo root
- [x] `CHARLIECODE.md` and `CLAUDE.md` compatibility
- [ ] Nested-directory `AGENTS.md` discovery
- [ ] Plan mode: read-only exploration, then an explicit approve-to-execute step
- [ ] Context compaction with token accounting

**Phase 3 — multi-agent**

- [ ] `task` tool: the main agent delegates a scoped job to a subagent
- [ ] Parallel read-only subagents (search, review, test triage) with a shared budget
- [ ] Orchestrator with per-agent model and effort (cheap model for search, strong model for planning)
- [ ] Git worktree isolation for parallel writers

**Phase 4 — extensibility**

- [ ] Skills: `SKILL.md` packages discovered from `~/.charliecode/skills` and `.charliecode/skills`, installable from a git URL
- [ ] Plugins: MCP servers, custom tools and command packs
- [ ] MCP client with per-server permission policy

**Phase 5 — polish**

- [x] File and image attachments (images to vision models, documents inlined as fenced blocks)
- [ ] `safeStorage` for credentials instead of a `600` JSON file
- [ ] Code signing / notarization, auto-update
- [ ] App icon and theming

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev            # HMR

pnpm dist:mac       # dmg x64 + arm64
pnpm dist:win       # NSIS installer (needs Windows or wine)
```

No test touches your real configuration: `CHARLIECODE_CONFIG_DIR` points at a temp dir. The mock router (`pnpm mock`) speaks the same subset of the OpenAI protocol the engine uses, including SSE streaming, tool calls and 429s, so the whole loop is testable offline.

Releases are built by `.github/workflows/release.yml` on real macOS and Windows runners (`workflow_dispatch` or a `v*` tag).

## Troubleshooting

**"Nessun modello disponibile" / empty list.** The router is running but has no provider keys. Open the FreeLLMAPI dashboard → Keys and add one. CharlieCode shows a banner with the exact reason per model.

**HTTP 503 `no_providers_configured`.** Same cause: unified key valid, zero provider keys behind it.

**`connessione rifiutata`.** FreeLLMAPI is not running, or it is on another port. `pnpm charliecode:doctor` prints the detected URL; the app also auto-detects.

**`pnpm doctor` does nothing useful.** That is pnpm's own built-in command. Use `pnpm charliecode:doctor`.

**macOS refuses to open the app.** Ad-hoc signature, no notarization: right-click → Open, or clear the quarantine flag (see [Install](#install-charliecode)).

**429 in the middle of a task.** Free tiers rate-limit. Add another provider in FreeLLMAPI, or configure `fallbackModels` so CharlieCode can move to another model before any text is produced.

**A model claims tool support but never calls tools.** Capabilities are heuristics until measured. Run `pnpm probe --limit 8 --save`.

## Security

- Provider keys are read from `~/.charliecode/credentials.json` (mode `600`) or environment variables, and are sent only to the endpoint you configured.
- Nothing is proxied through a CharlieCode server: there is no backend.
- The renderer runs with `contextIsolation`, `sandbox`, no `nodeIntegration`, and a restrictive CSP; all filesystem and network access goes through typed IPC.
- Builds are unsigned/ad-hoc for now. `safeStorage` and real signing are on the roadmap; until then, treat the installers as developer previews.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
