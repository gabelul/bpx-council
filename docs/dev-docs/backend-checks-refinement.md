# Backend-check feedback

Gabi requests obvious loading/progress, no navigation or edits while checks run,
failed choices not appearing healthy in selectors, and an actual Codex prompt test.
User approved normal read-only Codex basic tests. Implemented and locally verified;
see config-workbench-qa.md. Not globally installed or published.

## Visible busy state

Current keyboard handler already blocks navigation/editing during operations, but
underlying highlight and ordinary pane make the lock unclear. Show a blocking DOS
progress dialog, disable background highlights, emit start/finish state per CLI and
show current program plus completed/total. Keep recent application-generated status
rows only, never raw CLI stdout/stderr. Escape cancels; Ctrl-C cancels then exits,
both await cleanup. Restore exact prior focus and preserve draft/bytes.

## Selector states

Missing/unusable programs must not be ordinary new assignments; current saved route
must remain preserved and visibly unavailable. Don't present failed checks as healthy.
A version parser failure alone must not blacklist a functioning CLI: label version
unavailable/unchecked. Model connection failure belongs to the exact tested model/
effort/route, not every model from that backend. Keep failures in diagnostics with
retry/configuration, without deleting settings or claiming login failure from an
unknown version format.

## Codex basic connection test

Existing doctor probe already sends a tiny prompt through normal read-only Codex
execution. Workbench currently shares stricter eligibility between connection tests
and AI persona generation, blocking both. Split purposes before enabling anything.
Proposed basic test: fixed Reply OK prompt, selected unsaved model/effort, private cwd,
project instruction suppression, explicit quota confirmation, bounded response and
real AbortSignal cleanup. Keep custom args, project inheritance and ambient override
refusals; never substitute another backend/model. Strict generation policy unchanged.

Important distinction: Codex read-only does not disable all tools. Private cwd and
no intentionally supplied project content do not prove filesystem/MCP tools cannot
access outside it. User explicitly selected this normal-permission basic-test mode; UI
must disclose it without claiming tool-free isolation. No real paid/account test
by the coding assistant as part of implementation/QA.
