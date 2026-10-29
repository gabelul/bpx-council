# Security and trust

The short version: Council assumes a repo is not a trusted source of
executable instructions, credentials live in owner-only files and never move
between stores, and advisors run with tools denied wherever possible. The
longer version:

## Credentials

- Council-owned SDK accounts live in `~/.bpx-council/auth.json` — plaintext,
  owner-only file (0600) inside an owner-only directory (0700). This is not
  an OS keychain.
- With [shared pi logins](providers.md#shared-pi-logins-opt-in) enabled,
  Council reads and writes the pi agent's own `~/.pi/agent/auth.json` under
  the same file-locking protocol pi uses. Only admitted providers are
  touched; other entries and unknown fields survive verbatim.
- Credentials are **never copied between stores**. OAuth refresh tokens are
  single-use and rotating; a copy in a second store would race the original
  and one of them would end up logged out.
- SDK routes don't read `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` from the
  environment and refuse to run if those conflict with an explicit selection.
- Finding Codex or Claude on PATH does not import their credentials into
  Council-owned accounts, and the Pi CLI route leaves credentials with Pi.
- Login, key replacement and local account removal are explicit, immediate
  changes. Discarding a route draft does not undo them. Local removal doesn't
  revoke the account at its provider.
- Advisor CLIs are separate programs with their own credentials and security
  model. Council's presets deny tools where it can verify the outcome (Claude
  tools off, Pi fully sandboxed to a private temp directory, Codex in a
  read-only sandbox — which still allows reading project files and running
  shell reads). What a *custom* CLI command does with your repo is yours to
  check; the name `bpx-council` doesn't sandboxes it.

## Project config boundaries

A repo can carry `.bpx-council.json` for shared mode and route preferences,
but a repo is not allowed to decide who *executes*. Auto-discovered project
files:

- **May** select the Anthropic HTTP route and its model; seat bundled
  personas; set output-token preferences; reset a seat to inherit Solo with
  `null`.
- **May not** choose CLI commands (even Codex — its read-only sandbox still
  permits shell reads), tmux, custom HTTP URLs or API-key variables, SDK
  routes, `sharePiAuth`, persona prompts, or trusted custom personas.

An invalid file fails with its path and key before any model call. Passing a
repo-controlled file explicitly with `--config` doesn't launder it — explicit
files get *trusted* treatment, so only pass files you control. The trust
boundary exists because a repo you cloned shouldn't get to pick a command
that runs with your credentials.

## Advisor isolation

Advisors see your project directory by default, and CLIs like Codex and
Claude read the repo's `AGENTS.md` / `CLAUDE.md`. `--isolate` skips project
instructions in supported presets — it does not prevent file reads, and it is
not a filesystem sandbox. Details per backend are in
[Staying independent of your project](providers.md#staying-independent-of-your-project).

## What Council never does

- Never retries a failed SDK provider call — one attempt, then an honest
  error.
- Never sends workspace files or persona prompts in a connection smoke test;
  tests send a synthetic prompt.
- Never writes into `~/.claude`, `~/.agents`, or `AGENTS.md` on `npm install`
  — agent wiring is a separate, explicit `bpx-council install`.
- Never treats an unfamiliar version string or catalog result as proof of
  anything; absence of evidence stays absence of evidence.
- Never bypasses a confirmation with a page helper or scripted click to
  submit something you didn't ask for.
