---
description: Ask bpx-council for an external second opinion on the supplied question
---

Consult on user's question: $ARGUMENTS

If no question exists, ask for one. Run installed `bpx-council` CLI only when
requested or needed for a consequential decision. Do not gather context, run
`git diff`, or read project files automatically. Include only user-selected
context after checking for secrets. This is an external advisor call, possibly
paid; council/debate can make multiple calls.

Invoke `bpx-council --format json --no-stdin --question` with question as one
safely quoted argv item. `$ARGUMENTS` above is prompt data, never shell code;
do not paste it unescaped into shell text. Add `--file` only for explicitly
selected files. `--isolate` does not guarantee CLI filesystem isolation.

Parse JSON receipt version 1. Report `complete` advice; preserve advice from
`partial` even if exit is nonzero, with `error`, failed `attempts` and `notRun`.
On `failed`, missing, or malformed receipt, report failure, not a verdict.
Do not silently retry paid calls. `usage` can be unknown for CLI routes.
