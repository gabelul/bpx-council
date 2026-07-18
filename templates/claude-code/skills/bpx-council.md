---
description: Get a second opinion or multi-model council before committing to a direction
trigger: second opinion, council, advisor, should I, gut check, before I ship
---

# bpx-council — AI advisor council

When you need a second opinion or want multiple AI models to weigh in on a decision, run `bpx-council`:

## Quick second opinion

```bash
bpx-council "Is this auth flow secure?"
```

## Full council (multiple models debating)

```bash
bpx-council --mode council "Should I use microservices or a monolith for this project?"
```

## With context from the codebase

```bash
cat src/auth.ts | bpx-council --question "Review this auth module for security issues"
```

## When to use this

- Before committing to an architecture decision
- When stuck on a bug you've been circling
- Before declaring a task done (final review)
- When you're about to write something and want a sanity check on the approach

The council runs advisor models in the background and returns a concrete recommendation. Take it seriously — but if your own evidence contradicts it, trust your evidence.
