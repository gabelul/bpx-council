# Backends and providers

Four things decide who answers and how: the backend, its model, how hard it
thinks, and what you hand it.

## Route types

| Type | Example | What it is |
| --- | --- | --- |
| CLI preset | `codex`, `claude`, `opencode`, `pi` | Spawns the tool headless, with a guarded preset |
| Anthropic HTTP | `anthropic` | Direct API call with `ANTHROPIC_API_KEY` |
| Direct SDK | `sdk:provider:model@effort` | Council's bundled SDK, Council's own accounts |
| Interactive | `tmux` (also `pty`, `interactive`) | Drives an agent in a real terminal session |

Automatic detection picks the first available of: an explicit choice
(`--backend` flag or saved config), then `ANTHROPIC_API_KEY`, then Codex or
Claude CLI on your PATH. Explicit CLI-arg and config selections sit at the
same level; the flag is simply the one you typed this time. Other CLIs are
never auto-selected — name one only if you trust its local configuration.

```bash
# codex as the advisor (its own configured model)
bpx-council --backend codex "Is this auth flow sane?"

# codex on a specific model — passed straight to codex's --model
bpx-council --backend codex --model gpt-5.6-sol "Is this auth flow sane?"

# claude CLI on Opus; Anthropic over HTTP with an explicit model
bpx-council --backend claude --model claude-opus-4-8 "..."
bpx-council --backend anthropic --model claude-opus-4-8 "..."

# a direct SDK route
bpx-council --backend sdk:openai:gpt-5-mini@low --question "..." --no-stdin
```

`--model` works for both kinds: HTTP and SDK routes target that model
directly, and CLI backends get it injected as their own model flag, in
whatever position that particular tool wants it. Leave it off and the CLI
uses whatever it's already configured for, which is usually what you want,
since it tracks its own latest without you maintaining a version string.
`--model` also reads `BPX_COUNCIL_MODEL` / `ANTHROPIC_MODEL` from the env.

## Model and effort

Some backends expose a reasoning-effort dial. `--effort` sets it; pin it per
backend with `@level`. That's where the council gets interesting: different
stances at different depths.

```bash
bpx-council --mode council \
  --backends codex:gpt-5.6-sol@max,claude@high,codex:gpt-5.4-mini@low \
  "Rewrite the parser, or patch it?"
```

An expensive architect, a cheap simplifier. Same idea as assigning models, one
level down.

| Backend | Effort control |
| --- | --- |
| `codex` | per-model levels, read live from its catalog |
| `claude` | low, medium, high, xhigh, max |
| `sdk:*` routes | validated against the provider's bundled catalog; an unsupported level is rejected, never downgraded |
| `pi` | Pi's CLI-supported thinking levels; Pi may clamp them for the selected model |
| everything else | ignored; no such control, so nothing is passed |

Which levels are valid depends on the backend, and for codex on the model.
`gpt-5.6-sol` accepts up to `ultra`, while `gpt-5.5` stops at `xhigh`. The
wizard asks codex what the model you picked actually supports and offers
exactly those, so you can't pick one it would reject.

Set a fallback for every run in the config as `solo.thinkingLevel`; a backend
that pins its own with `@level` keeps it, since that's the more specific
choice. Backends without an effort dial ignore it rather than being handed a
flag they'd reject.

## Staying independent of your project

Both codex and claude read the repo's `AGENTS.md` / `CLAUDE.md` before
answering. So a second opinion asked inside a project shows up already
following that project's house rules, which is some of the bias you were
trying to escape by asking someone else.

`--isolate` changes how supported presets load project instructions; it does
not prevent a CLI from reading files:

```bash
bpx-council --isolate "Is this auth flow actually sane, or are we just used to it?"
```

Tested by planting an instruction ("begin every reply with BANANA") in a repo's
`AGENTS.md`. codex obeyed it, and stopped once `--isolate` was passed.

