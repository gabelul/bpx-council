# bpx-council — Agent Reference

## overview

bpx-council is a standalone CLI that provides multi-model advisory/council capabilities to any coding agent. It's the portable version of the [bpx-consult](https://github.com/gabelul/bpx-mono/tree/main/packages/bpx-consult) pi extension.

## architecture

Entry and wiring:

- `src/index.ts` — CLI entry point: stdin, dispatch, output. Runs `main()` on
  import, so keep pure logic out of it and in a sibling module.
- `src/args.ts` — arg parsing. Pure in, pure out. Unknown flags are collected
  and treated as fatal by `index.ts` — see troubleshooting for why.
- `src/config.ts` — config loading (`~/.bpx-council.json`)
- `src/config-wizard.ts` — target selection and atomic persistence; headless flags
  bypass the workbench.
- `src/config-workbench.tsx` / `src/workbench-input.tsx` — Ink console on stderr,
  terminal-cell layout, editable fields and raw-mode cleanup.
- `src/workbench-layout.ts` — presentation-only centered geometry and shared
  rendering/Page navigation budgets. Natural-height shell, stable operation windows;
  verify real terminal cells, resize/caret and NO_COLOR, not only string snapshots.
- `src/config-draft.ts` — staged nested draft/focus controller, catalog discovery
  and explicit paid-call confirmations. Await cancelled lookups/actions before
  returning: the CLI caller uses `process.exit`. Freeze request fingerprints at
  confirmation; stale routes must not start calls or accept old results.
- `src/backend-diagnostics.ts` — filesystem-only installed/key inventory and explicit
  cancellable allowlisted version checks. No silent probes on config/npm startup.
  Manual install offers the same checks with progress and typeahead lock. Checking
  snapshots precede spawning; unrecognized versions warn, hard failures exclude new
  choices without deleting saved routes. Receipt states never imply authentication.
  Keep executable identity separate from terminal-display sanitization.
- `src/config-personas.ts` — pure persona creation/editing and seat mutations;
  unseating retains prompts/routes, project drafts cannot author prompts.
- `src/config-actions.ts` — purpose-aware unsaved-route smoke tests and literal-JSON
  persona generation. Direct SDK, Pi, Claude and stock Anthropic support both. SDK
  actions keep admitted thinking/token ceilings; tiny test caps break provider minima.
  Codex basic tests
  use normal read-only permissions with a cost-dialog tool-access warning; generation
  stays blocked. Never silently substitute unsupported/custom transports. Project inheritance without a local Advisor
  pin is blocked because the global layer is absent from the target-file draft.
- `src/workbench-multiline-input.tsx` — LF-preserving prompt/focus editor;
  Enter inserts newline, Ctrl-S applies field, never writes config.
- `src/config-editor.ts` — shared pure route mutations; preserve unmanaged fields
  and clear legacy Advisor effort only after explicit reset/edit intent.
- `src/detect.ts` — backend auto-detection. Override chain: `--backend` >
  config > `ANTHROPIC_API_KEY` > Codex/Claude CLI on PATH > error.

Modes:

- `src/solo.ts` — one advisor, one response. Also backs `gut-check`.
- `src/council.ts` — several personas in parallel, synthesizer merges.
- `src/debate.ts` — advocate vs critic, sequential rounds, then a verdict.
- `src/personas.ts` — stances and the synthesizer prompt.

Backends:

- `src/backend.ts` — spawns an advisor CLI, parses its output
- `src/cli-registry.ts` — per-CLI flags, model metadata and transport capabilities
- `src/pi-backend.ts` — unconditional Pi guards, private persona/cwd and table parser
- `src/http-backend.ts` — direct API calls (anthropic/openai/google)
- `src/pty-backend.ts` — terminal CLI transport; auth, not tmux, chooses billing
- `src/sdk-backend.ts` / `src/sdk-route.ts` — explicit `sdk:<provider>:<model>@<effort>`
  namespace, local admission and dispatch. Project-authored SDK routes are forbidden;
  trusted global inheritance remains allowed. Never convert CLI/HTTP routes implicitly.
