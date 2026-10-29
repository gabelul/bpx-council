# Demo capture

`council-demo.gif` — the animated council walkthrough used in the README.

Scripted demonstration: everything on screen (layout, colors, progress
lines, verdict assembly) is the built CLI rendered from real PTY cell grids,
but the advisor replies are staged fixtures printed by fake
codex/claude/opencode binaries, with artificial delays so the parallel
progress is visible. No provider account is touched.

Reproduce with:

```bash
pip install pyte pexpect pillow   # plus ffmpeg on PATH
python3 scripts/qa-demo-gif.py
```

The script refuses to encode unless the CLI exits 0 and every expected seat
and verdict heading appears in the captured terminal output and the final
replayed screen. `--keep` preserves the work directory with the raw terminal
output.

For real model output, see the [examples](../examples/) — those transcripts
come from live runs.
