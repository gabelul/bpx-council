---
description: Run a bpx-council consult and include the verdict
---

Run a council consult on the user's question and report the verdict.

```bash
bpx-council "$ARGUMENTS"
```

If the question is an architecture or two-way decision rather than a quick
sanity check, use the full council instead — three models, three stances,
synthesized verdict:

```bash
bpx-council --mode council "$ARGUMENTS"
```

Treat the result as advice, not a ruling. If your own evidence contradicts it,
say so rather than deferring.