- `src/sdk-provider-service.ts` / `src/sdk-types.ts` — lazy lower-level pinned pi-ai,
  static chat catalogs and Council accounts; no Pi executable/session/ambient auth.
  Initial scope is OpenAI API keys, Anthropic API keys/OAuth. Preserve original consent
  generation through actual credential reads/HTTP, not freshly substituted revisions.
- `src/sdk-credentials.ts` — owned 0700/0600 plaintext auth, locked atomic updates,
  tombstone/credential-version fences and operation-wide refresh/login/write drain.
  Auth changes persist outside ConfigDraft; Discard cannot undo login/logout.
- `src/sdk-inference-policy.ts` — exact provider budget/endpoint/header enforcement
  and preparse inference byte caps. No peak-RSS/SDK-queue/OAuth-body ceiling claim.
- `src/invocation-lifecycle.ts` — repeated-SIGINT gate; await transports, SDK storage
  and stdout before exit130. Preserve completed seats and avoid future calls.

### Council is multi-model only when backends are assigned

`council` uses `council.members` order (default architect, critic, simplifier)
and resolves a backend **per persona**: `--backends` (positional) >
`config.council.backends` (by persona name) > the shared `solo.backend`.
Trusted global/explicit `personas` definitions replace or add named prompts;
project auto-discovery may only select bundled members, never inject prompts.
Gut-check has independent `gutCheck.backend`: explicit `--backend` > saved
route > Solo. `maxOutputTokens` is a hard HTTP/SDK ceiling, CLI prompt request only.

With no assignment every persona runs on the same model — three stances, one
model. That's a legitimate cheap mode, but it is *not* multi-model, and the
word shouldn't be used for it. The distinction was false for the project's
first three days; see troubleshooting.

The resolved model rides on each member and prints in its header
(`### critic [against] · claude`). Council synthesis can separately select
`council.synthesizer` / `--synthesizer`; Debate has `debate.advocate`,
`debate.critic`, and `debate.synthesizer` / matching flags. Unassigned seats
inherit `solo.backend`. Keep model attribution on turns and verdicts — without
it, different models look like one.

### Multi-call modes: decide what survives a failure

`council` and `debate` make several sequential or parallel model calls. Any
one of them can time out — that's routine, not exceptional. Both modes return
whatever completed rather than discarding the run: `council` returns raw
member verdicts via `partial` if synthesis fails, `debate` returns completed
rounds via `partial`. Both report failure so callers don't mistake partial
work for a finished verdict.

Keep that property when editing either. Losing five minutes of good rounds to
one timeout is the single worst thing this tool can do to a user, and it has
already happened once.

Pi is explicit, not auto-selected ahead of existing defaults. Its preset rejects
custom args, unsupported thinking and images before any seat starts. Tools,
extensions, discovered instructions and persistence stay disabled even without
`--isolate`. The private cwd protects project startup files; Pi may still migrate
legacy global files. Discovery is global, auth-filtered and extension-disabled,
not the running session's registry. Guarded Pi metadata can be on stderr: keep
that bounded/private and expose only validated provider/model IDs.

## docs

- `docs/dev-docs/sdk-standalone-qa.md` — owned-auth SDK gates, stock-model fixtures,
  tiny input persistence warnings, native action budgets and remaining limits.
- `docs/dev-docs/troubleshooting.md` — non-trivial bugs and their root causes.
  **Read it before debugging something that feels familiar**, and add to it
  when you fix something that took real investigation.

## conventions

- TypeScript, ESM, Node >=22.19 (CI: exact minimum/24); advisor CLI requirements vary
- `npm run dev` to run locally via tsx (no build needed)
- `npm test` runs vitest
- Conventional commits drive release-please (feat: minor, fix: patch)
- The README stays evergreen — no version-pegged claims that drift