| Backend | What `--isolate` does |
| --- | --- |
| `codex` | sets `project_doc_max_bytes=0` to skip project `AGENTS.md`; keeps the project working directory and can still read its files |
| `claude` | drops the project `CLAUDE.md` from the preset's instruction path; user-global instructions may still apply |
| `pi` | its preset always disables tools, extensions and discovered instructions, and runs in a private temporary directory |
| everything else | no isolation guarantee; some CLIs may read project config |

One honest limit: for claude this drops the project `CLAUDE.md` but **not**
your user-global `~/.claude/CLAUDE.md`, which survives a system-prompt
override. There's a `--bare` flag that drops both, except it also forces
authentication through `ANTHROPIC_API_KEY` and never reads your OAuth login,
which breaks the no-API-key setup this whole tool is built around. Not worth
it as a default.

It's opt-in, so nothing changes for existing setups, and an advisor that knows
your conventions is genuinely useful sometimes. Reach for `--isolate` when you
want the outside view.

## Files and images

Piping works for one blob of context (up to 1MB). It waits for EOF, then
fails if the pipe stays open past three seconds, even if no bytes arrived.
Use `--no-stdin` when a calling harness keeps stdin open. `--file` is better
when there's more than one, and it labels each by name:

```bash
bpx-council --file src/auth.ts --file tests/auth.test.ts \
  "Does the test actually cover the bug the code has?"
```

Files are read and folded into the prompt, so **every backend supports
this**. Each file is fenced and labelled, and told plainly if it was
truncated (256KB per file, 512KB total, at most 16 files) so the model doesn't
reason about a function whose ending it never saw.

Images are different, because a picture can't be folded into text. The backend
has to actually take one:

```bash
bpx-council --backend codex --image mock.png "Does this layout look off?"
```

| Backend | Images | How |
| --- | --- | --- |
| `codex` | ✓ | attached directly (`-i`), several at once |
| `anthropic` | ✓ | inlined into the request as base64 |
| `sdk:*` routes | ✗ | no image transport in the guarded SDK path |
| `claude` | ✗ | tools are disabled; no verified direct image transport |
| everything else | ✗ | refuses with a message naming the ones that work |

Images must be regular, non-symlink files with matching magic bytes (four
max, 5MB each, 20MB combined). Anthropic HTTP gets the validated bytes frozen
before the call. Codex CLI gets a validated **path**, not frozen bytes:
another process could replace its contents before Codex opens it. Use
Anthropic HTTP when that race matters. With `--image`, Council and Debate
check each seat's image transport before any call. Image paths in config are
rejected; pass them with `--image` so the CLI validates each file and freezes
bytes for Anthropic HTTP.

For Codex, a pinned model that its catalog marks text-only triggers a warning
before a call, including Council and Debate seats. An unknown catalog result
isn't treated as proof of image support.

Bad paths, directories, binary files passed to `--file`, and unsupported image
types all fail immediately, before any model call rather than two minutes into
a council run.

## Direct providers

Backends → Direct providers separates Council accounts from installed CLIs.
Supported choices:

| Provider | Council authentication |
| --- | --- |
| OpenAI | API key |
| Anthropic | API key or SDK-supported OAuth login |
| OpenAI Codex (ChatGPT Plus/Pro) | SDK OAuth subscription login |
| Z.AI | API key |

Other SDK providers aren't admitted yet. Finding Codex or Claude on PATH does
not import their credentials. OAuth uses the bundled SDK's login flow: open
its displayed URL yourself and answer any masked prompts. Council doesn't
launch a browser. A supported login flow does not establish your account's
model entitlement or billing plan.

