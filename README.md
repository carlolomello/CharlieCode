# CharlieCode

**A desktop coding agent with a real GUI.** Point it at a folder, describe what you want, and it reads your code, edits files, runs commands and reports back — showing every diff before it touches disk.

No terminal, no account, no subscription. Models are free by default through [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi); any OpenAI-compatible endpoint works too, and your keys never leave your machine.

[![Download](https://img.shields.io/badge/download-installers-brightgreen)](https://github.com/carlolomello/CharlieCode/releases/latest)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

---

## Download and install

Grab the installer from the [latest release](https://github.com/carlolomello/CharlieCode/releases/latest) — no compiling, no toolchain:

| Platform | File | Notes |
| --- | --- | --- |
| macOS · Apple Silicon | [`CharlieCode-0.0.1-arm64.dmg`](https://github.com/carlolomello/CharlieCode/releases/download/v0.0.1/CharlieCode-0.0.1-arm64.dmg) | M1/M2/M3/M4 |
| macOS · Intel | [`CharlieCode-0.0.1.dmg`](https://github.com/carlolomello/CharlieCode/releases/download/v0.0.1/CharlieCode-0.0.1.dmg) | x64 |
| Windows · x64 | [`CharlieCode-Setup-0.0.1.exe`](https://github.com/carlolomello/CharlieCode/releases/download/v0.0.1/CharlieCode%20Setup%200.0.1.exe) | NSIS installer, choose the folder |

macOS builds are **ad-hoc signed, not notarized**, so Gatekeeper blocks the first launch. Right-click the app → **Open** → **Open**, or:

```bash
xattr -dr com.apple.quarantine /Applications/CharlieCode.app
```

On Windows, SmartScreen may warn about an unsigned binary: *More info* → *Run anyway*.

### From source

```bash
git clone https://github.com/carlolomello/CharlieCode.git
cd CharlieCode
nvm use            # Node 24, see .nvmrc
pnpm install
pnpm dev           # app with HMR
```

---

## What it does

- **Plans before it writes.** Flip the topbar switch to **Piano**: the agent explores the project read-only and comes back with a concrete plan (files, steps, risks). One click on **▶ Esegui il piano** switches to **Build** and implements it.
- **Shows the code it changes.** Every `write`/`edit` produces a unified diff in the chat — you see the change *before* it lands on disk.
- **Multi-agent by design.** The `task` tool spawns isolated subagents with their own context (`explorer` read-only, `reviewer`, `implementer`), several in parallel, each with its own live activity card. The main agent gets a compact report back.
- **Ask before it acts.** Destructive tools hit a permission gate: *allow once*, *allow always* (per tool, or per command prefix for `bash`), *deny*. Revocable from the settings drawer.
- **Remembers the project.** Every chat is a saved session tied to a folder; the full model context (tool calls included) is persisted, so resuming actually continues instead of replaying a transcript.
- **Knows your rules.** `AGENTS.md` — plus `CHARLIECODE.md` and `CLAUDE.md` — in the project root and globally in `~/.charliecode/` are injected into the system prompt.
- **Free-first, zero lock-in.** One provider entry (FreeLLMAPI) routes across ~87 free tiers and picks the model itself. Add OpenAI, OpenRouter, Ollama, LM Studio, vLLM or a corporate gateway whenever you want.
- **Speaks Markdown properly.** Headings, lists, tables, quotes and syntax-highlighted code blocks with a copy button — rendered by a small built-in renderer, not by injecting HTML into the app.

The app starts **completely clean**: no providers, no keys, no default model. If nothing is reachable it explains what to start instead of failing silently.

### The mascot

Charlie is a pixel-art developer in a near-black shirt, brown trousers and white shoes. He walks across the sidebar every so often, thinks while the model is working, and sits down at his PC when a turn is running.

---

## Plugins (already installed)

Three plugins ship with the app, enabled by default, each with a switch in **⚙ Provider e chiavi → Plugin**. Turning one off removes its tools *and* its prompt text — nothing lingers.

| Plugin | What it does | Tool |
| --- | --- | --- |
| **Memoria del progetto** | Keeps `.charliecode/memory.md` inside the project: overview, notes and the last turns with the files they touched. It is injected at the start of every session, so you never re-explain the project. Plain Markdown, editable by hand, committable. | `remember` |
| **Consigliere di setup** | Reads the project (languages, scripts, existing instructions) and proposes the useful boring things: the real test/lint commands, an `AGENTS.md`, which bash prefixes are safe to auto-approve, which skills to write. | `suggest_setup` |
| **Agent Reach** | Lets the agent read documentation and pages as clean text. Fetched content is treated as data, never as instructions. | `fetch_url` |

The memory file looks like this, and the "Attività recente" list is appended automatically at the end of each turn:

```markdown
# Memoria del progetto

## Panoramica
App Electron + React per gestire i preventivi.

## Note
- 2026-11-15 — Il comando di test è `pnpm test`; i typecheck girano con `pnpm typecheck`.

## Attività recente
- 2026-11-15 09:31 — sistemare il parser dei tag · src/parser.ts, src/tree.ts
```

In the drawer you can also press **Consigli di setup** to run the advisor without spending a model call, and **Apri memoria del progetto** to edit the memory directly.

---

## First run

1. Launch CharlieCode. The setup screen offers to **install or launch FreeLLMAPI** if it is missing.
2. Open the FreeLLMAPI dashboard and add **at least one free provider key** (Google AI Studio, Groq, Cerebras, OpenRouter…). Each is a free signup of a few minutes.
3. Copy the **unified key** (`freellmapi-…`) from the dashboard header.
4. Paste it in CharlieCode: **⚙ Provider e chiavi** → *FreeLLMAPI* → *Salva*.

That is it. Press **↻** if the list is empty, pick a project folder from the sidebar, and start chatting.

> Without a provider key the router has nothing to route to and returns `503 no_providers_configured`. CharlieCode shows a yellow banner explaining this instead of listing models that cannot answer.

---

## Connect models

### FreeLLMAPI (recommended, free)

FreeLLMAPI is a separate project: <https://github.com/tashfeenahmed/freellmapi>. It aggregates the free tiers of many providers behind one OpenAI-compatible endpoint.

| Platform | How |
| --- | --- |
| macOS / Windows | Desktop app from [FreeLLMAPI releases](https://github.com/tashfeenahmed/freellmapi/releases/latest). Serves `http://127.0.0.1:31415`. |
| Docker / Linux / NAS | `curl -fsSL https://freellmapi.co/install.sh \| bash`, then open <http://localhost:3001> |
| From source | `git clone https://github.com/tashfeenahmed/freellmapi && npm install && npm run dev` |

**Ports.** The desktop app listens on **31415**; Docker and a source run default to **3001**. CharlieCode auto-detects across `3001`, `31415`, `8080`, `8000`, `4000`, `11434`, so you usually do not need to care.

**One entry, not 300.** FreeLLMAPI exposes every model it can reach, but routing is its job. CharlieCode therefore shows a single entry — *Automatico (il router sceglie il modello)* — and lets the router pick. If you really want the full list, tick *mostra tutti i modelli del router* in the provider drawer.

### Any other OpenAI-compatible API

Providers are plain entries in `~/.charliecode/config.json`; add them from the drawer (**⚙ Provider e chiavi** → *Aggiungi*) or by hand:

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
      "id": "lmstudio",
      "label": "LM Studio (locale)",
      "baseUrl": "http://localhost:1234/v1",
      "kind": "direct",
      "enabled": true
    }
  ],
  "defaultModel": "freellmapi::auto",
  "fallbackModels": []
}
```

and the keys in `~/.charliecode/credentials.json`:

```json
{ "freellmapi": { "apiKey": "freellmapi-…" } }
```

Rules worth knowing:

- `id` names the provider and is the key used to forward `reasoning_effort`.
- `kind: "router"` enables port auto-detection and the single-entry collapsing; `"direct"` is a fixed endpoint.
- `apiKeyEnv` is checked **before** the credentials file, so `export FREELLMAPI_KEY=…` works too.
- Local servers need no key at all — omit `apiKeyEnv`.
- A provider with **no key and a non-local URL is left out of the catalog entirely**, so the picker never fills with options that would 401 on send. Enable it and add a key and it appears.
- `modelOverrides` can pin capabilities per model; `fallbackModels` is walked on retry **only while no text has been emitted**, so you never get a Frankenstein answer from two models.

---

## Using the app

| Area | What you get |
| --- | --- |
| **Piano / Build** | Read-only exploration and a plan, then one click to implement it. Plan mode restricts the agent to `read`, `ls`, `glob`, `grep`, `task` and forces subagents to `explorer`. |
| **Projects** | Pick any local folder. The last project and a recent list are remembered; every chat belongs to its project. |
| **Sessions** | JSONL under `~/.charliecode/sessions`, with rename and delete. The model context lives beside it in `<id>.context.json`. |
| **Tools** | `read`, `ls`, `glob`, `grep`, `write`, `edit`, `bash`, `task`. Each call is a card with arguments and result; failures are shown, not swallowed. |
| **Diffs** | Unified diff before every write, rendered inline. |
| **Permissions** | Ask-first for destructive tools, with allow-always per tool and per command prefix. |
| **Subagents** | Parallel, isolated, role-scoped, depth 2. |
| **Model picker** | Grouped by provider, `★` marks free models, one entry per router. |
| **Effort** | Per model: `default` / `low` / `high` / `max`, forwarded as `reasoning_effort`. Non-reasoning models only offer `default`. |
| **Attachments** | Drag, paste or **+ Allega**. Images go to vision models; documents are inlined as fenced blocks. |
| **Streaming** | Token-by-token with a stop button; whatever was produced is kept. Scroll only follows when you are at the bottom. |

### Keyboard

| Key | Action |
| --- | --- |
| `Enter` | send |
| `Shift+Enter` | newline |
| paste image | attach it |

---

## CLI

The same engine runs headless — useful on a server, in CI, or when a GUI is overkill.

```bash
pnpm charliecode:doctor                        # config, keys, reachability, detected port
pnpm models [--all] [--json]                   # catalog with estimated capabilities
pnpm probe [--limit N] [--model key] [--save]  # does the model really emit tool calls?
pnpm smoke "prompt" [--model key] [--effort high]
pnpm mock                                      # fake OpenAI-compatible router on :3999
```

`pnpm probe --save` writes measured capabilities back into `config.json`. Probes run sequentially on purpose: free tiers have low RPM limits.

> `pnpm doctor` is pnpm's own command — use `pnpm charliecode:doctor`.

---

## Configuration

Everything lives in `~/.charliecode/` (override with `CHARLIECODE_CONFIG_DIR`):

| File | Contents |
| --- | --- |
| `config.json` | providers, capability overrides, default model, fallback chain, auto-approve |
| `credentials.json` | API keys per provider (mode `600`) |
| `sessions/` | one JSONL per chat + its context sidecar |
| `probe-report.json` | last capability probe |
| `AGENTS.md` | global instructions injected into every project |

| Variable | Effect |
| --- | --- |
| `CHARLIECODE_CONFIG_DIR` | alternative config directory (tests, CI, portable installs) |
| `CHARLIECODE_BASE_URL` | override the `router` provider's base URL |
| `CHARLIECODE_API_KEY` | key valid for any provider (highest priority) |
| `FREELLMAPI_KEY` / `ZEN_API_KEY` / … | per-provider key, from `apiKeyEnv` |
| `NO_COLOR` | plain CLI output |

---

## Architecture

```
src/
  engine/     pure TypeScript engine — never imports electron
    platform   per-OS shell, EOL and path handling (Windows emulated in tests)
    config     config + credentials, env overrides
    catalog    /v1/models normalization, capability heuristics, router collapsing
    discovery  router port auto-detection
    client     streaming, retry, fallback chain, provider cache
    probe      real tool-calling detection
    local      Ollama / LM Studio / vLLM presets and probing
    agent      agent loop, plan/build modes, system prompt, subagents
    tools      read/ls/glob/grep/write/edit/bash/task + permission helpers
    diff       unified diff generation
    context-store  model context sidecar per session
    sessions   JSONL persistence
    errors     network errors turned into actionable messages
    cli        doctor / models / smoke / probe
  main/       Electron main process, IPC, abort controllers
  preload/    typed contextBridge
  shared/     IPC types
  renderer/   React 19 + Vite (chat, markdown renderer, tool cards, diff viewer, mascot)
scripts/      mock OpenAI-compatible router (tests, CI), mascot preview
```

The engine is the part that grows into the agent runtime, so it must be testable without Electron and portable to a `utilityProcess`. Platform differences are injected, not read from `process.platform`, which is why Windows bugs are caught on macOS in unit tests.

`pnpm test` runs unit tests (including Windows emulation and the Markdown renderer); CI runs on `macos-latest` and `windows-latest`, plus an end-to-end pass against the mock router (catalog → streaming → 429 → fallback → probe).

---

## Roadmap

The goal is a GUI equivalent of Claude Code / OpenCode. Each phase lands without a rewrite.

**Phase 0 — foundation (done)**

- [x] Headless engine, no Electron imports
- [x] OpenAI-compatible streaming with stop and retry
- [x] Fallback chain that never mixes two models in one answer
- [x] Model catalog with capability heuristics, overrides and real probing
- [x] Router port auto-detection, unusable models hidden with an explanation
- [x] Electron shell, typed IPC, React UI
- [x] macOS dmg (x64 + arm64) and Windows NSIS packaging
- [x] Unit tests + cross-OS CI + mock router e2e

**Phase 1 — a real agent (done)**

- [x] Tools: `read`, `ls`, `write`, `edit`, `glob`, `grep`, `bash`
- [x] Permission gate: deny / allow once / allow always, per tool and per command prefix
- [x] Diff viewer before any write lands
- [x] Workspace picker
- [x] Session persistence (JSONL) with rename/delete and a model-context sidecar

**Phase 2 — project context (mostly done)**

- [x] `AGENTS.md` layering: global `~/.charliecode/AGENTS.md`, repo root
- [x] `CHARLIECODE.md` and `CLAUDE.md` compatibility
- [x] Plan mode: read-only exploration, explicit approve-to-execute
- [ ] Nested-directory `AGENTS.md` discovery
- [ ] Context compaction with token accounting

**Phase 3 — multi-agent (done, first pass)**

- [x] `task` tool: the main agent delegates a scoped job to a subagent
- [x] Isolated subagents with a role (`explorer`, `reviewer`, `implementer`), depth limit 2
- [x] Parallel subagents with their own activity cards
- [x] Plan mode propagates: subagents cannot write either
- [ ] Orchestrator with per-agent model and effort (cheap model for search, strong for planning)
- [ ] Git worktree isolation for parallel writers

**Phase 4 — extensibility**

- [x] Built-in plugins with a switch in settings: project memory, setup advisor, web reach
- [x] Project memory: `.charliecode/memory.md`, injected per session, `remember` tool
- [x] Setup advisor: commands, missing `AGENTS.md`, auto-approve and skill suggestions
- [ ] Skills: `SKILL.md` packages from `~/.charliecode/skills` and `.charliecode/skills`, installable from a git URL
- [ ] Third-party plugins: install from a git URL, sandboxed tool packs
- [ ] MCP client with per-server permission policy

**Phase 5 — polish**

- [x] File and image attachments
- [x] Pixel-art mascot: walks, thinks, sits at a desk while the agent works
- [x] App icon (Charlie at his PC)
- [x] Markdown rendering with code blocks and copy
- [ ] `safeStorage` for credentials instead of a `600` JSON file
- [ ] Code signing / notarization, auto-update
- [ ] Theming

**Phase 6 — browser control (last)**

Queued deliberately, after the agent itself is solid. The goal is the OpenCode-style loop: drive a real browser, read the page, click, type, screenshot, and feed what it finds back into the same conversation — behind the same permission gate as `bash`.

- [ ] Browser session owned by the main process (Playwright/Chromium, or attach to an existing Chrome)
- [ ] Tools: `browse_open`, `browse_snapshot`, `browse_click`, `browse_type`, `browse_screenshot`
- [ ] Page content treated as untrusted data, never as instructions
- [ ] Per-origin permission policy, so a page cannot talk the agent into widening its own access
- [ ] Visible "the agent is driving the browser" indicator, plus a one-click stop

---

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev            # HMR

pnpm dist:mac       # dmg x64 + arm64
pnpm dist:win       # NSIS installer
```

No test touches your real configuration: `CHARLIECODE_CONFIG_DIR` points at a temp dir. The mock router (`pnpm mock`) speaks the same subset of the OpenAI protocol the engine uses — SSE streaming, tool calls, 429s — so the whole loop is testable offline.

Releases are built by `.github/workflows/release.yml` on real macOS and Windows runners (`workflow_dispatch` or a `v*` tag).

---

## Troubleshooting

**Empty model list / "Nessun modello disponibile".** The router is running but has no provider keys. FreeLLMAPI dashboard → **Keys** → add one. The banner states the exact reason.

**HTTP 503 `no_providers_configured`.** Same cause: unified key valid, zero provider keys behind it.

**`connessione rifiutata`.** FreeLLMAPI is not running, or on another port. `pnpm charliecode:doctor` prints the detected URL; the app also auto-detects.

**A provider I added does not appear.** Providers without a key and with a non-local URL are hidden on purpose — add the key first.

**I only see one FreeLLMAPI model.** That is the point: the router picks. Tick *mostra tutti i modelli del router* in the provider drawer to see everything.

**429 in the middle of a task.** Free tiers rate-limit. Add another provider in FreeLLMAPI, or set `fallbackModels` so CharlieCode can switch before any text is produced.

**A model claims tool support but never calls tools.** Capabilities are heuristics until measured: `pnpm probe --limit 8 --save`.

**macOS refuses to open the app.** Ad-hoc signature, no notarization — right-click → Open, or clear the quarantine flag (see [Download](#download-and-install)).

---

## Security

- Keys live in `~/.charliecode/credentials.json` (mode `600`) or environment variables and are sent only to the endpoint you configured.
- There is no CharlieCode backend; nothing is proxied.
- The renderer runs with `contextIsolation`, `sandbox`, no `nodeIntegration` and a restrictive CSP; all filesystem and network access goes through typed IPC. Markdown is rendered as React elements, never as injected HTML.
- Builds are unsigned/ad-hoc for now. `safeStorage` and real signing are on the roadmap — treat the installers as developer previews.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
