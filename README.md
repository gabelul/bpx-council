# bpx-council

Multi-model second opinions for coding agents.

Your agent runs on a fast, cheap model most of the time — right, most of the
time. The exceptions are the handful of calls that decide how the thing turns
out: the architecture, the "should I even build this," the bug it's been
circling for an hour. `bpx-council` puts a stronger model on those. Or three
different ones, arguing.

## What it looks like

Real output, unedited. One question, three models, each with a stance:

```bash
bpx-council --mode council --backends codex,claude,opencode \
  "Our test suite takes 40 minutes and it's blocking deploys. Parallelize
   across more CI runners, or delete slow integration tests we suspect
   are redundant?"
```

```
── council: architect→codex, critic→claude, simplifier→opencode
```

> ### architect [for] · codex
> Parallelize the suite across more CI runners now. Do not delete
> suspected-redundant integration tests as the primary fix. A 40-minute deploy
> gate is an infrastructure throughput problem first. […] Split tests into
> deterministic shards using historical timing, targeting 8–12 minutes per
> shard. Balance by measured duration, not test count.
>
> ### critic [against] · claude
> **Parallelization is a treadmill with a floor you haven't measured.**
> Amdahl's law eats this alive. If one integration test file takes 11 minutes,
> sharding across 20 runners gets you an 11-minute suite, not a 2-minute one.
> […] "We suspect are redundant" is not evidence, and the failure mode is
> invisible. Delete a test, ship for six months, eat a production incident —
> nobody ever traces that back to the deletion.
>
> **Both proposals are answers to "make the number smaller." Neither is an
> answer to "stop the number from gating deploys."**
>
> ### Verdict
> Don't delete suspected-redundant integration tests, and don't make runner
> sharding the first move. […] My call: **take the critic's pipeline change
> first, then selectively optimize and shard.**

Two models, two genuinely different instincts. One optimises the pipeline, the
other rejects the question. That's the part you can't get from one model asked
three times.

**[Full transcript →](docs/examples/council-three-models.md)** (including the
third member dying mid-run, and the council shipping without it.)

## Install

Signed into Codex or Claude CLI? Both can run without an API key. Codex runs
in a read-only sandbox but can still read project files; Claude's preset disables
tools. Anthropic HTTP works with `ANTHROPIC_API_KEY`. Other agent CLIs aren't
auto-selected: choose one explicitly only if you trust its local configuration.

```bash
npx @booplex/bpx-council "Is this auth flow sane?"
```

No CLI on your PATH? `ANTHROPIC_API_KEY` enables Anthropic HTTP. OpenAI HTTP
isn't implemented yet; `OPENAI_API_KEY` alone won't select it. Once you like it:

```bash
npm install -g @booplex/bpx-council
bpx-council install     # teach your coding agent it exists (see below)
```

The `install` step is deliberately separate, because nothing should write into
your editor config on an `npm install`. If you skip it, the first time you run `bpx-council`
in a real terminal it'll offer to set that up for you, once.

## Modes

```bash
# Solo — one strong second opinion (default). Seconds.
bpx-council "Is this auth flow sane?"

# Pipe in context
git diff HEAD~3 | bpx-council --question "Review this diff for correctness"

# Council — three personas in parallel, then a synthesized verdict
bpx-council --mode council "Architecture: monolith or microservices?"

# Debate — advocate vs critic over sequential rounds, then a verdict
bpx-council --mode debate --rounds 2 "Rewrite the parser, or patch it?"

# Gut check — terse. "Does this smell off?"
bpx-council --mode gut-check "We're storing sessions in localStorage"
```

Solo and gut-check return in seconds. Council and debate take a few minutes,
because they're running several models against each other. That's the point.
Progress goes to stderr, so `> out.md` still captures clean output.

## Going multi-model

Council runs three personas: architect (for), critic (against), simplifier
(neutral). By default they all share one backend, so you get three stances from
one model. Useful and cheap, but it isn't multi-model.

Assign different backends and it is:

```bash
bpx-council --mode council --backends codex,claude "Should we ship this?"
```

Backends map to personas in roster order. Fewer specs than members is fine; extra
specs fail before any call. For each member, precedence is positional `--backends`,
then saved `council.backends` by persona name, then Solo. Each verdict is labelled
with its persona and model, so you can see who argued what.

