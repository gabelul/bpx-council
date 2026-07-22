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

Two models, two genuinely different instincts — one optimises the pipeline, the
other rejects the question. That's the part you can't get from one model asked
three times.

**[Full transcript →](docs/examples/council-three-models.md)** (including the
third member dying mid-run, and the council shipping without it.)

## Install

Runs on a model CLI you probably already have. **No API key** — if you're signed
into `codex` or `claude`, it works with zero config.

```bash
npx @booplex/bpx-council "Is this auth flow sane?"
```

No CLI on your PATH? Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` and it goes
direct over HTTP instead. Once you like it:

```bash
npm install -g @booplex/bpx-council
bpx-council install     # teach your coding agent it exists — see below
```

The `install` step is deliberately separate — nothing writes into your editor
config on an `npm install`. If you skip it, the first time you run `bpx-council`
in a real terminal it'll offer to set that up for you, once.

## Updating

```bash
npm install -g @booplex/bpx-council@latest   # get the newest version
bpx-council install                          # re-run to refresh the agent files
```

Two steps on purpose. Updating the npm package **doesn't** touch your agent
files — nothing writes into `~/.claude` or `AGENTS.md` behind your back on an
`npm install`. Re-run `bpx-council install` to pull in new or changed skills; it's
idempotent, so running it again is safe.

`bpx-council --version` shows what you've got. The CLI also checks for a newer
version at most once a day and prints a one-line notice on **stderr** (so it
never touches piped output). Silence it with `NO_UPDATE_NOTIFIER=1`; it's already
quiet in CI and when output isn't a terminal.

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

Solo and gut-check return in seconds. Council and debate take a few minutes —
they're running several models against each other, which is the point. Progress
goes to stderr, so `> out.md` still captures clean output.

## Going multi-model

Council runs three personas — architect (for), critic (against), simplifier
(neutral). By default they all share one backend: three stances, one model.
Useful and cheap, but it isn't multi-model.

Assign different backends and it is:

```bash
bpx-council --mode council --backends codex,claude "Should we ship this?"
```

Backends map to personas in order. Fewer names than personas is fine — the rest
use the default. Each verdict is labelled with the model that produced it, so
you can see who argued what.

Or set it once in `~/.bpx-council.json`:

```json
{
  "defaultMode": "solo",
  "council": {
    "backends": { "architect": "codex", "critic": "claude" }
  }
}
```

**Backend support:** `codex` and `claude` are verified working. `opencode` is
wired up but currently unverified — its CLI returns a server error in testing.
HTTP backends (`anthropic`, `openai`, `google`) need the matching `*_API_KEY`.

## Wiring it into your agent

Installing the CLI teaches *you* that the council exists. It teaches your agent
nothing — agents discover what they can do from files in their own config tree.
So there's a command that puts those files there:

```bash
bpx-council install
```

It checks which agents are actually on your machine, asks what to wire up and
whether you want it for this project or globally, shows you the plan, and waits
for a yes before writing anything.

| Agent | What it gets | Where |
|---|---|---|
| Claude Code | Skill (auto-triggers on "second opinion", "council", "gut check"), `/council` command, optional Stop hook | `.claude/` or `~/.claude/` |
| Codex | Same skill, same format | `~/.codex/skills/` (global) |
| Cursor, Codex, Gemini CLI, Copilot, OpenCode, Zed, … | Same skill via the shared `.agents/skills/` convention — one copy, read by the whole cluster | `.agents/skills/` (project) |
| Anything that reads `AGENTS.md` | Instruction block | project root |
| pi | [bpx-consult](https://github.com/gabelul/bpx-mono/tree/main/packages/bpx-consult) — deeper: auto-triggers, steer, interactive menu | — |

`.agents/skills/` is an emerging cross-agent convention (it's the shared project
path in [vercel-labs/skills](https://github.com/vercel-labs/skills)' agent
table). One skill copy there reaches a whole cluster instead of one agent. The
list above is that convention, not a per-agent guarantee — if your agent doesn't
pick it up, the `AGENTS.md` block is the universal fallback.

Two of those destinations are files you already own. `settings.json` gets a
structural merge and `AGENTS.md` gets a marker-delimited block, so your existing
hooks and house rules survive, and re-running updates in place instead of
stacking duplicates. If either file is in a shape it doesn't recognise —
unparseable JSON, a half-deleted block — it refuses and tells you, rather than
guessing which text was yours. The skill and command files *are* replaced on
reinstall; the plan marks those `[overwrite]` first.

Headless, for dotfiles and CI:

```bash
bpx-council install --dry-run                              # show the plan, write nothing
bpx-council install --agent claude-code --scope global -y
bpx-council install --with-hook                            # + gut-check after every turn
bpx-council install --link                                 # one canonical copy, symlinked
```

**Link mode (`--link`).** By default each agent gets its own copy of the skill.
With `--link`, one canonical copy lives at `.agents/skills/bpx-council` and every
agent's skill dir is a symlink to it — edit once, they all see it. It's the same
scheme [vercel-labs/skills](https://github.com/vercel-labs/skills) uses. Copy is
the default because symlinks are fragile across Windows, committed git trees, and
Docker builds; on Windows link mode uses a junction, and any link that can't be
made falls back to a copy automatically. An agent dir you've *edited* is never
replaced by a link — it's left alone with a note.

One caveat: a reinstall re-syncs the canonical copy from the bundled template, so
hand-edits to `.agents/skills/bpx-council` itself don't survive an upgrade. It's
a distribution point, not a place to fork the skill.

The Stop hook is opt-in because it fires a council call on every turn, and
that's a model call every turn. Worth it sometimes, not by default.

Everything's a CLI underneath, so if your agent isn't on that list it can still
just run `bpx-council` in a shell. The templates live in `templates/` if you'd
rather place them yourself.

## Options

```
-m, --mode <mode>     solo (default) | council | debate | gut-check
-q, --question <q>    The question (or pass it positionally)
-b, --backend <name>  Force one backend for everything
    --backends <a,b>  Council: one backend per persona, in order
    --model <id>      Override the model (HTTP backends)
    --rounds <n>      Debate rounds, 1-4 (default: 2)
    --timeout <ms>    Per-call timeout (default: 120000)
-c, --config <path>   Config file (default: ~/.bpx-council.json)
```

Resolution order for backends: `--backend` → config → `*_API_KEY` env vars →
CLIs on your PATH → `codex`.

## Related

- **[slopbuster](https://github.com/gabelul/slopbuster)** — strips the AI tells out of prose and code
- **[stitch-kit](https://github.com/gabelul/stitch-kit)** — teaches your agent the full design-to-code pipeline
- **[pixelslop](https://github.com/gabelul/pixelslop)** — opens your page in a real browser and measures the design

---

Built by Gabi @ [Booplex.com](https://booplex.com). MIT license.
