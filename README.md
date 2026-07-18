# bpx-council — a portable multi-model council CLI

A council of AI advisors you can call from any coding agent — Claude Code, Codex, Cursor, pi, or a terminal. One model for a quick second opinion, several debating when the call is hard. The same advisor concept as [bpx-consult](https://github.com/gabelul/bpx-mono/tree/main/packages/bpx-consult) (the pi extension), extracted into a standalone CLI that works everywhere.

## Why

Your coding agent runs on a cheap, fast model most of the time, and most of the time that's the right call. The trouble is the handful of moments that actually decide how the thing turns out: the architecture choice, the "should I even build this," the bug it's been circling. That's where you want a stronger model's judgment — or several, debating — before you commit.

bpx-council is that judgment, callable from anywhere. It pipes your question (and optionally your conversation context) to advisor models and returns a concrete recommendation.

## Install

```bash
npm install -g @booplex/bpx-council
```

Or run without installing (requires `npx`):

```bash
npx @booplex/bpx-council "Should I use REST or GraphQL for this API?"
```

## Usage

```bash
# Quick second opinion (solo mode — default)
bpx-council "Is this auth flow sane?"

# With conversation context piped in
git diff HEAD~3 | bpx-council --question "Review this diff for correctness"

# Full council (multiple models in parallel, each with a stance)
bpx-council --mode council "Architecture: monolith or microservices?"

# Debate mode (advocate vs critic, sequential rounds)
bpx-council --mode debate "Rewrite the parser, or patch it?"
```

## How it works with each agent

bpx-council is a CLI — any agent that can run shell commands can use it. For deeper integration, each supported agent has a template in the `templates/` directory:

- **Claude Code:** skill (trigger-word activation) + slash command + Stop hook (auto-trigger on turn end)
- **Codex:** SKILL.md (auto-activation via description matching) + AGENTS.md
- **Cursor / Copilot / Aider:** AGENTS.md instruction snippet
- **pi:** the [bpx-consult](https://github.com/gabelul/bpx-mono/tree/main/packages/bpx-consult) extension (deeper integration — auto-triggers, steer, interactive menu)

## Config

`~/.bpx-council.json`:

```json
{
  "defaultMode": "solo",
  "solo": {
    "model": "codex",
    "backend": { "type": "cli", "command": "codex", "timeoutMs": 120000 }
  }
}
```

The default uses the `codex` CLI (authed via your ChatGPT subscription — no API key needed). You can also configure `claude`, `opencode`, or (planned) HTTP backends for any provider.

---

Built by Gabi @ [Booplex.com](https://booplex.com). MIT license.
