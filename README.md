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

Requires Node 22.19+. Signed into Codex or Claude CLI? Both can run without an
API key. No CLI at all? Configure a direct provider account instead.

```bash
npx @booplex/bpx-council "Is this auth flow sane?"   # try it
npm install -g @booplex/bpx-council                   # keep it
bpx-council install                                   # teach your agent it exists
```

The `install` step is deliberately separate, because nothing should write into
your editor config on an `npm install`.

## Modes

```bash
# Solo — one strong second opinion (default). Usually seconds.
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

Solo and gut-check usually return in seconds (a deep-thinking model at high
effort can take longer). Council and debate take a few minutes, because
they're running several models against each other. That's the point.

Going multi-model is one flag: `--backends codex,claude,opencode` maps
backends to personas in order, `backend:model@effort` pins a model and
reasoning depth per seat. Progress goes to stderr, so `> out.md` still
captures clean output.

## Documentation

| Document | What's in it |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, first consult, keeping it updated |
| [Backends and providers](docs/providers.md) | CLI presets, Anthropic HTTP, direct SDK providers, accounts, shared pi logins, model/effort, `--isolate`, files and images |
| [Configuration](docs/configuration.md) | The settings workbench, backend checks, route testing, global vs per-project |
| [Personas and seating](docs/personas.md) | The council roster, custom personas, AI-assisted generation, gut-check |
| [Agent integration](docs/agent-integration.md) | Wiring skills and commands into Claude Code, Codex, OpenCode |
| [CLI reference](docs/reference.md) | Every flag, JSON receipts, doctor, env vars |
| [Security and trust](docs/security.md) | Where credentials live, what a repo may configure, isolation limits |
| [Examples](docs/examples/) | Full transcripts from real runs |
| [Docs index](docs/README.md) | Everything, including internals |

## Related

- **[slopbuster](https://github.com/gabelul/slopbuster)** — strips the AI tells out of prose and code
- **[stitch-kit](https://github.com/gabelul/stitch-kit)** — teaches your agent the full design-to-code pipeline
- **[pixelslop](https://github.com/gabelul/pixelslop)** — opens your page in a real browser and measures the design

---

Built by Gabi @ [Booplex.com](https://booplex.com). MIT license.