By default, SDK routes keep their own accounts at `~/.bpx-council/auth.json`
and never read `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or Pi's login files.
The [shared pi logins](#shared-pi-logins-opt-in) mode below changes exactly
that, opt-in.

Accounts live separately from route configuration. Credentials are plaintext
in an owner-only file, inside an owner-only directory; this is not an OS
keychain. Login, key replacement and local account removal are explicit,
immediate changes. **Discarding a route draft does not undo them.** Local
removal doesn't revoke the account at its provider. Project settings cannot
manage accounts or author SDK routes; they can inherit a trusted global route.

SDK requests have no agent tools or workspace discovery. They require an
explicit supported model, reject unsupported effort instead of downgrading it,
and do not retry failed provider calls. Ctrl-C stops future seats, cancels
supported active calls and waits for credential refresh/storage cleanup
before exit 130. Completed Council or Debate answers survive as partial
output. An interrupted provider-side token rotation cannot be made atomic
with a local file write; storage failures may require reconnecting the
account.

SDK route tests and persona generation keep the admitted output ceiling and
thinking level, with quota/ceiling disclosure before consent. OpenAI requires
at least 16 output tokens; legacy Anthropic thinking needs its SDK thinking
budget plus 1024 answer tokens. Impossible budgets are refused before a call.
The ChatGPT codex backend accepts no server-side output-token ceiling, so
codex routes are bounded by the byte cap and request timeout instead.

### Shared pi logins (opt-in)

`sharePiAuth: true` in the global config (toggle: Backends → Direct providers
→ Share pi logins) makes Council read and write the pi coding agent's own
`~/.pi/agent/auth.json` instead of its separate store, under the same
file-locking protocol pi sessions already use — both re-check whether a
credential needs refreshing while holding the lock, so concurrent Council and
pi sessions don't fight over a rotation. Council touches only the providers
listed above; pi's other entries and unknown fields survive verbatim.

Two disclosures come with it: consults spend the same subscription quota as
pi, and removing an account in Council also removes pi's login for that
provider. Copying credentials between the two stores is never done —
rotating refresh tokens would race.

## Driving an interactive agent instead

There's a fourth backend type beyond CLI and HTTP: `tmux` (also `pty` or
`interactive`), which drives an agent running in a real terminal session
rather than spawning a fresh headless one.

```bash
bpx-council --backend tmux "Is this auth flow sane?"
```

It needs `tmux` installed and starts a new interactive agent session. Plain
CLI backends are the usual choice. Claude `-p` can use a Claude.ai
subscription login; Codex `exec` reuses saved CLI authentication. Neither
requires tmux for subscription access. Credentials decide billing, not
whether the process has a terminal.

For Claude, an `ANTHROPIC_API_KEY` is always used when present in print mode;
other credentials can also override the subscription login. Check `/status`
in Claude Code to see the active authentication method. See [Claude
authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)
and [Codex non-interactive authentication](https://developers.openai.com/codex/non-interactive-mode).
The interactive tmux adapter starts Claude with `--dangerously-skip-permissions`;
it is not the tool-disabled headless preset or a subscription-billing safeguard.

## Pi as the advisor

Pi is an explicit CLI route, separate from the terminal UI library:

```bash
bpx-council --backend pi "Is this auth flow sane?"
```

Choose Pi in the workbench to browse the models available through its own
global configuration and credentials. IDs include the provider
(`provider/model`), so models with the same name under different providers
stay distinct. Manual IDs and saved unavailable choices remain selectable.

The preset disables tools, extensions, skills, prompt templates and discovered
context. It replaces the system and append prompts, disables session
persistence, uses Pi's offline startup mode, and runs in a private temporary
working directory. Requested model calls still use the provider API. That
protects the project from Pi's startup migrations; Pi may still migrate its
own legacy global files or use configured credential helpers. The Pi CLI route
leaves credentials with Pi; it doesn't import them into Council-owned SDK
accounts.

The catalog is auth-filtered and extension-disabled, not a copy of the running
Pi session's registry. Extension-only providers and virtual models are
excluded. A listed model isn't proof of provider entitlement. Thinking choices
are Pi's CLI-supported levels; Pi may clamp them for the selected model.
`ultra` and custom Pi argument overrides are refused rather than bypassing the
preset. Older Pi CLIs that don't support these safety switches fail; Council
never retries with fewer protections. Image attachment through Pi isn't
supported.

Only Anthropic HTTP is implemented among the plain HTTP routes. OpenAI and
Google HTTP config values fail before any request; use a supported CLI or
Anthropic route instead. The Anthropic default model is `claude-opus-4-8`.

A custom command's permissions and output format are yours to check, not
something the name `bpx-council` magically fixes.
