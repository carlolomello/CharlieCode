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

## Changes in this build

- **The app updates itself:** at startup it asks this repository for the latest release, picks the installer for its own system (Apple Silicon, Intel, Windows) and — if it is newer than the build you are running — asks whether to update. *Aggiorna ora* downloads it and installs it: the dmg is mounted and the bundle replaced on macOS, the NSIS installer runs silently on Windows, and the app reopens updated. The download shows its progress in a banner; *Più tardi* is remembered for that build and asked again on the next one, while **Controlla aggiornamenti** at the bottom of the settings drawer asks on the spot and says whether you are up to date. The bundle an update replaces is kept as `CharlieCode.app.old` until the next launch has loaded, so a build that does not start can be restored by hand. Because the `v0.0.1` tag is rolling, "newer" also compares the asset's upload time with the build stamped into the app, so a rebuild of the same version is offered too. Offline is silent, and a failure links to the release page.
- **You can see what the CLI is doing:** a CLI turn used to show a single line — "sta scrivendo" — while the CLI ran commands, read files and edited them. Now the profile asks for the structured output its own help advertises (`--format json`, `--output-format stream-json`, `--json`) and every call becomes a row: the command, the path, the pattern, the status, the time and the first lines of the output. Profiles saved before this are repaired on the next turn, reading the subcommand's help (`opencode run --help`) when the flag lives there; the field is *Output strutturato* in the CLI panel. The same repair asks for the reasoning (`--thinking`) when the CLI's help documents it, so the wait before the first command is no longer silent.
- **The workshop works with a CLI:** a delegated worker (`task`, `subagent`, an `agent` with a description) opens its own card, so Charlie stands up with the whip while the CLI's subagents work. **Squadra auto** with a CLI now reads its plan from the answer text, so a JSON output stream no longer makes the plan unparsable and the turn falls back to a single process.
- **Retry one worker:** a failed subagent card now has its own ↻. It runs that worker again, with the same card, while the others keep working — no need to resend the whole request and pay for the workers that already succeeded. It only appears while the turn is running, because after the integration the parent answer would not know about the new work.
- **A subagent no longer ends the turn:** its completion reached the parent stream, so the transcript stopped saying the answer was still being written, the message was stamped with the worker's model and timings, and a worker error marked the whole turn as failed. A nested turn now reports only through its own card.
- **One worker at a time:** each subagent card has its own stop button, so a worker that is stuck no longer forces you to kill the whole turn (and the other workers with it). Stopping the turn still stops everything.
- **What a worker cost:** a card now reports its time and, when its backend says so, the tokens it spent, instead of a bare "ok".
- **Subagents:** the number of parallel `task` agents is now bounded (3 by default, `maxParallelSubagents` in `config.json`), and two of them never work on the same file: a task declares its files and waits for them. A subagent that fails before doing anything is retried once instead of losing the delegated work.
- **CLI sessions:** a profile with `--continue` keeps the conversation inside the CLI, so the next turn sends only the new request instead of the whole briefing. The record is per profile and workspace; if the CLI lost its session the turn is repeated with the full briefing, so nothing breaks after an update.
- **Squadra CLI:** the plan is shown and must be approved before any worker process starts, and each worker's text now streams into its own card instead of leaving it on "in corso".
- **Permissions:** the prompt names the subagent that asked, so three workers writing at once are no longer indistinguishable.
- **Earlier fixes in this line:** context always keeps the last request, tool sandbox for paths and symlinks, atomic config writes, cached catalog and throttled draft saves.

## What is in this build

- Streaming with retry, mid-stream fallback, and a catalog that hides providers with no key
- Tools: read, ls, glob, grep, write, edit, bash, task — each with per-tool permissions and command auto-approve
- `fetch_url` for reading documentation and pages as clean text, with SSRF protection
- Subagents, plan/build modes, per-model effort levels
- Diff viewer, JSONL sessions with a context sidecar, `AGENTS.md` layering
- Plugins on by default: project memory, setup advisor, web reach
- Skills: `SKILL.md` packages, installable from a git URL, loaded on demand
- The mascot: Charlie walks, thinks, sits at his PC — and while subagents run he stands up and cracks a whip at four very different workers

## Notes

- Keys live in `~/.charliecode/credentials.json` (mode `600`) or environment variables.
- Third-party plugins and an MCP client are not in this build; they need a sandbox and a per-tool permission model first.
