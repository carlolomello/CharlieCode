CharlieCode is a desktop coding agent with a multi-agent engine: it reads your project, proposes diffs before writing, runs subagents in parallel and asks permission for anything destructive. Plan mode is read-only; build mode applies changes.

## Download

| Platform | File |
| --- | --- |
| macOS · Apple Silicon (M1–M4) | `CharlieCode-0.0.1-arm64.dmg` |
| macOS · Intel | `CharlieCode-0.0.1.dmg` |
| Windows · x64 | `CharlieCode-Setup-0.0.1.exe` |

No Apple Developer ID and no code signing certificate, so both platforms warn on first launch:

- **macOS** — right-click the app → **Open** → **Open**, or run `xattr -dr com.apple.quarantine /Applications/CharlieCode.app`
- **Windows** — SmartScreen → **More info** → **Run anyway**

## First run

1. The app starts empty on purpose: no provider, no key, no model.
2. **⚙ Provider e chiavi** → add a provider. A local router (FreeLLMAPI, LM Studio, any OpenAI-compatible `…/v1`) needs only its URL; a hosted one needs a key.
3. A router collapses to a single entry — **Automatico (il router sceglie il modello)** — and picks per request. Tick *mostra tutti i modelli del router* to choose by hand.
4. Open a project, then ask. **Plan** explores and reports; **Build** writes, always with a diff and a permission prompt.

## What is in this build

- Streaming with retry, mid-stream fallback, and a catalog that hides providers with no key
- Tools: read, ls, glob, grep, write, edit, bash, task — each with per-tool permissions and command auto-approve
- Subagents, plan/build modes, per-model effort levels
- Diff viewer, JSONL sessions with a context sidecar, `AGENTS.md` layering
- Plugins on by default: project memory, setup advisor, web reach
- Skills: `SKILL.md` packages, installable from a git URL, loaded on demand
- The mascot: Charlie walks, thinks, sits at his PC — and while subagents run he stands up and cracks a whip at four very different workers

## Notes

- Keys live in `~/.charliecode/credentials.json` (mode `600`) or environment variables.
- Third-party plugins and an MCP client are not in this build; they need a sandbox and a per-tool permission model first.
