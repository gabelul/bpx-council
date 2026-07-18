# bpx-council — Agent Reference

## overview

bpx-council is a standalone CLI that provides multi-model advisory/council capabilities to any coding agent. It's the portable version of the [bpx-consult](https://github.com/gabelul/bpx-mono/tree/main/packages/bpx-consult) pi extension.

## architecture

- `src/index.ts` — CLI entry point (arg parsing, stdin reading, dispatch)
- `src/config.ts` — config loading (~/.bpx-council.json)
- `src/solo.ts` — solo advisor mode (the prototype path; council/debate layer on later)

## conventions

- TypeScript, ESM, Node 22+
- `npm run dev` to run locally via tsx (no build needed)
- `npm test` runs vitest
- Conventional commits drive release-please (feat: minor, fix: patch)
- The README stays evergreen — no version-pegged claims that drift
