# Claude Code invocation checks

## Scope and evidence, 2026-10-08

The reported symptom was a consult failing or producing no answer across several
projects. No exact tool command/error was available. Global inspection found
`~/.claude/commands/council.md` and the `bpx-council` skill, linked to
`~/.agents/skills/bpx-council`. No global `/consult` command file was present.
`bpx-consult` is the separate Pi extension; Claude's installed command is
`/council`, which calls the standalone `bpx-council` executable.

The command/skill still had older invocation instructions. The installed CLI is
2.1.0 and supports `--format json` and `--no-stdin`; updating those instructions
does not require installing the unreleased workbench.

Offline process-boundary tests reproduced an open-stdin failure in both built
source and installed 2.1.0: without `--no-stdin`, an inherited pipe held open
causes a three-second deadline error before an advisor starts. Explicit solo,
JSON and no-stdin succeeds under the same conditions. This proves a defect in
the older invocation pattern, **not the user's exact root cause**.

## Repairs

Shared templates now select mode explicitly, treat the question as one escaped
argument, ignore unselected stdin, parse complete/partial/failed JSON receipts,
and wait for a host background task rather than launching duplicate calls.
CLI timeout is per advisor; larger modes need more host execution time.
Raw `$ARGUMENTS` must never be spliced into shell source, even within double
quotes. No automatic paid retries or backend substitution.

User explicitly authorized updating only the installed command and shared
skill after offline checks. Both now match the repository templates. Copies
were backed up under:

```text
~/.claude/bpx-council-integration-backups/20261008-005746/
```

`manifest.json` records original/new hashes and target paths. Updates followed
the skill symlink, preserved file permissions, and used atomic replacement.
Global CLI version and user configuration were not replaced. No hooks or
account settings were edited. Other agents sharing the canonical skill see
the same updated instructions.

## Reproduction

```bash
npm run build
python3 scripts/qa-agent-invocation.py
```

The harness uses temporary HOME/config, a fake advisor and a preload guard
blocking network and all subprocesses except that fake. It tests source and a
resolved global JS artifact separately; use `BPX_QA_CLI` for a wrapper's actual
JS entry, and `BPX_QA_NODE` for an alternate Node runtime.

Cases cover open stdin, shell metacharacters/newlines passed literally,
one failed call without retry, and nonzero synthesis failure preserving both
completed Council responses. Fixtures are removed; raw evidence is retained.

Verified:

- Full suite: 860 passed, two optional native Pi tests skipped, 48 files.
- Node 20 host-template/installer suite: 80 passed.
- Source + installed 2.1.0 invocation contract: eight cases passed.
- Node 20 contract: four cases passed; worker also verified four under Node 22.
- Installed instruction hashes match source; symlink and modes retained.
- Build and `git diff --check` pass.

Logs: `/tmp/bpx-host-integration-{tests,contract,node20,node20-contract}.log`.
Harness logs identify their retained artifact directory.

These checks do **not** prove Claude Code discovers the command, generates the
right Bash invocation, or successfully calls the user's real provider. No real
Claude/Codex/Pi model process or account request was run. A fresh Claude Code
session and a small `/council` question are the next real-host check. If it
fails, capture the actual Bash command, stdout/stderr and task/exit status;
project-local commands may override the global integration. Inspect nesting
restrictions only if the attempted route actually uses Claude as its advisor.

## Runtime follow-up, 2026-10-08

Instruction repairs are not a confirmed runtime fix. Read-back of installed
2.1.0's `dist/backend.js` confirms Claude subprocesses still inherit the host
environment. Backend stderr is deliberately discarded to avoid leaking prompts
or credentials; a nonzero exit becomes only `"claude" exited <code>`. Current
repository `src/backend.ts` has the same diagnostic limitation. This can conceal
a specific failure reason, but does not establish what failed in the report.

Online evidence identifies version-specific candidates:

- [Anthropic issue #29543](https://github.com/anthropics/claude-code/issues/29543)
  reports nested `claude --print` rejection under `CLAUDECODE` on 2.1.63 and empty
  output after unsetting it. Duplicate closure is not evidence of a fix.
- [Issue #39028](https://github.com/anthropics/claude-code/issues/39028) reports
  empty `--print` results despite paid token generation on 2.1.83.
- [Current environment documentation](https://code.claude.com/docs/en/env-vars)
  describes `CLAUDECODE` and newer `CLAUDE_CODE_CHILD_SESSION` propagation.
- [Current headless documentation](https://code.claude.com/docs/en/headless)
  distinguishes startup errors on stderr from in-run errors on stdout. Its
  `--bare` mode does not use subscription OAuth, so adding it would change the
  authentication route rather than provide a transparent repair.

Local `claude` resolves to a native artifact named `2.1.294`; no native startup
or inference was run. Older issue reports cannot establish this version's
behavior. No environment marker was removed, no alternate authentication route
was selected, and no paid retry occurred. The unresolved gate remains an actual
host invocation and its failure receipt; Claude hosting alone does not identify
the advisor backend.

## Native Codex/Pi transport checks, 2026-10-08

Native isolated fixtures now distinguish source support from the installed CLI:

- Codex 0.161.0 passed `callCliAdvisor` round-trip and stalled-request timeout
  using both current source and installed Council 2.1.0. Registry-generated
  arguments retained the selected model/high effort, stdin reached EOF and
  JSONL produced the fixture response. A macOS sandbox allowed loopback and
  denied external IPv4/IPv6; HOME/CODEX_HOME and authentication were synthetic.
- Pi 1.1.0 passed all 24 Pi adapter tests, including isolated native startup and
  localhost-only SSE round-trip. This establishes tested source compatibility.
- Installed Council 2.1.0 has **no Pi preset**. Its generic fallback does not
  supply the guarded print/isolation/effort arguments. Source Pi support must
  not be attributed to that unchanged installation.

The combined transport suite passed 40 tests across five files, including both
native fixtures, subprocess cleanup, tmux argument quoting and host templates.
Evidence: `/tmp/bpx-cli-transport-tests.log`,
`/tmp/bpx-codex-native-evidence.log` and `/tmp/bpx-cli-pi110.log`.
The opt-in Codex fixture is `tests/codex-native.test.ts`; it refuses native
execution without its proven network confinement.

No private account was used. These tests establish process/protocol behavior,
not real authentication, billing or the reported failure's root cause.

Terminal mode is not an authentication selector. Official
[Codex noninteractive docs](https://developers.openai.com/codex/noninteractive)
state that exec reuses saved CLI authentication by default. Claude's
[authentication docs](https://code.claude.com/docs/en/authentication) and
[environment docs](https://code.claude.com/docs/en/env-vars) distinguish
subscription OAuth from API/provider credentials and their precedence; an API
key in print mode can override subscription authentication. tmux is therefore
not required merely to use subscription auth and cannot guarantee that billing
route. Existing Claude tmux boot also enables dangerously-skip-permissions;
it is not equivalent to the tool-disabled headless preset.
