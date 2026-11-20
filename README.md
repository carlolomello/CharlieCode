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
| Windows · x64 | [`CharlieCode-Setup-0.0.1.exe`](https://github.com/carlolomello/CharlieCode/releases/download/v0.0.1/CharlieCode-Setup-0.0.1.exe) | NSIS installer, choose the folder |

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
- **Knows itself.** The agent carries a map of CharlieCode's own architecture and can reconfigure the app on request — default model, effort, fallback, plugins, agent limits, routing — through a validated `charliecode_config` tool that shows a diff and asks permission. API keys stay out of reach.
- **Uses the CLI you already have, as a real backend.** If your team approved an agent CLI with its own login, open **⚙ Impostazioni → Modelli → Collega una CLI** and type the command that starts it (`opencode`, a corporate wrapper, your own script): CharlieCode reads its help, finds the models it can use and puts them in the picker. The main conversation can run through that CLI with its own auth, quota and logs, and the thread, project context and files stay the same when you switch back to a native model. The same profile can also power `task` subagents.
- **Free-first, zero lock-in.** One provider entry (FreeLLMAPI) routes across ~87 free tiers and picks the model itself. Add OpenAI, OpenRouter, Ollama, LM Studio, vLLM or a corporate gateway whenever you want.
- **Speaks Markdown properly.** Headings, lists, tables, quotes and syntax-highlighted code blocks with a copy button — rendered by a small built-in renderer, not by injecting HTML into the app.

The app starts **completely clean**: no providers, no keys, no default model. If nothing is reachable it explains what to start instead of failing silently.

### The window

- **Searchable model picker.** The topbar picker filters by model, provider or key as you type; ↑/↓ and Enter switch without touching the mouse. A router that exposes hundreds of models is no longer a long scroll.
- **Tabbed settings.** ⚙ Impostazioni is six tabs — Modelli, Plugin, Progetto, Skill, Permessi, Istruzioni — so the last one is one click away instead of below everything else.
- **Right workbench.** ◫ Pannello opens *Anteprima*, *Codice* and *Browser* next to the chat: the dev-server URL detected from `package.json` (remembered per project), a read-only tree of the project with numbered lines, and an address bar for everything else. Each one is a sandboxed frame, so a page can never reach the app bridge; a site that refuses to be framed opens in the real browser instead.
- **History by day.** Chats in the sidebar are grouped under *Oggi*, *Ieri*, *Ultimi 7 giorni* and *Più vecchie*, inside their project.
- **Keyboard.** ⌘N / Ctrl+N new chat, ⌘K / Ctrl+K search chats, ⌘, / Ctrl+, settings, Esc closes the topmost panel, Enter sends.

### The mascot

Charlie is a pixel-art developer in a near-black shirt, brown trousers and white shoes. He walks across the sidebar every so often, thinks while the model is working, and sits down at his PC when a turn is running.

When a turn spawns subagents, the scene becomes a workshop: Charlie stands behind them with a whip while each running `task` is a different little worker at its own desk, typing and sweating until the subagent reports back. One worker per running subagent, four at most.

---

## Plugins (already installed)

Three plugins ship with the app, enabled by default, each with a switch in **⚙ Impostazioni → Plugin**. Turning one off removes its tools *and* its prompt text — nothing lingers.

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

## Skills

A skill is a reusable procedure in a `SKILL.md`, the same format other coding agents use. Two places, project first:

| Where | Path | Scope |
| --- | --- | --- |
| Project | `.charliecode/skills/<slug>/SKILL.md` | committable, travels with the repo |
| Global | `~/.charliecode/skills/<slug>/SKILL.md` | every project |

```markdown
---
name: typecheck
description: Come verificare i tipi prima di consegnare
---

1. `pnpm typecheck`
2. Se fallisce, correggi gli errori nell'ordine in cui compaiono.
```

The system prompt carries only **name and description**; the body is read through the `skill` tool when the model decides it is relevant, so twenty skills cost a few lines of context. In **⚙ Impostazioni → Skill** you can install one from a git URL (cloned into the chosen folder), open the folders, and remove a skill.

---

## First run

1. Launch CharlieCode. The setup screen offers to **install or launch FreeLLMAPI** if it is missing.
2. Open the FreeLLMAPI dashboard and add **at least one free provider key** (Google AI Studio, Groq, Cerebras, OpenRouter…). Each is a free signup of a few minutes.
3. Copy the **unified key** (`freellmapi-…`) from the dashboard header.
4. Paste it in CharlieCode: **⚙ Impostazioni → Modelli** → *FreeLLMAPI* → *Salva*.

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

**One entry, not 300.** FreeLLMAPI exposes every model it can reach, but routing is its job. CharlieCode therefore shows a single entry — *Automatico (il router sceglie il modello)* — and lets the router pick. If you really want the full list, tick *mostra tutti i modelli del router* in **⚙ Impostazioni → Modelli**.

### A CLI you already have

Some teams do not hand out API keys: the approved tool is a CLI with its own login. **⚙ Impostazioni → Modelli → Collega una CLI** (also reachable from **✦ Collega un modello → CLI esterna**) asks for one thing: the command you would type in a terminal — `opencode`, a corporate wrapper, your own script.

One command is enough. CharlieCode resolves it through PATH, the usual tool-manager directories and `<home>/<tool>/bin`, then through your own login shell (so a CLI installed by a line in `.zshrc` is found even when the app was launched from Finder), reads its own `--help` for the model, effort, read-only, automatic-write and JSON flags, then tries the usual spellings (`--list-models`, `models`, `model list`, …) in parallel and with a generous timeout — these CLIs load their whole runtime before printing the first id, so a short wait turns a working command into an empty list — until one prints the models it can use. When no spelling works, the model already configured in the app reads that help and proposes the command; the proposal is saved only after it really prints a list, and anything that looks like usage text (`Try --help for usage`, `Options:`) is never accepted as a model. On Windows an npm/pnpm CLI is a `.cmd` wrapper, which node cannot spawn without a shell: the JavaScript entry the wrapper points at is run instead, both for the help and for the turn, so the prompt is never parsed as shell syntax and the flags are read even when the CLI is a wrapper. If the help lists its commands, the subcommand that answers one prompt (`run`, `exec`, `ask`) becomes the start of the argv: a TUI-first CLI reads a bare argument as a project folder, and `--prompt` only pre-fills its interface — that is why the turn used to die on `uscita con codice 1` or never answer. The profile is saved and those models are ready in the picker; nothing is installed, no key is copied and no product is hardcoded. The panel keeps every field editable — command, arguments, output format, placeholders — and the profile is just JSON in `~/.charliecode/clis/`. Reconnecting the same command keeps your edits and only fills what is missing.

What that means in practice:

- choose the CLI in the model picker for the main conversation, or leave it as the worker for `task` subagents;
- the models it printed in the connect step are the ones the second selector offers — no manual list to maintain; the list is cached in the profile for ten minutes, so opening the picker does not spawn the CLI again, and **↻** forces a fresh read; notes and table columns (`(default)`, `[free]`, a description beside the id) are stripped, because the id is what reaches `--model`; a list printed on stderr, or printed and then followed by a non-zero exit over an unrelated warning, is still read, and a cold start has two minutes before the probe gives up; a CLI whose provider list is still loading answers `models` with an empty list and exit 0 (`opencode` does exactly that on a cold start), so the probe is repeated a couple of times before the picker accepts that there is nothing to show;
- its own models appear in a second selector when the CLI is selected, and the effort levels come from the profile; when a profile has no models command yet, CharlieCode looks for one the first time you open that list and remembers it; when a CLI cannot list its models at all, that same spot is a text field where you type the model name — the control is never hidden. A profile that does not advertise the model flag still gets `--model <name>`; edit `modelArgs` in the profile when the CLI spells it differently;
- the model calls happen inside that CLI — its auth, its quota, its audit log;
- before each turn CharlieCode writes the recent conversation into a briefing, and after it imports the answer, the tool activity and the diff of the files it changed. Attached documents are inlined in that briefing, and images are declared as not visible: a CLI sandboxed to the project cannot open files under the app config dir, so no unreachable paths are handed over;
- switching between a CLI and a native model keeps the same thread: the canonical context lives in the session, not in the backend;
- **explorer** and **reviewer** subagents run with the profile's read-only flags;
- writing is opt-in per CLI, and only for **implementer** subagents;
- a CLI that rejects the chosen model — exits at once, with nothing on stdout — is retried once without it: the turn runs on the CLI's default model and the transcript says so, instead of ending on `uscita con codice 1`; a failure now carries the first lines of the CLI's own error, the last line of its stdout (some CLIs print a bare `ERROR` on stderr and the reason on stdout) and the exact command that ran, prompt shortened, so the turn can be reproduced in a terminal;
- a flag the CLI itself calls unknown — `Unknown flag: --yolo` from a flag that its top-level help documents but the subcommand that runs the prompt refuses — is not a dead end: the turn is repeated with that flag moved in front of the subcommand and, if it is still refused, without it, and the transcript says which flag was involved; only flags CharlieCode adds, or that the CLI names in its own error, are touched, and the decision is written to `~/.charliecode/cli-learned.json` (keyed by the profile as it is now, so editing the profile retries once) so neither the next turn nor the next launch pays the failed process again;
- the reasoning the CLI streams — a `reasoning_content` field, a `thinking` part, an `analysis` delta, a `reasoning-delta` event — is shown live in the transcript above the answer, with a pulse while it thinks, and folds away when the turn ends; it never enters the answer, the session or the next briefing, so watching it costs nothing, and a profile with an unusual shape points at it with `thinkingPath`; the same block shows a native model's reasoning;
- a profile saved before its help was readable — the usual case for an older `.cmd` install — is repaired automatically the first time you open its model list or send a turn: the prompt starts going through the non-interactive subcommand, and the profile on disk is updated;
- a save never fails because Windows holds the file: the temporary file is renamed with retries and, if a virus scanner or the search indexer keeps the destination locked, written in place — a locked session file used to abort the whole turn with `EPERM: operation not permitted, rename`;
- a CLI that fails the test is reported as failed, not retried silently.

**Squadra CLI.** A CLI normally works one item at a time, which is slow when the items are independent (ten Salesforce fields, ten metadata files). With **Squadra auto** — on by default for a CLI backend — the split happens outside the CLI: the turn starts with a read-only call that must answer with a JSON plan of independent items, the app runs those items as parallel processes of the same CLI (never two on the same file, at most `maxWorkers`, default 3, 2–6 in the profile), then the CLI integrates and verifies once and its answer is the turn's answer. A plan with a single item, or no parsable plan, falls back to a normal turn, so unsplittable work only pays the planning call. Deploy, validate, publish and push stay in the final turn, never in a worker; the workshop shows each worker, its file scope and its result, and stopping the turn stops them all.

### Routing per ruolo (opzionale)

By default every `task` subagent uses the main model, or the configured CLI worker. A project can override that per role in `.charliecode/routing.yaml` — **⚙ Impostazioni → Progetto** shows the current routes and creates the template:

```yaml
enabled: true

roles:
  explorer:
    model: cheap::fast-model
    effort: low
  reviewer:
    model: provider::strong-model
  implementer:
    model: cli:agent-one
    effort: high
```

`model` accepts a native key (`provider::model`) or a CLI key (`cli:<profile>` / `cli:<profile>::<model>`). A route whose model no longer exists is ignored, never fatal; invalid YAML is reported in the drawer and routing stays off. Explicit models chosen by the orchestrator still win, and plan mode still forces read-only subagents.

### Any other OpenAI-compatible API

Providers are plain entries in `~/.charliecode/config.json`; add them from the drawer (**⚙ Impostazioni → Modelli** → *Aggiungi*) or by hand:

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
| **Projects** | Pick any local folder. The last project and a recent list are remembered; every chat belongs to its project. The sidebar searches across all chats, and an unsent draft follows its chat. |
| **Sessions** | JSONL under `~/.charliecode/sessions`, with rename and delete. The model context lives beside it in `<id>.context.json`. |
| **Tools** | `read`, `ls`, `glob`, `grep`, `write`, `edit`, `bash`, `task`. Each call is a card with arguments and result; failures are shown, not swallowed. |
| **Diffs** | Unified diff before every write, rendered inline. If the folder is not a git repository, the panel offers `git init` (no commit, no staged files). |
| **Permissions** | Ask-first for destructive tools, with allow-always per tool and per command prefix. |
| **Subagents** | Parallel, isolated, role-scoped, depth 2. |
| **Model picker** | Grouped by provider, `★` marks free models, one entry per router. CLI profiles appear in the same list, with their own model selector when the CLI exposes one. |
| **Effort** | Per model: `default` / `low` / `high` / `max`, forwarded as `reasoning_effort`. Non-reasoning models only offer `default`. |
| **Attachments** | Drag, paste or **+ Allega**. Images go to vision models; documents are inlined as fenced blocks. |
| **Streaming** | Token-by-token with a stop button; whatever was produced is kept. Scroll only follows when you are at the bottom. |
| **Workbench** | ◫ Pannello: *Anteprima* (URL del dev server rilevato, ricordato per progetto), *Codice* (albero read-only del progetto, righe numerate, file troncati a 200 kB), *Browser* (barra indirizzi, indietro, ricarica). |

### Keyboard

| Key | Action |
| --- | --- |
| `Enter` | send |
| `Shift+Enter` | newline |
| paste image | attach it |

---

## CharlieCode knows itself

The agent is not blind to the app it runs in. Its system prompt carries a compact map of CharlieCode — config paths, backends, tools, plugins, routing, current state — and the main agent has one extra tool, `charliecode_config`.

Ask in chat:

- “Configure CharlieCode for this model: make it the default, effort high, with a cheap fallback.”
- “Make the reviewer use the local CLI and keep the implementer on the main model.”
- “Turn off the web plugin for this project and raise the agent step limit.”

What happens:

1. `read` returns the exact state: enabled providers, key presence (never the key), valid native model keys, CLI profiles, plugins, agent limits, routing and skills.
2. The model proposes a concrete change. It cannot invent a model key: patches are validated against the catalog of the turn.
3. `apply` shows the `config.json` diff and asks permission, exactly like a file write.
4. The change is saved and the drawer refreshes. It applies from the next turn; new chats use the new defaults.

What it can change: default model, effort, fallback chain, per-model effort overrides, agent step limits, subagent model, auto-approved tools and command prefixes, plugin switches, provider enable/base URL/show-all-models, and routing (by editing `.charliecode/routing.yaml` with the normal `write` tool).

What it never does: read or print API keys, write `credentials.json`, or silently widen its own permissions. Adding a key or a CLI profile stays a user action in the drawer; the agent gives exact steps. CLI backends (a CLI running the conversation) do not have the config tool: they know the architecture and guide you, but only native backends can apply.

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
| `clis/` | user-defined CLI profiles: command, argv, models, effort, output (no product presets) |
| `skills/` | global skills, loaded on demand by the `skill` tool |
| `sessions/` | one JSONL per chat + its context sidecar |
| `probe-report.json` | last capability probe |
| `AGENTS.md` | global instructions injected into every project |
| `.charliecode/routing.yaml` (project) | optional per-role models/effort for `task` subagents |

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
    app-config validated patches to the app's own configuration
    self-knowledge architecture map + exact state for the agent
    backends   CLI as a conversation backend: briefing out, text/tools/diff back in
    routing    optional per-role models/effort for subagents
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

The goal is a GUI equivalent of a terminal coding agent, with multi-agent work made visible. Each phase lands without a rewrite.

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
- [x] Context compaction with token accounting

**Phase 3 — multi-agent (done, first pass)**

- [x] `task` tool: the main agent delegates a scoped job to a subagent
- [x] Isolated subagents with a role (`explorer`, `reviewer`, `implementer`), depth limit 2
- [x] Parallel subagents with their own activity cards
- [x] Plan mode propagates: subagents cannot write either
- [x] Per-role model and effort for subagents, opt-in via `.charliecode/routing.yaml`
- [ ] Git worktree isolation for parallel writers

**CLI backends (done)**

- [x] User-defined CLI profiles, with the command searched as you type — no product presets
- [x] `--help` introspection proposes model, effort, plan, auto-approve and output flags
- [x] Several CLIs in the picker at once, each with its own model and effort selector
- [x] One conversation across backends: briefing out, text/tools/diff back in, canonical context in the session
- [x] Profile-driven `task` subagents, read-only by default

**Phase 4 — extensibility**

- [x] Built-in plugins with a switch in settings: project memory, setup advisor, web reach
- [x] Project memory: `.charliecode/memory.md`, injected per session, `remember` tool
- [x] Setup advisor: commands, missing `AGENTS.md`, auto-approve and skill suggestions
- [x] Skills: `SKILL.md` packages from `~/.charliecode/skills` and `.charliecode/skills`, installable from a git URL, loaded on demand by the `skill` tool
- [x] Self-configuration: the agent knows the app's architecture and applies validated config changes behind a diff
- [ ] Third-party plugins: install from a git URL, sandboxed tool packs
- [ ] MCP client with per-server permission policy

**Phase 5 — polish**

- [x] File and image attachments
- [x] Pixel-art mascot: walks, thinks, sits at a desk while the agent works
- [x] App icon (Charlie at his PC)
- [x] Markdown rendering with code blocks and copy
- [x] Chat search, per-chat drafts, and a `git init` proposal when the folder is not a repository
- [x] Streaming Markdown that does not block the composer
- [ ] `safeStorage` for credentials instead of a `600` JSON file
- [ ] Code signing / notarization, auto-update
- [ ] Theming

**Phase 6 — browser control (last)**

Queued deliberately, after the agent itself is solid. The goal is the terminal-agent loop: drive a real browser, read the page, click, type, screenshot, and feed what it finds back into the same conversation — behind the same permission gate as `bash`.

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

Releases are built by `.github/workflows/release.yml` on real macOS and Windows runners. The `publish` job downloads both artifacts and attaches them to the tag's release, so the ~120 MB installers never pass through a manual upload.

The version stays **0.0.1** until the first public cut, so "new build, same version" is a normal move here: point the tag at the commit you want and push it.

```bash
git tag -f v0.0.1 <commit>
git push -f origin v0.0.1     # rebuilds and replaces the release assets
```

Or, without touching the tag: **Actions → release → Run workflow**, leaving `tag` empty to publish to `v<version>` from `package.json` (the branch head is built), or filling `v0.0.1` to attach the fresh build to that existing release.

---

## Troubleshooting

**Empty model list / "Nessun modello disponibile".** The router is running but has no provider keys. FreeLLMAPI dashboard → **Keys** → add one. The banner states the exact reason.

**HTTP 503 `no_providers_configured`.** Same cause: unified key valid, zero provider keys behind it.

**`connessione rifiutata`.** FreeLLMAPI is not running, or on another port. `pnpm charliecode:doctor` prints the detected URL; the app also auto-detects.

**A provider I added does not appear.** Providers without a key and with a non-local URL are hidden on purpose — add the key first.

**I only see one FreeLLMAPI model.** That is the point: the router picks. Tick *mostra tutti i modelli del router* in **⚙ Impostazioni → Modelli** to see everything.

**429 in the middle of a task.** Free tiers rate-limit. Add another provider in FreeLLMAPI, or set `fallbackModels` so CharlieCode can switch before any text is produced.

**A model claims tool support but never calls tools.** Capabilities are heuristics until measured: `pnpm probe --limit 8 --save`.

**macOS refuses to open the app.** Ad-hoc signature, no notarization — right-click → Open, or clear the quarantine flag (see [Download](#download-and-install)).

---

## Security

- Keys live in `~/.charliecode/credentials.json` (mode `600`) or environment variables and are sent only to the endpoint you configured.
- Tools stay inside the project folder: a path outside it, a symlink that escapes it, and `credentials.json` always go through the permission gate, whatever the auto-approve settings say. `fetch_url` refuses localhost, private ranges and cloud-metadata addresses, and re-checks every redirect.
- The self-configuration tool can change `config.json` but never reads or writes `credentials.json`: key presence is reported as a boolean, and every change goes through the permission gate with a diff.
- There is no CharlieCode backend; nothing is proxied.
- The renderer runs with `contextIsolation`, `sandbox`, no `nodeIntegration` and a restrictive CSP; all filesystem and network access goes through typed IPC. Markdown is rendered as React elements, never as injected HTML.
- Builds are unsigned/ad-hoc for now. `safeStorage` and real signing are on the roadmap — treat the installers as developer previews.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