Pin a model per persona with `backend:model`:

```bash
bpx-council --mode council \
  --backends codex:gpt-5.6-sol,anthropic:claude-opus-4-8,claude \
  "Should we ship this?"
```

The synthesizer can use a fourth backend. Debate's advocate, critic and
synthesizer can each have their own too:

```bash
bpx-council --mode council --backends codex,claude,opencode \
  --synthesizer codex:gpt-5.6-sol "Should we ship this?"
bpx-council --mode debate --advocate codex:gpt-5.6-sol \
  --critic claude:opus --synthesizer codex "Rewrite or patch?"
```

Or save the choices in `~/.bpx-council.json`, by hand or through the wizard:

```json
{
  "defaultMode": "debate",
  "council": {
    "backends": { "architect": "codex:gpt-5.6-sol", "critic": "anthropic:claude-opus-4-8" },
    "synthesizer": "codex:gpt-5.6-sol"
  },
  "debate": {
    "advocate": "codex:gpt-5.6-sol",
    "critic": "claude:opus",
    "synthesizer": "codex"
  }
}
```

Council's default roster stays architect, critic, simplifier. To change it, edit
trusted global config (or an explicit trusted `--config` file):

```json
{
  "personas": {
    "reviewer": { "stance": "against", "systemPrompt": "Review deployment risks. Name specific failure modes." }
  },
  "council": {
    "members": ["architect", "reviewer"],
    "backends": { "reviewer": "claude" }
  },
  "gutCheck": { "backend": "anthropic:claude-opus-4-8", "maxOutputTokens": 96 }
}
```

`personas` defines or replaces named prompts (stance: `for`, `against`, or
`neutral`); definitions merge by name across trusted layers. `council.members`
is an ordered, atomic list (1–8 unique safe names). Prompts must be nonblank
and at most 8,000 characters. Define up to 16 persona entries. Gut-check
uses explicit `--backend` first, then `gutCheck.backend`, then Solo; `null`
resets it to Solo. `maxOutputTokens` (1–4096) sets Anthropic HTTP `max_tokens`.
For a CLI route, it's only a prompt request, not a hard limit or billing cap.
Findings are never cut after generation. The wizard preserves these advanced
fields but doesn't edit them; use the JSON file.

Each seat uses its explicit flag, then its saved spec, then the shared Solo
backend. `--backend` and `--model` change that fallback, not pinned seats.
Omit a seat to inherit Solo; in a project config, use `null` to reset a seat
assigned globally. The wizard accepts `keep` for no change and `inherit` to
reset a seat to Solo. Without `--mode`, the saved `defaultMode` runs; an
explicit `--mode solo` still forces Solo. If synthesis fails after Council
members answer, their verdicts still print, but the CLI exits nonzero; no
verdict is claimed.

## Steering the advisor

Four things you can change about who answers and how: the backend, its model,
how hard it thinks, and what you hand it.

### Backend and model

Which tool answers, and which model it runs.

```bash
# Use codex as the advisor (its own configured model)
bpx-council --backend codex "Is this auth flow sane?"

# ...on a specific model — passed straight to codex's --model
bpx-council --backend codex --model gpt-5.6-sol "Is this auth flow sane?"

# claude CLI on Opus
bpx-council --backend claude --model claude-opus-4-8 "..."

# Anthropic over HTTP (needs ANTHROPIC_API_KEY), explicit model
bpx-council --backend anthropic --model claude-opus-4-8 "..."
```

`--model` works for both kinds: HTTP backends target that model directly, and
CLI backends get it injected as their own model flag, in whatever position that
particular tool wants it. Leave it off and the CLI uses whatever it's already
configured for, which is usually what you want, since it tracks its own latest
without you maintaining a version string. `--model` also reads
`BPX_COUNCIL_MODEL` / `ANTHROPIC_MODEL` from the env.

### How hard it thinks

Some backends expose a reasoning-effort dial. `--effort` sets it:

```bash
bpx-council --backend codex --effort max "Is this migration plan sound?"
bpx-council --backend claude --effort low "Quick sanity check on this regex"
```

Pin it per backend with `@level`. That's where the council gets interesting:
different stances at different depths.

```bash
bpx-council --mode council \
  --backends codex:gpt-5.6-sol@max,claude@high,codex:gpt-5.4-mini@low \
  "Rewrite the parser, or patch it?"
```

