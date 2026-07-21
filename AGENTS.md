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
- `src/detect.ts` — backend auto-detection. Override chain: `--backend` >
  config > `*_API_KEY` env vars > CLIs on PATH > `codex`.

Modes:

- `src/solo.ts` — one advisor, one response. Also backs `gut-check`.
- `src/council.ts` — several personas in parallel, synthesizer merges.
- `src/debate.ts` — advocate vs critic, sequential rounds, then a verdict.
- `src/personas.ts` — stances and the synthesizer prompt.

Backends:

- `src/backend.ts` — spawns an advisor CLI, parses its output
- `src/http-backend.ts` — direct API calls (anthropic/openai/google)
- `src/pty-backend.ts` — tmux/PTY path for subscription-preserving calls

### Council is multi-model only when backends are assigned

`council` resolves a backend **per persona**: `--backends` (positional) >
`config.council.backends` (by persona name) > the shared `solo.backend`.

With no assignment every persona runs on the same model — three stances, one
model. That's a legitimate cheap mode, but it is *not* multi-model, and the
word shouldn't be used for it. The distinction was false for the project's
first three days; see troubleshooting.

The resolved model rides on each member and prints in its header
(`### critic [against] · claude`). Keep that — attribution is the reason to
pay for several models, and without it the output looks identical to the
single-model run.

### Multi-call modes: decide what survives a failure

`council` and `debate` make several sequential or parallel model calls. Any
one of them can time out — that's routine, not exceptional. Both modes return
whatever completed rather than discarding the run: `council` falls back to raw
member verdicts, `debate` returns completed rounds via `partial`.

Keep that property when editing either. Losing five minutes of good rounds to
one timeout is the single worst thing this tool can do to a user, and it has
already happened once.

## docs

- `docs/dev-docs/troubleshooting.md` — non-trivial bugs and their root causes.
  **Read it before debugging something that feels familiar**, and add to it
  when you fix something that took real investigation.

## conventions

- TypeScript, ESM, Node 22+
- `npm run dev` to run locally via tsx (no build needed)
- `npm test` runs vitest
- Conventional commits drive release-please (feat: minor, fix: patch)
- The README stays evergreen — no version-pegged claims that drift
