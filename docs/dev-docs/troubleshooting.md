# Troubleshooting

Landmines we've already stepped on. Symptom, root cause, fix, lesson. Check
here before debugging something that feels familiar.

Not a changelog — see `CHANGELOG.md` for releases.

---

## `--model` silently replaced the question with its own argument

**Date:** 2026-07-21 · **Severity:** high — produced confident answers to a
question you never asked

**Symptom**

```bash
bpx-council --model opus "Should I ship this?"
```

Returns a fluent, confident answer. It is answering the word **"opus"**. No
warning, no error, exit code 0.

**Root cause**

`--model` was documented in `HELP`, declared on `CliArgs`, and read in
`main()` — but there was no branch parsing it. The arg loop ended with:

```ts
else if (!a.startsWith("-") && !args.question) args.question = a;
```

So for `["--model", "opus", "Should I ship this?"]`:

| argv | what happened |
|------|---------------|
| `--model` | starts with `-`, matches nothing → silently ignored |
| `opus` | bare word, question unset → **becomes the question** |
| `Should I ship this?` | question already set → **discarded** |

Three independent places agreed the flag existed. Only the parser disagreed,
and it lost quietly.

**Fix**

Parse `--model`, and — the durable part — make unknown flags fatal:

```ts
else if (a.startsWith("-")) args.unknown.push(a);
```

`main()` refuses to run when `unknown` is non-empty. Adding a flag to the
help text without wiring the parser now fails loudly instead of eating the
question.

**Files:** `src/args.ts`, `src/index.ts`, `tests/args.test.ts`

**Lesson**

A CLI that ignores unrecognised flags cannot distinguish "you typo'd" from
"we forgot to implement this." Reject by default. The cost of a wrong-but-
plausible answer is much higher than a rejected command — nobody double-checks
an answer that reads well.

---

## Debate mode discarded the debate

**Date:** 2026-07-21 · **Severity:** high — the mode's entire value never
reached the user

**Symptom**

`--mode debate` ran five sequential model calls over ~6 minutes and returned a
single paragraph, shaped exactly like `--mode solo` output (which returns in
seconds).

**Root cause**

`runDebate` accumulated every advocate and critic turn into a local
`transcript`, then returned only the synthesizer's verdict:

```ts
return synthResult.ok
  ? { ok: true, text: synthResult.text }   // transcript dies here
  : { ok: false, error: ... };
```

The argument — the reason to pay 5× solo's cost — was computed and dropped.

**Fix**

Track two strings with two audiences: `transcript` (what the models see,
including the original question for context) and `roundLog` (what the user
sees, without their own question echoed back). Return `roundLog` plus a
`### Verdict` section.

**Files:** `src/debate.ts`, `tests/debate.test.ts`

**Lesson**

When an expensive mode's output is indistinguishable from the cheap mode's,
suspect the output path before the prompts.

---

## One timeout destroyed five minutes of completed rounds

**Date:** 2026-07-21 · **Severity:** high — hit on the first real run

**Symptom**

```
Council failed: Critic failed (round 2): "codex" timed out after 120000ms
```

Six minutes of wall time. Four model calls had **succeeded**. Total output: 74
bytes of error text.

**Root cause**

Every failure path was an early `return { ok: false, error }` that ignored the
work already in `transcript`. With five sequential calls at a 120s ceiling
each, losing one is routine — but losing one lost all of them.

Notably `council.ts` already had the right instinct (`// Synthesis failed —
return the raw member verdicts so the caller gets something`). Debate never
got the same treatment. Sibling modules drifted.

**Fix**

A `bail()` helper returns completed rounds via a new `partial` field.
`index.ts` prints `partial` to **stdout** (so redirects still capture it) and
then exits 1.

Deliberately still `ok: false`. The caller is often another coding agent, and
exit code 0 would tell it everything went fine.

**Files:** `src/debate.ts`, `src/index.ts`, `tests/debate.test.ts`

**Lesson**

Partial success is the normal case for any multi-call pipeline. Decide what
survives a failure *when you write the loop*, not after a user loses six
minutes. And when one module solves this well, check its siblings.

