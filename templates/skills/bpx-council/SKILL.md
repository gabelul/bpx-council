---
name: bpx-council
description: >
  Ask an external advisor for a second opinion when the user requests one, or
  when a consequential decision needs an independent check. Use only for the
  specific question at hand; never launch a consult after every turn.
---

# bpx-council

Use the installed `bpx-council` CLI for an advisory call. It is not a native
host tool: the host runs an external process, which may call paid providers.
Do not call it automatically after every turn.

Pick one mode for the question: `solo` (default) for a second opinion,
`gut-check` for a brief reaction, `council` for parallel stances and a
synthesized verdict, or `debate` for sequential opposing rounds. Council
personas share a backend unless routes are assigned separately; don't call
that multi-model by default. Larger modes can make several paid calls.

Ask a narrow question. Include only context the user selected or authorized
for this consult. Don't read or send a repository, file, diff, chat history,
secrets, or images merely because they are available. Never run `git diff`
automatically. If context is necessary but not specified, ask which paths or
excerpt to share. An explicitly chosen text file can be passed with
`--file <path>`; check it for secrets first. `--isolate` changes certain
backend project-instruction behavior, not filesystem access or CLI sandboxing.

Pass question as one argument using the host's safe argv execution if
available. With a shell tool, quote/escape it as shell data; never place raw
user text or `$ARGUMENTS` into a command string. Use `--no-stdin` when no
explicitly selected stdin context exists, avoiding inherited open pipes.
For a machine-readable result, run:

```text
bpx-council --format json --no-stdin --question <one safely quoted question argument>
```

Read JSON receipt (`schemaVersion: 1`). Check `status` (`complete`,
`partial`, `failed`), `advice`, `error`, `attempts`, `notRun`, and `usage`.
Nonzero exit may still carry a `partial` receipt with useful advice; don't
discard stdout on failure. Treat `failed` or missing/invalid receipt as no
verdict, report error, and don't silently retry paid calls. Token usage is
provider-reported where available; unknown CLI usage is not zero cost.
Use advisor output as evidence to consider, not authority. Say when local
facts contradict it.
