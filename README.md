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
```

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

It's a CLI, so anything that runs shell commands can call it. For tighter
integration there are templates in `templates/`:

| Agent | What you get | Template |
|---|---|---|
| Claude Code | Skill (trigger words), slash command, Stop hook | `templates/claude-code/` |
| Codex | `SKILL.md` auto-activation | `templates/codex/` |
| Cursor / Copilot / Aider | Instruction snippet | `templates/agents-md/` |
| pi | [bpx-consult](https://github.com/gabelul/bpx-mono/tree/main/packages/bpx-consult) — deeper: auto-triggers, steer, interactive menu |

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