An expensive architect, a cheap simplifier. Same idea as assigning models, one
level down.

**Which levels are valid depends on the backend, and for codex on the model.**
`gpt-5.6-sol` accepts up to `ultra`, while `gpt-5.5` stops at `xhigh`. The wizard asks
codex what the model you picked actually supports and offers exactly those, so
you can't pick one it would reject.

| Backend | Effort control |
|---|---|
| `codex` | ✓ per-model levels, read live from its catalog |
| `claude` | ✓ low, medium, high, xhigh, max |
| everything else | ignored; no such control, so nothing is passed |

Set a fallback for every run in the config as `solo.thinkingLevel`; a backend
that pins its own with `@level` keeps it, since that's the more specific choice.
Backends without an effort dial ignore it rather than being handed a flag
they'd reject.

### Staying independent of your project

Both codex and claude read the repo's `AGENTS.md` / `CLAUDE.md` before
answering. So a second opinion asked inside a project shows up already following
that project's house rules, which is some of the bias you were trying to escape
by asking someone else.

`--isolate` changes how supported presets load project instructions; it does not prevent a CLI from reading files:

```bash
bpx-council --isolate "Is this auth flow actually sane, or are we just used to it?"
```

Tested by planting an instruction ("begin every reply with BANANA") in a repo's
`AGENTS.md`. codex obeyed it, and stopped once `--isolate` was passed.

| Backend | What `--isolate` does |
|---|---|
| `codex` | sets `project_doc_max_bytes=0` to skip project `AGENTS.md`; it keeps the project working directory and can still read its files |
| `claude` | drops the project `CLAUDE.md` from the preset's instruction path; user-global instructions may still apply |
| everything else | no isolation guarantee; some CLIs may read project config |

One honest limit: for claude this drops the project `CLAUDE.md` but **not** your
user-global `~/.claude/CLAUDE.md`, which survives a system-prompt override.
There's a `--bare` flag that drops both, except it also forces authentication
through `ANTHROPIC_API_KEY` and never reads your OAuth login, which breaks the
no-API-key setup this whole tool is built around. Not worth it as a default.

It's opt-in, so nothing changes for existing setups, and an advisor that knows
your conventions is genuinely useful sometimes. Reach for `--isolate` when you
want the outside view.

### Files and images

Piping works for one blob of context (up to 1MB). It waits for EOF, then fails
if the pipe stays open past three seconds, even if no bytes arrived. Use
`--no-stdin` when a calling harness keeps stdin open.
`--file` is better when there's more than one, and it labels each by name:

```bash
bpx-council --file src/auth.ts --file tests/auth.test.ts \
  "Does the test actually cover the bug the code has?"
```

Files are read and folded into the prompt, so **every backend supports this**.
No special handling needed. Each file is fenced and labelled, and told plainly
if it was truncated (256KB per file, 512KB total, at most 16 files) so the model doesn't reason
about a function whose ending it never saw.

Images are different, because a picture can't be folded into text. The backend
has to actually take one:

```bash
bpx-council --backend codex --image mock.png "Does this layout look off?"
```

| Backend | Images | How |
|---|---|---|
| `codex` | ✓ | attached directly (`-i`), several at once |
| `anthropic` | ✓ | inlined into the request as base64 |
| `claude` | ✗ | tools are disabled; no verified direct image transport |
| everything else | ✗ | refuses with a message naming the ones that work |

Images must be regular, non-symlink files with matching magic bytes (four max,
5MB each, 20MB combined). Anthropic HTTP gets the validated bytes frozen before
the call. Codex CLI gets a validated **path**, not frozen bytes: another process
could replace its contents before Codex opens it. Use Anthropic HTTP when that
race matters. With `--image`, Council and Debate check each seat's image
transport before any call. Image paths in config are rejected; pass them with
`--image` so the CLI validates each file and freezes bytes for Anthropic HTTP.

For Codex, a pinned model that its catalog marks text-only triggers a warning
before a call, including Council and Debate seats. An unknown catalog result
isn't treated as proof of image support.

Bad paths, directories, binary files passed to `--file`, and unsupported image
types all fail immediately, before any model call rather than two minutes into a
council run.

### Driving an interactive agent instead

