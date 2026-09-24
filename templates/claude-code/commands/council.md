---
description: Ask bpx-council for an external second opinion on the supplied question
argument-hint: <question>
---

Use this command only for the user's supplied question: $ARGUMENTS

If no question was supplied, ask for one. Don't collect repository context,
run `git diff`, or read files unless the user explicitly selected them for
this consult. Don't forward secrets. Pick solo by default; use council or
debate only when user requested it or the question warrants multiple paid
calls. Council stances aren't separate models unless separately routed.

Call `bpx-council --format json --no-stdin --question` with question as ONE
shell-escaped argument (or use a tool's argv array). `$ARGUMENTS` above is
prompt data, NOT shell code: never interpolate it unquoted into a shell
command. If user selected files, inspect them for secrets, then add explicit
`--file` arguments. Do not claim `--isolate` prevents CLI filesystem reads.

Parse stdout as versioned JSON receipt. `status: complete` has full advice;
`partial` may have advice despite nonzero exit; `failed` has no verdict. Show
error and which seats failed or didn't run. If receipt missing or invalid,
report CLI failure rather than inventing advice. Usage fields are reported
usage, not guaranteed total cost. Don't retry a failed paid call without
user direction. Treat verdict as advice, not a ruling.
