# Agent integration

Installing the CLI teaches *you* that the council exists. It teaches your
agent nothing, because agents discover what they can do from files in their
own config tree. So there's a command that puts those files there:

```bash
bpx-council install
```

It checks which agents are actually on your machine, asks what to wire up and
whether you want it for this project or globally, shows you the plan, and
waits for a yes before writing anything.

| Agent | What it gets | Where |
| --- | --- | --- |
| Claude Code | Skill and `/council` command | `.claude/` (project) or `~/.claude/` (global) |
| Codex | Skill | `.agents/skills/` (project) or `~/.agents/skills/` (global) |
| OpenCode | Skill and `/council` command | `.opencode/` (project) or `~/.config/opencode/` (global) |
| Shared skill (manual choice only) | Compatibility copy for hosts that read project `.agents/skills/` | `.agents/skills/` |
| Agents reading `AGENTS.md` | Instruction block | project root |

The shared option is never auto-detected. Select it explicitly if your host
reads that path. Choosing it with Codex writes one skill, not two; choosing it
(or Codex) with OpenCode keeps OpenCode's command but avoids a duplicate
project skill. Older global Codex installs at `~/.codex/skills/bpx-council`
are reported, not migrated or removed. `AGENTS.md` uses a marker-delimited
block; malformed markers are refused rather than guessed at. Reinstall
refreshes known files, but refuses skill directories with extra entries or
foreign symlinks instead of claiming success. Clear drift manually; `[blocked]`
in the plan names affected paths.

If your agent isn't on the list, it can still run `bpx-council` in a shell.
The templates live in `templates/` if you'd rather place them yourself.

## Headless, for dotfiles and CI

```bash
bpx-council install --dry-run                              # show the plan, write nothing
bpx-council install --agent claude-code --scope global -y
bpx-council install --link                                 # one canonical copy, symlinked
bpx-council install --verify --agent claude-code            # offline artifact check
bpx-council uninstall --agent claude-code --dry-run         # inspect removal
bpx-council uninstall --agent claude-code --yes             # remove exact owned files
```

## Link mode (`--link`)

By default each agent gets its own copy of the skill. With `--link`, one
canonical copy lives at `.agents/skills/bpx-council`; hosts needing a separate
skill path link to it. Codex uses the canonical copy directly, and OpenCode
can discover that shared copy without a second skill. It's the same scheme
[vercel-labs/skills](https://github.com/vercel-labs/skills) uses. Copy is the
default because symlinks are fragile across Windows, committed git trees, and
Docker builds; on Windows link mode uses a junction, and any link that can't
be made falls back to a copy automatically. An agent dir you've *edited* is
never replaced by a link. It's left alone with a note.

One caveat: reinstall refreshes known files at the canonical path. Extra
entries or links block reinstall, and `--verify` reports edited content as
`drifted`. Treat the canonical copy as a distribution point, not a fork.

## Removal and drift

`uninstall` uses the same agent and scope selection. Dry-run never prompts;
noninteractive mutation needs `--yes`. It removes only template-identical
files and skill trees with no extras, or links to the canonical copy. Marker
blocks must match the current or bundled legacy text exactly. Edited
artifacts stay put and produce a nonzero result; other owned artifacts can
still be removed.

A link-only uninstall leaves the real `.agents/skills` copy in place, since
Codex or another host may use it without a link. When it is the last link,
the command exits nonzero and names the retained copy; explicitly select
`codex` or `agents-skills` to remove it.

`--with-hook` fails without writing: an every-Stop paid consult was too easy
to trigger without a deliberate question. Existing hooks aren't removed by
install. `uninstall` removes only an exact bundled legacy Stop entry, leaving
unrelated hooks and settings alone. Edited or malformed entries are refused.

`--verify` reports missing, drifted, or current per selected host without
authentication or a model call; binary availability isn't checked.

## What integration is not

This integration installs instructions and commands; it doesn't add native
host execution or host-harness cost tracking. Consult receipts report
provider usage where available, with unknown CLI usage marked unknown.

For keeping the npm package and the agent files in step, see
[Updating](getting-started.md#updating).