There's a third backend type beyond CLI and HTTP: `tmux` (also `pty` or
`interactive`), which drives an agent running in a real terminal session rather
than spawning a fresh headless one.

```bash
bpx-council --backend tmux "Is this auth flow sane?"
```

It needs `tmux` installed. Useful when you want the advisor to be a session
that's already warmed up and authenticated instead of a cold subprocess, and it
was the original route before the headless flags on codex and claude turned out
to be good enough. Most people want a plain CLI backend; this is here for the
cases where you don't.

## Configuring

You don't have to touch the JSON. `bpx-council config` walks you through it with
arrow-key pickers, and where a backend can list its own models (codex, opencode,
crush, cursor-agent, anthropic) a type-to-filter picker so you're choosing from
the real list instead of typing a name from memory and hoping. Where it can
report reasoning levels too, you get those, for the model you just picked. It
finds your backends, then writes `~/.bpx-council.json`:

```bash
bpx-council config          # interactive
bpx-council config --dry-run
bpx-council config --backend codex --model gpt-5.6-sol --mode solo --yes   # headless
```

It merges into any existing config (your hand-set keys survive), and refuses
rather than clobber a config it can't parse. Its Council setup includes the
synthesizer; choosing Debate as default offers separate advocate, critic and
synthesizer routes. Headless `config --yes` leaves saved seats, roster, persona
prompts, gut-check settings, and backend-specific options alone. There's also a one-command
onboarding that does both this and the agent wiring:

```bash
bpx-council setup           # configure the advisor, then offer to wire into your agents
```

### Global vs per-project

By default config is **global** (`~/.bpx-council.json`), one setup for your whole
machine. But a repo can carry its own:

```bash
bpx-council config --scope project    # writes .bpx-council.json at the repo root
```

At runtime the layers stack: **defaults → global → the repo's `.bpx-council.json`**,
with the project file overriding only the keys it sets. So a project config of
just

```json
{ "solo": { "backend": { "type": "http", "provider": "anthropic", "model": "claude-opus-4-8" } } }
```

means "this repo uses Opus, everything else stays my usual." Discovery walks up
from your working directory to the git root, so it works from any subdirectory.

You can **commit `.bpx-council.json`** for shared mode and routes, but a repo
isn't a trusted source of executable instructions. Auto-discovered project files
can select Anthropic HTTP and its model; Council/Debate seats use Anthropic
routes or `null` to inherit Solo. They cannot choose CLI commands (even Codex:
its read-only sandbox still permits shell reads), tmux, HTTP URL or API-key
variable. They may reorder or select bundled Council personas, but cannot
supply persona prompts or select trusted custom personas. Project gut-check routes
follow the same Anthropic-only rule; output-token preference is allowed.
An invalid file fails with its path and key before any model call. Need a custom
command or URL? Put it in your own global config or pass an explicit trusted
`--config <path>`; either overrides/escapes project restrictions. Don't pass a
repo-controlled file explicitly as a shortcut around this check.

Existing repo `.bpx-council.json` files with CLI/tmux routes, custom URLs, or
persona prompts now fail validation. Move those choices to your global config
or a trusted file passed with `--config`; keep the repo file within the
Anthropic-only rules above. Configured image paths also fail; pass them with
`--image`. Run `bpx-council doctor` to check routes without paying for a call.

## Wiring it into your agent

Installing the CLI teaches *you* that the council exists. It teaches your agent
nothing, because agents discover what they can do from files in their own config
tree.
So there's a command that puts those files there:

```bash
bpx-council install
```

It checks which agents are actually on your machine, asks what to wire up and
whether you want it for this project or globally, shows you the plan, and waits
for a yes before writing anything.

| Agent | What it gets | Where |
|---|---|---|
| Claude Code | Skill and `/council` command | `.claude/` (project) or `~/.claude/` (global) |
| Codex | Skill | `.agents/skills/` (project) or `~/.agents/skills/` (global) |
| OpenCode | Skill and `/council` command | `.opencode/` (project) or `~/.config/opencode/` (global) |
| Shared skill (manual choice only) | Compatibility copy for hosts that read project `.agents/skills/` | `.agents/skills/` |
| Agents reading `AGENTS.md` | Instruction block | project root |

