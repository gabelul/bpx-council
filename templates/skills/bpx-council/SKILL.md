---
name: bpx-council
description: >
  Get a second opinion from a stronger model, or a multi-model council that
  argues, before committing to a direction. Use when facing an architecture
  decision, weighing two approaches, stuck on a bug you've been circling, or
  about to declare something done. Also use when the user says "second
  opinion", "council", "gut check", "am I overthinking this", "sanity check
  this", "what would another model say", or asks whether an approach is sound.
---

# bpx-council — a second opinion on the calls that matter

You run on one model. That model has one set of instincts, and asking it the
same question three times gets you the same instincts three times. `bpx-council`
puts a different model — or three of them, disagreeing — on the handful of
decisions that actually determine how the thing turns out.

## Modes

**Solo** (default) — one strong second opinion. Seconds.

```bash
bpx-council "Is this auth flow sane?"
```

**Gut check** — terse. For "does this smell off?" without a full writeup.

```bash
bpx-council --mode gut-check "We're storing sessions in localStorage"
```

**Council** — three personas in parallel (architect, critic, simplifier), then a
synthesized verdict. Minutes, not seconds. For real decisions.

```bash
bpx-council --mode council "Monolith or microservices for this service?"
```

**Debate** — advocate vs critic over sequential rounds, then a verdict. For
contentious calls where you want the strongest case on both sides.

```bash
bpx-council --mode debate --rounds 2 "Rewrite the parser, or patch it?"
```

## Feeding it context

Pipe anything on stdin and it gets prepended to the question. This matters —
an advisor reasoning about the actual diff beats one reasoning about your
summary of the diff.

```bash
git diff HEAD~3 | bpx-council --question "Review this for correctness"
cat src/auth.ts | bpx-council --question "Any security holes here?"
```

## Going genuinely multi-model

By default all three council personas share one backend: three stances, one
model. Assign different backends and you get actually different instincts.

```bash
bpx-council --mode council --backends codex,claude "Should we ship this?"
```

Backends map to personas in order. Each verdict is labelled with the model that
produced it, so you can see who argued what.

## When to reach for it

- Before an architecture decision you'd have to unwind later
- When you've been circling the same bug for a while
- Before declaring a task done — a final review pass
- When the user is asking you to pick between two approaches and you don't have
  a strong reason for either

## How to treat the answer

It's an advisor, not an authority. Take it seriously — a different model
catching something you missed is the entire point. But if your own evidence
contradicts it, trust your evidence and say so. Don't launder a council verdict
into certainty you don't have.

Progress goes to stderr and the verdict to stdout, so `> out.md` captures clean
output.