---

## Silence read as a hang — including to the person debugging it

**Date:** 2026-07-21 · **Severity:** medium — a conversion killer

**Symptom**

`--mode debate` printed nothing for 5–7 minutes.

During development this was diagnosed as a hang: process inspected with `ps`,
stdin handling audited for a missing-EOF bug, backend detection chain read
end to end. The tool was working correctly the entire time.

Someone who just installed it has none of that context. They hit ctrl-C.

**Root cause**

Output was written once, at the end. Nothing reported progress.

**Fix**

Per-turn progress to **stderr**:

```
── round 1/2: advocate …
── round 1/2: critic …
── synthesizing verdict …
```

stderr specifically, so `bpx-council … > out.md` still captures clean output
while a human at a terminal sees movement.

**Files:** `src/debate.ts`

**Lesson**

For anything over ~30 seconds, silence is a bug. If the developer who wrote
the thing mistakes it for a hang, a new user certainly will.

---

## `runDebate(rounds)` was unreachable from the CLI

**Date:** 2026-07-21 · **Severity:** low

**Symptom**

No way to shorten a debate. Always 2 rounds — 5 sequential calls — even for a
quick question.

**Root cause**

`DebateInput.rounds` existed and was honoured (capped at 4), but `index.ts`
called `runDebate(commonArgs)` and never passed it.

**Fix**

Added `--rounds <n>` and `--timeout <ms>`. The timeout flag exists because the
120s default is what killed the run documented above; it's now adjustable
without hand-writing a config file.

**Files:** `src/args.ts`, `src/index.ts`

**Lesson**

A parameter with no path from the CLI is dead code that reads as a feature.

---

## "Multi-model" was one model wearing three hats

**Date:** 2026-07-21 · **Severity:** high — the headline claim was false

**Symptom**

`--mode council` describes itself as running "several models in parallel, each
with a stance." Every reply came from the same model. Nothing in the output
said otherwise, so it looked like three advisors agreeing — when it was one
advisor asked three ways.

**Root cause**

`runCouncil` read a single backend and handed it to every persona:

```ts
const backend = (config.solo.backend ?? undefined) as BackendConfig | undefined;
personas.map((persona) => callCouncilMember(persona, userMessage, backend));
```

`Persona` had `name`, `stance`, `systemPrompt` — no model or backend field, and
no config path to give one. The mode was structurally single-model.

The word "multi-model" appeared in five places: the npm description, the README
H1, the GitHub repo description, the `multi-model` keyword, and this module's
own docstring. All five described behaviour the code could not perform.

**Fix**

Per-persona backend resolution, precedence `--backends` > `config.council.backends`
> shared default:

```bash
bpx-council --mode council --backends codex,claude,opencode "..."
```

Members carry the resolved model, and it appears in the output header
(`### critic [against] · claude`) so disagreement is attributable. Personas
without an assignment fall back to the shared backend, so existing configs
behave exactly as before.

**Files:** `src/council.ts`, `src/config.ts`, `src/detect.ts`, `src/args.ts`,
`src/index.ts`, `tests/council-routing.test.ts`

**Lesson**

This was found by asking "can it use codex?" — a question about *usage*, not
correctness. Reading the README and reading the code separately would not have
caught it; the two only conflict when you hold them side by side.

Any claim in a description is a testable assertion. "Multi-model," "parallel,"
"zero-config" — each is either true of the code or it isn't. Audit them the way
you'd audit a function's return value.

---

## Council also discarded its members' verdicts

**Date:** 2026-07-21 · **Severity:** medium

Same defect as debate mode, found while fixing the routing above: `runCouncil`
built a `members` array, returned it, and `index.ts` printed only
`synthResult.text`. Three personas argued and the user saw one paragraph.

Fixed alongside the routing — output is now the member transcripts followed by
`### Verdict`. Worth noting the pattern: **when two modes share a shape, a bug
in one is usually in the other.** Debate's transcript bug and council's were
the same bug, found six hours apart.