The shared option is never auto-detected. Select it explicitly if your host
reads that path. Choosing it with Codex writes one skill, not two; choosing it (or Codex)
with OpenCode keeps OpenCode's command but avoids a duplicate project skill.
Older global
Codex installs at `~/.codex/skills/bpx-council` are reported, not migrated or
removed. `AGENTS.md` uses a marker-delimited block; malformed markers are
refused rather than guessed at. Reinstall refreshes known files, but refuses
skill directories with extra entries or foreign symlinks instead of claiming
success. Clear drift manually; `[blocked]` in the plan names affected paths.

Headless, for dotfiles and CI:

```bash
bpx-council install --dry-run                              # show the plan, write nothing
bpx-council install --agent claude-code --scope global -y
bpx-council install --link                                 # one canonical copy, symlinked
bpx-council install --verify --agent claude-code            # offline artifact check
bpx-council uninstall --agent claude-code --dry-run         # inspect removal
bpx-council uninstall --agent claude-code --yes             # remove exact owned files
```

**Link mode (`--link`).** By default each agent gets its own copy of the skill.
With `--link`, one canonical copy lives at `.agents/skills/bpx-council`;
hosts needing a separate skill path link to it. Codex uses the canonical copy
directly, and OpenCode can discover that shared copy without a second skill. It's the same
scheme [vercel-labs/skills](https://github.com/vercel-labs/skills) uses. Copy is
the default because symlinks are fragile across Windows, committed git trees, and
Docker builds; on Windows link mode uses a junction, and any link that can't be
made falls back to a copy automatically. An agent dir you've *edited* is never
replaced by a link. It's left alone with a note.

One caveat: reinstall refreshes known files at the canonical path. Extra
entries or links block reinstall, and `--verify` reports edited content as
`drifted`. Treat the canonical copy as a distribution point, not a fork.

`--with-hook` now fails without writing: an every-Stop paid consult was too easy
to trigger without a deliberate question. Existing hooks aren't removed by
install. `uninstall` removes only an exact bundled legacy Stop entry, leaving
unrelated hooks and settings alone. Edited or malformed entries are refused.

`uninstall` uses the same agent and scope selection. Dry-run never prompts;
noninteractive mutation needs `--yes`. It removes only template-identical files
and skill trees with no extras, or links to the canonical copy. Marker blocks
must match the current or bundled legacy text exactly. Edited artifacts stay
put and produce a nonzero result; other owned artifacts can still be removed.
A link-only uninstall leaves the real `.agents/skills` copy in place, since
Codex or another host may use it without a link. When it is the last link,
the command exits nonzero and names the retained copy; explicitly select
`codex` or `agents-skills` to remove it. `--verify` reports missing, drifted,
or current per selected host without authentication or a model call; binary
availability isn't checked.

This integration installs instructions and commands; it doesn't add native host
execution or host-harness cost tracking. Consult receipts report provider usage
where available, with unknown CLI usage marked unknown. If your agent isn't on
the list, it can still run `bpx-council` in a shell. The templates live in `templates/` if you'd
rather place them yourself.

## Backend support

The automatic routes are Anthropic HTTP (when `ANTHROPIC_API_KEY` is set),
then Codex CLI, then Claude CLI. Codex uses a read-only sandbox, which still
allows project-file reads; Claude's preset disables tools. OpenCode's explicit
CLI route runs with tools denied and accepts only its JSON event output. Other
CLI commands require a trusted global or explicit config. A custom command's
permissions and output format are yours to check, not something the name
`bpx-council` magically fixes.

Only Anthropic HTTP is implemented. OpenAI and Google HTTP config values fail
before any request; use a supported CLI or Anthropic route instead. The
Anthropic default model is `claude-opus-4-8`. Earlier backend probes used
older presets, so they don't establish that these revised routes are logged in
or working on your machine. `doctor` checks availability without a model call;
`doctor --probe` makes one explicitly requested smoke call. Authenticated
multi-seat runs still need checking in the target environment.

## Doctor

`bpx-council doctor` checks config and effective Solo, Gut-check, Council and
Debate routes without running an advisor, fetching models, or testing login.
It reports whether a binary exists or an API key is present; neither proves
that the account works. Invalid project config and trust restrictions fail with
a diagnostic before any call.

```bash
bpx-council doctor                    # offline, no model call
bpx-council doctor --config ./my.json # inspect a trusted config, no discovery
bpx-council doctor --probe            # explicit ONE-call Solo smoke test
```

`--probe` prints selected route and possible charge *before* calling. It uses a
fixed tiny prompt, 10-second deadline, 8 KiB CLI stdout cap or 32 Anthropic
HTTP output tokens, and prints only success/failure, never the reply. It cannot
fan out into Council or Debate. Only read-only Codex, tool-disabled Claude,
and the standard Anthropic HTTP endpoint are probed; tmux, custom commands/args,
custom endpoints and unimplemented HTTP providers are refused. Configured
image paths are not sent. A parseable reply doesn't independently verify login
or model selection. Offline diagnostics exit nonzero for unavailable routes.
Other consult/install/config flags are not accepted by `doctor`.

## Options

```
-m, --mode <mode>     solo | council | debate | gut-check (saved default if omitted)
    --format json     Consult only: one JSON receipt on stdout, even on failure
-q, --question <q>    The question (or pass it positionally)
    --isolate         Skip project instructions in supported Codex/Claude presets; not a filesystem sandbox
    --no-stdin        Don't wait for piped input (for harnesses that keep stdin open)
-f, --file <path>     Attach a text file as context (repeatable)
    --image <path>    Attach an image (repeatable; codex, anthropic)
-b, --backend <name>  Force one backend (also: tmux | pty | interactive)
    --backends <a,b>  Council: one backend per persona, in order
    --synthesizer <s> Council/Debate verdict backend[:model][@effort]
    --advocate <s>   Debate advocate backend[:model][@effort]
    --critic <s>     Debate critic backend[:model][@effort]
    --model <id>      Override the shared Solo model
    --effort <level>  Reasoning effort (codex, claude); ignored elsewhere
    --rounds <n>      Debate rounds, 1-4 (default: 2)
    --timeout <ms>    Per-call timeout (default: 120000)
-c, --config <path>   Config file (default: ~/.bpx-council.json)
```

Resolution order for backends: `--backend` → config → `*_API_KEY` env vars →
Codex or Claude CLI on your PATH → error if neither is available.

`--format json` emits one schemaVersion 1 object with an invocation UUID, resolved
mode (or `null`), status (`complete`, `partial`, `failed`), advice, error, ordered
seat attempts, planned seats, skipped (`notRun`) seats, and usage coverage.
Each attempt records selected route, label, pinned model/effort, round, outcome,
and provider-reported tokens when available. `usage.attempted/reported/unknown`
count calls, never skipped seats. Input/output totals are `null` until a call
reports them; Anthropic cache creation/read tokens stay separate with per-field
report counts. CLI usage stays unknown. Council can return `partial` with exit
code 0 when synthesis succeeds despite a failed member; incomplete verdicts keep
nonzero exit codes and salvage completed answers. Progress stays on stderr. Config,
setup, and install do not accept JSON mode.

## Updating

```bash
npm install -g @booplex/bpx-council@latest   # get the newest version
bpx-council install                          # re-run to refresh the agent files
```

Two steps on purpose. Updating the npm package **doesn't** touch your agent
files. Nothing writes into `~/.claude` or `AGENTS.md` behind your back on an
`npm install`. Re-run `bpx-council install` to pull in new or changed skills; it's
idempotent for known, unedited files; it refuses drift rather than overwriting
it. This does **not** migrate an older Codex skill at
`~/.codex/skills/bpx-council`. The installer reports that path but creates the
new skill under `~/.agents/skills/bpx-council`. Check which one your host reads
before removing the old copy yourself; `uninstall` won't remove that legacy path.

`bpx-council --version` shows what you've got. The CLI also checks for a newer
version at most once a day and prints a one-line notice on **stderr** (so it
never touches piped output). Silence it with `NO_UPDATE_NOTIFIER=1`; it's already
quiet in CI and when output isn't a terminal.

## Related

- **[slopbuster](https://github.com/gabelul/slopbuster)** — strips the AI tells out of prose and code
- **[stitch-kit](https://github.com/gabelul/stitch-kit)** — teaches your agent the full design-to-code pipeline
- **[pixelslop](https://github.com/gabelul/pixelslop)** — opens your page in a real browser and measures the design

---

Built by Gabi @ [Booplex.com](https://booplex.com). MIT license.
