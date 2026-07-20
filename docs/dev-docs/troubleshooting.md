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

## Testing note: `index.ts` used to run on import

Importing `src/index.ts` executed `main()`, so any test touching it fired a
real CLI run and called `process.exit`. Arg parsing is now in `src/args.ts` —
pure in, pure out, no I/O — matching how `config.ts`, `detect.ts`, and
`backend.ts` are already split.

When adding tests, verify they **fail against the broken code first**. All
three debate regression tests were confirmed red before the fix; a test that
passes against the bug is worse than no test, because it certifies the bug.
