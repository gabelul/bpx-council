# Getting started

Your agent runs on a fast, cheap model most of the time — right, most of the
time. The exceptions are the handful of calls that decide how the thing turns
out: the architecture, the "should I even build this," the bug it's been
circling for an hour. `bpx-council` puts a stronger model on those. Or three
different ones, arguing.

Requires Node 22.19 or newer. Direct providers use Council's bundled SDK; Pi
does not need to be installed. Advisor CLIs remain separate installs with
their own runtime requirements.

## Install

```bash
npx @booplex/bpx-council "Is this auth flow sane?"
```

That runs the latest published version without installing anything. Once you
like it:

```bash
npm install -g @booplex/bpx-council
bpx-council install     # teach your coding agent it exists (see below)
```

The `install` step is deliberately separate, because nothing should write into
your editor config on an `npm install`. If you skip it, the first time you run
`bpx-council` in a real terminal it'll offer to set that up for you, once.

## Path 1: you already have an advisor CLI

Signed into Codex or Claude CLI? Both can run without an API key. Codex runs
in a read-only sandbox but can still read project files; Claude's preset
disables tools. Anthropic HTTP works with `ANTHROPIC_API_KEY`. Other agent
CLIs aren't auto-selected: choose one explicitly only if you trust its local
configuration.

You're done — `bpx-council "question"` works. Optional: pin a different
[model or effort level](providers.md#model-and-effort), or wire it into
[your agent](agent-integration.md).

## Path 2: no CLI, direct providers

No advisor CLI on your PATH? Use a direct provider account instead:

```bash
bpx-council config
```

Open **Backends → Direct providers**, configure an account (OpenAI API key,
Anthropic API key or OAuth, OpenAI Codex via ChatGPT subscription, or Z.AI),
then pick an Advisor provider and model explicitly. Details, credentials
handling and the optional shared-pi-login mode are in
[Backends and providers](providers.md#direct-providers).

Nothing gets assigned because you signed in — you choose the route. Then:

```bash
bpx-council --backend sdk:openai:gpt-5-mini@low \
  --question "Is this auth flow sane?" --no-stdin
```

## One command for both

```bash
bpx-council setup    # configure the advisor, then offer to wire into your agents
```

## Piping in context

```bash
git diff HEAD~3 | bpx-council --question "Review this diff for correctness"
bpx-council --file src/auth.ts --file tests/auth.test.ts \
  "Does the test actually cover the bug the code has?"
```

Progress goes to stderr, so `> out.md` still captures clean output.

## Updating

```bash
npm install -g @booplex/bpx-council@latest   # get the newest version
bpx-council install                          # re-run to refresh the agent files
```

Two steps on purpose. Updating the npm package **doesn't** touch your agent
files. Nothing writes into `~/.claude` or `AGENTS.md` behind your back on an
`npm install`. Re-run `bpx-council install` to pull in new or changed skills;
it's idempotent for known, unedited files; it refuses drift rather than
overwriting it. This does **not** migrate an older Codex skill at
`~/.codex/skills/bpx-council` — the installer reports that path but won't
remove it; check which one your host reads.

`bpx-council --version` shows what you've got. The CLI also checks for a newer
version at most once a day and prints a one-line notice on **stderr** (so it
never touches piped output). Silence it with `NO_UPDATE_NOTIFIER=1`; it's
already quiet in CI and when output isn't a terminal.

## Where to go next

- [Examples](examples/) — what real output looks like
- [Modes](../README.md#modes) — solo, council, debate, gut check
- [Configuration](configuration.md) — the settings workbench