---

## Testing note: `index.ts` used to run on import

Importing `src/index.ts` executed `main()`, so any test touching it fired a
real CLI run and called `process.exit`. Arg parsing is now in `src/args.ts` —
pure in, pure out, no I/O — matching how `config.ts`, `detect.ts`, and
`backend.ts` are already split.

When adding tests, verify they **fail against the broken code first**. All
three debate regression tests were confirmed red before the fix; a test that
passes against the bug is worse than no test, because it certifies the bug.

---

## Templates existed, shipped nowhere, and two were in formats no host reads

**Date:** 2026-07-21 · **Severity:** high — the integration story was documented
but non-functional for every npm user

**Symptom**

`README.md` advertised templates for Claude Code, Codex, and AGENTS.md. Someone
installs with `npm i -g @booplex/bpx-council`, follows the README, and finds no
`templates/` directory. Even cloning the repo and hand-copying the files did
nothing: the agent never picked them up.

**Root cause**

Four separate failures stacked:

1. `package.json:files` was `["dist/", "prompts/", ...]`. No `templates/`, so
   nothing shipped. (`prompts/` didn't exist in the repo at all — dead entry.)
2. No installer, and the README never said where to copy the files to.
3. The Claude Code skill was a flat `skills/bpx-council.md` with a `trigger:`
   frontmatter field. Real skills are `skills/<name>/SKILL.md` with `name:` +
   `description:` — `trigger:` isn't a field, discovery runs off `description`.
   Wrong path *and* wrong schema, so it never registered.
4. `hooks-settings.json` opened with `#` comments (invalid JSON) and used
   `"Stop": [{type, command}]`. The real shape needs a wrapper:
   `"Stop": [{hooks: [{type, command}]}]`.

**Fix**

Added `bpx-council install` (`src/install.ts`, `src/agents.ts`) — interactive
wizard, `--agent/--scope/--yes/--dry-run` for CI. Added `templates/` to
`files`, dropped the phantom `prompts/`. Corrected both malformed templates.

Collapsed `templates/claude-code/skills/` and `templates/codex/SKILL.md` into
one `templates/skills/bpx-council/SKILL.md` — both hosts read the identical
format, so two copies were a drift mechanism, not a feature.

**Lesson**

Verify host conventions against a real installation, not from memory. All four
formats here were checked against actual files in `~/.claude/skills/`,
`~/.codex/skills/`, and a live `settings.json` before anything was written. A
template in the wrong schema fails silently — no error, no log line, the host
just never loads it. That's strictly worse than a crash.

---

## AppleDouble sidecars got copied into users' config directories

**Date:** 2026-07-21 · **Severity:** medium — pollutes user config; possible
host parse confusion

**Symptom**

Installing from a repo checked out on an external drive dropped a `._SKILL.md`
next to the real `SKILL.md` in `.claude/skills/bpx-council/`:

```
.claude/skills/bpx-council/._SKILL.md
.claude/skills/bpx-council/SKILL.md
```

**Root cause**

This repo lives on `/Volumes/MyEXT` (ExFAT). macOS can't store resource forks
natively there, so it writes AppleDouble `._name` sidecars beside every file.
`cpSync(src, dest, {recursive: true})` copies the whole tree, sidecars included.

Unit tests couldn't catch this — the merge logic was correct and pure. It only
showed up running the real binary against a real directory.

**Fix**

`isPlatformJunk()` in `src/install.ts`, wired into `cpSync`'s `filter`. Skips
`._*` and `.DS_Store`. Note `._*` was already in `.gitignore` and npm honours
that, so the tarball was clean — but a user installing from a clone on a
similar volume would still have hit it. Filtering at copy time is the fix that
doesn't depend on which ignore file happens to apply.

**Lesson**

Pure-function tests prove the logic; they don't prove the plumbing. Run the
built binary against a scratch directory before calling a filesystem feature
done. Use a fake `$HOME` when testing global-scope installs — `os.homedir()`
honours `$HOME` on POSIX, so `HOME=/tmp/sandbox node dist/index.js install
--scope global` exercises the real path without touching your own config.

---

## The installer ate AGENTS.md when a marker was orphaned

**Date:** 2026-07-21 · **Severity:** critical — silent user data loss

**Symptom**

Two consecutive `bpx-council install` runs against an `AGENTS.md` containing a
`bpx-council:start` marker with no matching `:end` deleted everything between
that marker and the newly-written block. Exit 0 both times, no warning.

Before:

```
<!-- bpx-council:start -->
half deleted

# IMPORTANT USER NOTES
keep me
```

After run 2, the entire file was our block. The notes were gone.

**Root cause**

`applyBlock` located the markers with two independent `indexOf` calls over the
whole file:

```ts
const start = existing.indexOf(BLOCK_START);
const end = existing.indexOf(BLOCK_END);
if (start !== -1 && end !== -1 && end > start) { /* replace */ }
// otherwise: append
```

With a start and no end, the guard failed and control fell to the **append**
path — leaving the orphan in place and adding a full block below the user's
content. Run 2 then found the orphan at position 0 and our new `:end` far
below, and replaced everything between them.

How a user gets an orphan marker: deleting the block by hand and missing a
line, resolving a merge conflict one-sided, a truncated write, or an AGENTS.md
that *documents* bpx-council with the markers inside a code fence.

The unit test `"treats a lone start marker as no marker and appends"` fed this
exact input, stopped after run 1, and asserted only that an end marker existed.
It codified the step that set up the loss.

**Fix**

Scope the end search to after the start (`indexOf(BLOCK_END, start + …)`), and
refuse on every malformed marker state — orphan start, orphan end, or more than
one block — returning a `failed` outcome that names the file and leaves it
byte-identical. Repairing automatically would mean guessing which text was the
user's.

Three sibling bugs in `mergeHookSettings` had the same shape and the same fix:
a non-object settings root got spread into `{"0":1,"1":2}`, a non-object `hooks`
got restructured, and a non-array `hooks.Stop` was substituted with `[]` and
then overwritten — silently deleting the user's hook. All now refuse.

**Follow-up: the first fix guarded the wrong input**

The initial fix scoped the end search to after the start and refused an orphan
start. A verification pass caught that this still lost data, on the one input
that actually mattered.

The broken build's run 1 produced `START … user content … START … BLOCK … END`
— orphan first, appended block second. The guard asked "is there another start
*after* the end", and there isn't: the second start sits *before* it. So all
three checks passed and the replace ran from the orphan straight through,
deleting the user's content in the middle.

The population holding a file in that state is precisely the people who ran the
broken build. The fresh orphan the first fix guarded was never the dangerous
input — it was the state run 1 left behind.

Real fix: count markers and require exactly one of each, in order. Anything
else refuses. "A well-formed pair exists somewhere" is not the same claim as
"this file contains exactly one block", and only the second one is safe to act
on.

**Lesson**

The bug wasn't the missing guard, it was the **default direction**. Every
unexpected-input path in that file fell through to a write; only the JSON-parse
error refused. For anything that edits files a user owns, unrecognised input
must fail closed by default, and the tests must assert *the file is unchanged*
rather than asserting the happy path still produced output.

Second lesson: a test that feeds malformed input and asserts only "it did
something" is worse than no test — it looks like coverage of the dangerous case
while pinning the dangerous behaviour in place. Run the damaging sequence
end-to-end (here: twice) and diff the file against its original bytes.

---

## Atomic writes detached symlinks and widened permissions

**Date:** 2026-07-21 · **Severity:** high — silent dotfiles breakage

**Symptom**

After switching the installer to atomic writes (tmp file + `rename`), two new
failures on every successful write:

1. A symlinked `AGENTS.md` or `~/.claude/settings.json` — the standard dotfiles
   pattern — was replaced by a regular file. The user's canonical file never
   received the block, later edits to it stopped showing up in the project, and
   `git status` in the dotfiles repo showed nothing wrong.
2. A `chmod 600` settings.json came back `644`.

**Root cause**

`renameSync` replaces the *directory entry*, so it swaps the symlink itself
rather than writing through it. The plain `writeFileSync` it replaced followed
the link correctly — the atomicity fix regressed a case the naive version got
right.

The mode change is the same shape: the tmp file is created fresh with
`0666 & ~umask`, and `rename` carries that mode onto the destination, silently
discarding whatever the user had set. `~/.claude/settings.json` is a plausible
home for API keys, so relaxing it to world-readable is a real exposure.

**Fix**

`realpathSync(dest)` before writing so the tmp file is placed next to the
*resolved* target and the rename lands on the real file; `chmodSync(tmp,
statSync(target).mode)` before the rename to carry permissions across.

**Lesson**

A fix that narrows a rare failure window can open a common one. The crash-mid-
write case this was guarding against is rare; symlinked dotfiles and non-default
permissions are not. When replacing a write primitive, enumerate what the naive
version was implicitly getting right — following links, preserving mode, keeping
ownership — because `rename` preserves none of it.

---

## Reinstall appended a second Stop hook for `npx`-style commands

**Date:** 2026-07-21 · **Severity:** medium — silent double cost per turn

**Symptom**

With an existing Stop hook running `npx bpx-council --mode gut-check …`, a
re-run of `install --with-hook` appended a second entry. The user then paid for
two council calls on every turn, and the output reported a normal install.

**Root cause**

Idempotency detection went through two wrong versions in a row, failing in
opposite directions:

1. `JSON.stringify(entries).includes("bpx-council")` — false *positives*. An
   unrelated hook like `cd ~/dev/bpx-council && make` read as "already
   installed", so the hook was never added.
2. First token of each `[;&|]`-delimited segment — false *negatives*. Missed
   `npx bpx-council`, `bunx`, `pnpm dlx`, `BPX_COUNCIL_MODEL=opus bpx-council`,
   `sh -c "bpx-council …"`, quoted forms, and `bpx-council.cmd` on Windows.

**Fix**

Walk each segment past leading `VAR=value` assignments and known wrappers
(`npx`, `bunx`, `sh`, `env`, `pnpm dlx`, …), then check whether the token in
command position names the binary — comparing basenames with Windows
extensions stripped.

**Lesson**

"Does this string mention X" and "does this command run X" are different
questions, and substring matching answers neither. Where a heuristic must
remain, aim its residual error at the recoverable outcome: a duplicate hook is
visible and reversible, a skipped install is merely annoying, and neither is a
deleted file.

---

## Link mode: a data-destroying helper guarded only by its caller

**Date:** 2026-07-22 · **Severity:** medium (latent — not reachable in shipped code)

**Symptom**

`linkDir(canonical, dest)` with `dest === canonical` deleted the canonical skill
copy and left a dangling self-referential symlink. Every agent link pointing at
it then dangled.

**Root cause**

`linkDir` replaces a real directory at `dest` after checking
`treeDiffers(canonical, dest)` — but `treeDiffers(x, x)` is `false` (a thing
doesn't differ from itself), so the "matches canonical, safe to replace" branch
ran `rmSync(dest)` on the canonical itself, then symlinked it to nothing.

Not reachable through `buildGroups`, which special-cases `dest === canonical`
into a copy action. But `linkDir` is the one function in the installer that can
delete a directory, and its only protection lived in the caller. One careless
registry entry whose skill dest resolves to `.agents/skills/bpx-council` (easy
at global scope) would have armed it.

**Fix**

A one-line guard at the top of `linkDir`: `if (dest === canonical) return
unchanged`. Defense-in-depth on the function itself, not the caller.

**Lesson**

If a function can destroy data, its safety check belongs *inside* it, not in the
code that happens to call it today. Callers get refactored; the destructive
primitive outlives them. This is the same principle as the fail-closed rule for
settings.json — the guard travels with the hazard.

Also: `treeDiffers(x, x) === false` is a correct answer to the wrong question.
"Does the destination match the source" quietly assumes they're different paths.
When source and target can be the same, test identity before difference.
