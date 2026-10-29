# CLI reference

```
-m, --mode <mode>     solo | council | debate | gut-check (saved default if omitted)
    --format json     Consult only: one JSON receipt on stdout, even on failure
-q, --question <q>    The question (or pass it positionally)
    --isolate         Skip project instructions in supported Codex/Claude presets; not a filesystem sandbox
    --no-stdin        Don't wait for piped input (for harnesses that keep stdin open)
-f, --file <path>     Attach a text file as context (repeatable)
    --image <path>    Attach an image (repeatable; codex, anthropic)
-b, --backend <name>  Force one backend (also: tmux | pty | interactive | sdk:provider:model@effort)
    --backends <a,b>  Council: one backend per persona, in order
    --synthesizer <s> Council/Debate verdict backend[:model][@effort]
    --advocate <s>   Debate advocate backend[:model][@effort]
    --critic <s>     Debate critic backend[:model][@effort]
    --model <id>      Override the shared Solo model
    --effort <level>  Reasoning effort (codex, claude, sdk routes); ignored elsewhere
    --rounds <n>      Debate rounds, 1-4 (default: 2)
    --timeout <ms>    Per-call timeout (default: 120000)
-c, --config <path>   Config file (default: ~/.bpx-council.json)
```

Also: `bpx-council config` (settings workbench), `bpx-council setup`
(config + agent wiring), `bpx-council install` / `uninstall`
([agent integration](agent-integration.md)), `bpx-council doctor`
(below), `--version`.

## Modes

- **Solo** (default) — one strong second opinion. Usually seconds; a
  deep-thinking model at high effort can take longer.
- **Council** — three personas in parallel, then a synthesized verdict.
  Takes a few minutes, because it's running several models against each
  other. That's the point.
- **Debate** — advocate vs critic over sequential rounds, then a verdict.
- **Gut check** — terse. "Does this smell off?"

Without `--mode`, the saved `defaultMode` runs; an explicit `--mode solo`
still forces Solo. Progress goes to stderr, so `> out.md` still captures
clean output. If synthesis fails after Council members answer, their verdicts
still print, but the CLI exits nonzero; no verdict is claimed.

## Backend resolution

An explicit choice — `--backend` flag or saved config — wins. Otherwise, in
order: `ANTHROPIC_API_KEY` env var, Codex CLI on PATH, Claude CLI on PATH.
If none is available, an error before any call. See
[Backends and providers](providers.md#route-types) for the full route zoo.

## JSON receipts

`--format json` emits one schemaVersion 1 object with an invocation UUID,
resolved mode (or `null`), status (`complete`, `partial`, `failed`), advice,
error, ordered seat attempts, planned seats, skipped (`notRun`) seats, and
usage coverage. Each attempt records selected route, label, pinned
model/effort, round, outcome, and provider-reported tokens when available.
`usage.attempted/reported/unknown` count calls, never skipped seats.
Input/output totals are `null` until a call reports them; Anthropic cache
creation/read tokens stay separate with per-field report counts. CLI usage
stays unknown. Council can return `partial` with exit code 0 when synthesis
succeeds despite a failed member; incomplete verdicts keep nonzero exit codes
and salvage completed answers. Progress stays on stderr. Config, setup, and
install do not accept JSON mode.

## Doctor

`bpx-council doctor` checks config and effective Solo, Gut-check, Council and
Debate routes without running an advisor, fetching models, or testing login.
It reports whether a binary exists or an API key is present; neither proves
that the account works. Invalid project config and trust restrictions fail
with a diagnostic before any call.

```bash
bpx-council doctor                    # offline, no model call
bpx-council doctor --config ./my.json # inspect a trusted config, no discovery
bpx-council doctor --probe            # explicit ONE-call Solo smoke test
```

`--probe` prints selected route and possible charge *before* calling. It uses
a fixed tiny prompt and prints only success/failure, never the reply. Bounds
by route type: CLI routes get a 20-second deadline and 8 KiB stdout cap
(deep-thinking models can take 7–11s even for a trivial reply, so 10s made
the probe a coin flip on healthy routes); Anthropic HTTP gets 10 seconds and
32 output tokens; guarded SDK routes get 10 seconds and an 8 KiB byte cap.
Read-only Codex, tool-disabled Claude, the standard Anthropic HTTP endpoint
and guarded SDK routes are probed; tmux, custom commands/args, custom
endpoints and unimplemented HTTP providers are refused. Configured image
paths are not sent. The probe runs the Solo route only; it cannot fan out
into Council or Debate. A parseable reply doesn't independently verify login
or model selection. Offline diagnostics exit nonzero for unavailable routes.
Other consult/install/config flags are not accepted by `doctor`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables the Anthropic HTTP route in auto-detection; used by that route when called |
| `BPX_COUNCIL_MODEL` / `ANTHROPIC_MODEL` | Default model override for `--model` |
| `NO_UPDATE_NOTIFIER=1` | Silences the once-a-day update notice |
| `BPX_COUNCIL_FORCE_KILL_MS` | SIGTERM→SIGKILL grace for CLI advisor children (250–10000, default 1000); for loaded machines |
