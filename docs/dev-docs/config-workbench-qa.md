# Config workbench verification

## Claude picker follow-up, 2026-10-07

Claude now offers selectable `sonnet`, `opus` and `haiku` before default/current
and optional manual actions. These are documented CLI aliases, not an account
catalog; Claude resolves their model versions when run. Opening the picker has
no subprocess, authentication inspection or network request. Custom saved pins
and current/default focus are retained. See
[Claude model aliases](https://code.claude.com/docs/en/model-config#model-aliases).

Real terminal QA exposed a one-row natural-dialog budget error: six compact
choices had only five visible rows at 80×24. Chrome budget now includes all six
rows, with regressions at 220×60, 120×40 and 80×24. Narrow menus remain scrollable.

- Full suite: **856 passed across 47 files**, including explicitly isolated Pi 1.0.3.
- Node 20.20.2 and Node 22.22.1 focused suites: **171 passed each**.
- `scripts/qa-claude-model-picker.py`: three source and three packed PTY scenarios
  passed: custom-pin cancellation, arrows/Enter Opus selection and critic-only
  Save, and 40×12 NO_COLOR Haiku selection/discard. No model IDs were typed; no
  Claude subprocess or provider request was made. Exact stty and bytes verified.
- Existing layout and ten nested/persona PTY regressions passed.
- All 43 packed compiled modules matched build; build and diff checks passed.

Raw evidence: `/tmp/bpx-claude-{all-tests,node20-tests,node22-tests}.log`,
`picker-pty.log`, `packed-pty.log`, `layout-pty.log`, `nested-pty.log` and saved
`.exit` files. Package installed only under `/tmp/bpx-claude-prefix`.
No private-account checks, global installation, commit, push or publication.


## Centered console follow-up, 2026-10-07

Configuration workbench now uses a centered natural-height shell capped at
112×32 cells, shared editor windows capped at 80×22, and a stable 80×24 local-check
dialog. Installer/noninteractive output and backend semantics were not restyled.

- Default Node 24.21.0 and Node 22.22.1: **837 passed across 46 files**. Both runs
  explicitly selected isolated Pi 1.0.3 fixtures, not the user's launcher/account.
- Node 20.20.2: **835 passed, two optional native-Pi skips**. All saved exits were 0.
- Source PTY: five layout flows (reported as three groups), five progress, five
  diagnostics/install and ten nested/persona flows passed with exact stty restoration.
- Packed CLI: five layout plus five progress flows passed on default runtime;
  five layout flows also passed Node 20. All 43 compiled JS modules matched build.
- Build, diff check and runtime dependency audit passed; zero vulnerabilities.

Real captures cover 220×60, 120×40, 80×24, 40×12 and 20×8. They verify actual
centered bounds, resize-preserved caret, explicit Save, visible safe-default
buttons/Codex warnings, locked 6/9 progress and all nine backend table rows.
NO_COLOR overlays omit transparent parent windows; requested route IDs wrap by
terminal cells without changing confirmation data. Tiny terminals still clip
long titles and omit optional hints rather than hide selected actions.

Capture review caught three issues beyond earlier text-only checks: sparse blue
slabs, a missing first table row and parent text leaking through NO_COLOR dialogs.
These were fixed. One regression fixture tried editing an inherited Council model
without first pinning its backend; the existing guard correctly refused it.

PTY harness now buffers Ink's synchronized-output markers (`CSI ?2026 h/l`),
including split markers, before committing emulator frames. Otherwise assertions
can see a half-erased frame during a valid redraw. Split-marker regression passed.

Durable captures: [implemented console](../design/console-captures/README.md).
Reproduction: `scripts/qa-console-layout.py` plus existing workbench harnesses.
Raw evidence: `/tmp/bpx-console-{all-tests,node20-tests,node22-tests}.log` and
matching `.exit` files; `/tmp/bpx-console-{layout,progress,diagnostics}-pty.log`;
nested output is `/tmp/bpx-console-source-pty.log`. Packed evidence is
`/tmp/bpx-console-packed{,20}-layout.log` and `packed-progress.log`.

No real-account calls, global replacement, commit, push or publication.


Initial workbench check, 2026-10-04; confirmation follow-up below.
No push, publication or global-package replacement.
User config and provider accounts were left alone.

## Runtime checks

| Runtime | Result |
| --- | --- |
| Node 20.20.2 | 576 passed; two optional native-Pi tests skipped |
| Node 22.22.1 | 578 passed, including native Pi |
| Node 24.21.0 | 578 passed, including native Pi |

Build and `git diff --check` passed. Runtime dependency audit reported zero
vulnerabilities. A locally packed tarball was installed under a temporary prefix
with scripts disabled; ten changed compiled modules matched the build byte for
byte. The published/global package was not replaced.

## Real terminal checks

Built CLI and packed CLI each passed nine isolated PTY scenarios. The packed CLI
was also tested under Node 20. Every scenario used a temporary HOME, fake backend
binaries and exact before/after `stty -g` comparison:

- Mode edit, Review, Back to remembered field, then Save. Only mode changed.
- Dirty discard. Original file bytes unchanged.
- Model default. Direct pins and legacy Advisor effort removed; custom transport
  fields preserved.
- Existing-value caret editing, multi-character paste, Backspace, forward Delete,
  Home/End and Ctrl-A/E.
- Custom Council members `back`/`tokens`, remembered field focus and inheritance.
- Explicit Pi selection, guarded stderr catalog, search and model pin.
- Live resize to 40×12, modal Escape and unchanged discard.
- Escape during asynchronous lookup, then Ctrl-C. Child gone and private cwd
  removed before CLI exit.
- Ctrl-C during startup. Exit 130, file unchanged and terminal restored.

Separate PTY probes forced a React render failure and started with stdin already
in raw mode. Both restored the caller's terminal state. The render failure was
reported as failure, not a successful discard.

## Native Pi checks

Optional integration tests use `BPX_TEST_PI_CLI` to select an explicit CLI entry;
they never discover or run a user's configured launcher. Pi 1.0.2 was tested with
synthetic credentials, a temporary agent directory, extension/instruction traps
and a loopback-only OpenAI-compatible SSE server.

Catalog discovery made no inference request. Advisor execution made one request
to that local fixture, preserving the literal persona, excluding tools and
inherited instructions, and leaving no session or scratch cwd. Native startup
still migrated synthetic legacy global files; this is documented, not disguised
as zero-write isolation. No real account authentication or entitlement check ran.

## Evidence

Terminal harness and logs for this run were saved outside the repository:

- `/tmp/bpx-retro-pty.py`
- `/tmp/bpx-retro-final-tests.log`
- `/tmp/bpx-retro-node20-tests.log`
- `/tmp/bpx-retro-node22-tests.log`
- `/tmp/bpx-retro-pty.log`
- `/tmp/bpx-retro-lifecycle.log`
- `/tmp/bpx-retro-package-pty.log`
- `/tmp/bpx-retro-package-node20-pty.log`
- `/tmp/bpx-retro-wide.txt`, `/tmp/bpx-retro-narrow.txt`

Those paths are run artifacts, not a permanent test interface. Controller,
renderer, input-editing and Pi transport regressions live in `tests/`.

## Confirmation follow-up

Exit and Save now use centered, keyboard-trapping dialogs. Escape closes a field,
backs out to the sidebar, then asks before exit. Keep editing/Cancel is selected
first; Escape dismisses the dialog without changing the draft or workspace focus.
Exit with edits offers Save & exit and Discard & exit. Save validates before the
dialog and again on confirmation. Ctrl-C remains an immediate interrupted discard.

Full suite passed 597 tests across 35 files, including native Pi fixtures. All 49
workbench tests also passed under Node 20. The previous nine PTY flows passed with
the extra confirmation step; five new scenarios covered clean Escape exit,
shortcut trapping, dirty Save & exit, cancelled Save/refocus, 40-column dialogs,
discard and Ctrl-C inside confirmation. All restored exact terminal settings and
left file bytes unchanged until explicit Save. Those five new scenarios also
passed against an isolated installation of the newly packed CLI.

Real keyboard testing caught field Enter being dispatched twice: the field
applied its value, then the parent reopened it. The parent now keeps the field
snapshot from render time; choice and text regressions cover this event order.

Evidence: `/tmp/bpx-confirmation-pty.log`, `/tmp/bpx-confirmation-extra.log`,
`/tmp/bpx-confirmation-packed-pty.log`, `/tmp/bpx-confirmation-all-tests.log`,
`/tmp/bpx-confirmation-node20-tests.log`. At 20×8, the exit title clips and hints
are omitted; all action buttons remain visible. At 40×12, all three dirty-exit
actions and the full title remain visible.

## Backend accents and arrow navigation follow-up

Advisor and Gut-check use section-local Backend/Model/Effort labels. Council and
Debate keep role labels; Review names every route explicitly. Backend identities
have distinct accents, with amber selection taking precedence. Right enters a
pane or opens an editable field; Left returns to the sidebar. In search/manual
inputs, arrows remain caret controls. On Review/Discard, arrows never execute an
action. Confirmation buttons still require Enter.

Build and full suite passed: 616 tests, with two opt-in native-Pi tests skipped.
Node 22.22.1 passed all 83 workbench/input tests. Source and an isolated
installation of the packed CLI each passed three PTY scenarios covering identity
colors, search/manual caret ownership, arrow pane transitions, cancelled and
explicit Save, 40×12 dirty discard, NO_COLOR and Ctrl-C. Exact terminal state was
restored; config bytes changed only on explicit Save. Fake advisors never ran.

Real-terminal checks caught a false NO_COLOR assurance: a piped renderer emitted
no colors regardless of that setting, while Ink's Chalk path still colored TTY
output. Workbench now suppresses color props explicitly for nonempty NO_COLOR.
Forced-color unit tests and actual monochrome PTY checks cover that distinction;
borders, pointers, bold text and inverse caret remain usable.

Evidence: `/tmp/bpx-arrows-{full-tests,node22-tests,pty,package-pty}.log` and
`/tmp/bpx-arrows-pty.py`. No push, publication or global-package replacement.

## Nested seats, personas and explicit calls

Follow-up verified 2026-10-05. Implementation stays local and unreleased;
installed global package and private config are unchanged.

Council and Debate now open one seat at a time. Council keeps persona definitions
separate from seating. Manual and AI-assisted candidates can be inspected and
edited before acceptance into the draft. Multiline fields preserve LF; Ctrl-S
applies the field, not the file. Paid actions require a safe-default quota/cost
confirmation. Escape/Ctrl-C abort the actual transport and wait for cleanup.

Final runtime results across 40 files:

| Runtime | Result |
| --- | --- |
| Node 20.20.2 | 717 passed; two optional native-Pi tests skipped |
| Node 22.22.1 | 719 passed, including Pi 1.0.3 loopback fixtures |
| Node 24.21.0 | 719 passed, including Pi 1.0.3 loopback fixtures |

Build, diff checks and runtime dependency audit passed; audit reported zero
vulnerabilities. Fresh tarball installed under an isolated prefix with scripts
disabled. Fourteen modified compiled modules matched the build byte for byte.

Source and packed CLI passed ten new real-PTY scenarios; packed CLI also passed
all ten under Node 20. Three earlier accent/caret/Save/NO_COLOR scenarios passed
again against both source and packed CLI. Every exit compared exact before/after
terminal settings. New scenarios covered:

- Council/Debate nested arrows, one seat's fields and remembered parent focus.
- Manual name, stance and multiline prompt; unseat preserves definition; explicit
  Save writes only expected changes.
- AI quota Cancel makes zero calls; Run uses the chosen generator. Generated name
  collision cannot overwrite a bundled persona. Edit/accept then discard preserves
  original bytes.
- Unsaved model test and sequential member tests dispatch exact attempted models,
  without implicitly saving.
- Escape aborts a running test, kills its child and removes scratch cwd.
- Generated candidate Accept stays visible/actionable after resize to 40×12.
- Test-all cancellation retains a completed reply, aborts the current seat and
  starts no later call.
- Ctrl-C during generation exits 130 only after child/scratch cleanup.
- Nested NO_COLOR rendering and default-Cancel confirmation remain usable.
- Project inheritance absent from the draft is blocked rather than probing
  auto-detection. Synthetic global/project config bytes stay unchanged.

Real-terminal testing found a stance-picker bug: candidate name seeded its search,
hiding all stances. Stance searches now start empty. Narrow preview action rows
also use a selection viewport, so Accept cannot disappear below clipped content.
Regression tests cover both, along with stale ambient routes between confirmation
and response, candidate validation, project trust and partial-call cancellation.

Workbench actions intentionally reject Codex/OpenCode/tmux/custom args/custom HTTP
destinations: no verified tool-disabled, isolated preset exists for those flows.
Normal advisor behavior is unchanged. Tests report response receipt, not proof of
model identity or persona quality. Project drafts inheriting an absent local Advisor
must test from Global settings or pin a project Anthropic backend.

The reproducible terminal harness is `scripts/qa-config-workbench.py`. It uses
temporary HOME/config files and fake Claude only, never real account calls.
Optional development dependencies are Python `pexpect` and `pyte`:

```bash
npm run build
python3 -m venv /tmp/bpx-council-qa-env
/tmp/bpx-council-qa-env/bin/pip install pexpect pyte
/tmp/bpx-council-qa-env/bin/python scripts/qa-config-workbench.py
```

`BPX_QA_CLI` selects an isolated packaged entry; `BPX_QA_NODE` selects the Node
runtime. Failing runs interrupt owned fixtures before closing terminals.
Transcripts/screens are printed under a unique temporary evidence directory.

Run evidence: `/tmp/bpx-nested-{all-tests,node20-tests,node22-tests,pty,old-pty,
package-pty,package-node20-pty,package-old-pty}.log`,
`/tmp/bpx-nested-package-module-check.log`, and
`/tmp/bpx-nested-audit.json`. Temporary paths can disappear; source tests and the
checked-in PTY harness are the lasting checks.

## Installed-backend diagnostics

User requested a real installed-CLI check and readable state labels. Verified
2026-10-06; still local/unreleased, with global installation and private config
untouched.

Backends is shortcut 5; Preferences/Review/Discard are now 6/7/8. Presence inventory
uses filesystem lookup only. Check installed CLIs explicitly runs allowlisted
version commands in private working directories, never a model request. Interactive
manual install offers the same checks with No selected; npm lifecycle/headless
install/config startup never launch them.

Version receipts, missing/unusable programs, API key presence and configured-model
connection receipts are separate. Current exact-model response receipts disappear
when that route changes. Manual entry says Enter backend manually… and is not an
API key or installation field. Unsupported tests, failed calls, in-flight
cancellation and never-started batch seats now have distinct labels.

Raw suites across 44 files:
- Node 24.21.0: 776 passed, including explicit Pi 1.0.3 loopback fixtures.
- Node 22.22.1: 776 passed, including the same isolated native fixtures.
- Node 20.20.2: 774 passed, two optional native-Pi fixtures skipped.

Final runs used four Vitest workers. One four-command metadata fixture initially
hit Vitest's default five-second aggregate timeout under load; its test deadline
now covers sequential bounded commands (20s). Application's per-command limit
remains 3s; timeout/descendant tests still assert it.

Five new real-PTY cases passed against source and isolated packed CLI, and all five
passed against packed CLI under Node 20:
1. No startup/Right-arrow checks; explicit check refreshes installation/version
   data, discards private malformed output and preserves config bytes. Backend
   identity accents remain distinct. Version success isn't connection success;
   quota Cancel makes no call, Run tests exact configured model; changing model
   invalidates that receipt. Manual label/help is readable.
2. Escape at 40×12 cancels a TERM-resistant child/grandchild, removes private cwd,
   leaves original bytes and preserves NO_COLOR.
3. Ctrl-C during local checks waits for the same cleanup, exits 130 and restores
   exact terminal settings.
4. Manual install declines checks: zero subprocesses/model requests or integration
   writes; terminal state restored.
5. Manual install accepts checks: version-only fake commands; no agent integration
   writes before consent; terminal state restored.

All ten nested/persona/paid-call regression scenarios and three prior
accent/caret/Save/NO_COLOR scenarios passed against source again. Fresh package
installed with scripts disabled under a temporary prefix; 17 compiled modules
matched build byte for byte. Runtime audit found zero vulnerabilities; diff check
passed. All provider activity was synthetic/fake or the isolated localhost Pi
fixtures, never user accounts.

Metadata regression caught an executable-identity bug: sanitizing a manual name
containing a bidi control could turn it into an allowlisted Pi identity and start
Pi twice. Raw vs sanitized names now must agree before inventory accepts extras;
red-to-green regression proves one known Pi call and no alias execution.

Reproduce new terminal checks with optional pexpect/pyte:
`python scripts/qa-backend-diagnostics.py` (after build). Existing
`scripts/qa-config-workbench.py` now uses 1–8 shortcuts/new receipt labels.
`BPX_QA_CLI` and `BPX_QA_NODE` choose packaged entry/runtime. CLI startup may
migrate its own global settings; metadata flags don't guarantee zero global writes.

Evidence: `/tmp/bpx-diag-{all-tests,node20-tests,node22-tests,pty,regression-pty,
colors-pty,package-pty,package-node20-pty}.log`, matching exit files,
`/tmp/bpx-diag-package-modules.log` and `/tmp/bpx-diag-audit.json`.

## Blocking check progress and basic Codex tests

Implemented after Gabi explicitly approved normal read-only Codex basic tests.
No global replacement, publication or user-account calls.

- Checks now emit a before-spawn Checking snapshot, then a final receipt.
  Exit-zero unrecognized version output is Version unavailable, not a failed CLI.
- Workbench replaces editable workspace with a spinner/progress/status dialog.
  Every navigation/edit/shortcut/Enter path stays blocked; only Escape/Ctrl-C
  cancel. Focus/draft return after awaited cleanup. Counts describe steps, not paid calls.
- Hard local-check failures are excluded from ordinary new backend choices; the
  exact saved route remains a keep-unchanged choice. A failed exact model route
  does not blacklist that backend's other models. Unrecognized versions stay
  selectable as warnings; key-missing Anthropic stays explicitly configure-later.
- Basic Codex probes send Reply OK using exact selected model/effort (including
  literal @ model IDs and ultra), normal read-only flags, private cwd, project-doc
  suppression, 15s/4KiB stdout bounds and real process-group cancellation.
  Cost dialog states tools may remain; tests do not claim a filesystem boundary.
  Generation eligibility is separate: Codex generation still blocks before a call.
- Manual install prints safe start/finish updates and discards typeahead while
  checks run. Ctrl-C aborts, waits and restores prior raw/input state before exit.
  Diagnostics never stream subprocess stdout/stderr.
- Cancellation does not claim cleanup complete if the service reports unconfirmed
  process/directory cleanup.

Final raw suites: 817 passed across 45 files on Node24.21.0 and Node22.22.1,
including explicit isolated Pi1.0.3 localhost fixtures. Node20.20.2 passed815,
skipped two optional native Pi fixtures. Four Vitest workers; build/diff check pass.
Runtime audit: zero vulnerabilities.

Real PTY: five new cases prove live current-CLI/counters and key lock, failure
filter/saved-byte preservation, actual fake Codex stdin/argv/literal pins/quota
Cancel/strict generation refusal, and 40x12 Escape/Ctrl-C/NO_COLOR descendant and
private-cwd cleanup with exact stty restoration. Same five cases passed against
fresh packed CLI on Node24 and Node20. Prior five diagnostics/manual-install and
ten nested/persona/paid-call scenarios also passed against source.

Fresh package installed in isolated prefix with scripts disabled; 17 compiled
modules matched current build byte-for-byte. All model activity is fake CLI or
isolated localhost Pi, never user accounts. SDK provider routing/entitlement
outside those fixtures remains untested.

Reproduce:
`npm run build`, then optional Python pexpect/pyte and
`python scripts/qa-backend-progress.py`.
`BPX_QA_CLI` selects packed dist/index.js; `BPX_QA_NODE` selects Node runtime.

Evidence: /tmp/bpx-progress-{all-tests,node20-tests,node22-tests,pty,
diag-regression,nested-regression,packed-pty,packed-node20-pty}.log;
matching exit files; /tmp/bpx-progress-module-check.log; /tmp/bpx-progress-audit.json.

## Standalone SDK accounts and routes

Current local SDK acceptance is recorded in [sdk-standalone-qa.md](sdk-standalone-qa.md): 1045 tests on Node 22.19.0/22.22.1/24.21.0, real-SDK empty-HOME/no-CLI packed fixtures, six source/packed account PTY scenarios and renewed nested/layout/diagnostics/progress regressions. Accounts persist separately from routing; tiny key dialogs disclose that before entry. Native action tests keep admitted SDK token/thinking ceilings, reject impossible budgets before transport, and reject empty/known-credential replies. Not published or installed globally; no live provider account was tested.
