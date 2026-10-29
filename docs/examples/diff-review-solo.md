# Example: reviewing a diff with Solo

Unedited output from:

```bash
git diff 3611c50^ 3611c50 > probe-fix.diff
bpx-council --question "Review this diff for correctness and any failure modes
  it introduces or misses. The change raises a CLI smoke-probe timeout from
  10s to 20s because deep-thinking models take 7-11s even for trivial replies." \
  --file probe-fix.diff --no-stdin
```

- **Route:** `sdk:openai-codex:gpt-6-astra@xhigh` (direct SDK, ChatGPT
  subscription login)
- **Receipt:** status `complete` · 1 call attempted, 1 reported · 450 input /
  1166 output tokens
- **Run:** 2026-10-29, bpx-council 2.3.0, reviewing its own doctor-probe fix

The diff under review (`src/doctor.ts`, +3/−1): the CLI probe bound changes
from `timeoutMs: 10_000` to `timeoutMs: 20_000`.

---

**PLAN — Keep the increase; no obvious correctness bug in this hunk.** A 20s budget reasonably accommodates observed 7–11s responses, but remains a heuristic.

Check these points:

- **Broader impact:** Every CLI smoke probe gets 20s, not just xhigh models. A hung CLI now delays diagnosis by another 10s per timed-out probe.
- **Configuration precedence:** This unconditionally overwrites `solo.timeoutMs`, including shorter user limits. That behavior already existed, but the increase amplifies it. Confirm this is intentional; the SDK branch instead preserves shorter limits with `Math.min`.
- **Other deadlines:** Trace the CLI invocation path for any outer 10s watchdog that would negate this change. Verify timeout cancellation actually terminates the process and any spawned children.
- **Remaining false negatives:** Cold starts, queueing, authentication, and variable reasoning time can still exceed 20s. Report this as "probe timed out," not definitive evidence of a broken route. SDK probes remain capped at 10s.
- **Regression tests:** Using controlled timers/process stubs, verify a reply after 11s succeeds, a nonresponsive CLI is terminated at 20s, and other backend budgets remain unchanged.
- **Formatting:** Align both comment lines with the final ternary branch; their indentation currently differs.

Avoid treating the observed 7–11s range as a guaranteed upper bound.

---

Worth noting what the advisor did here: it accepted the premise, then poked
at the seams — the SDK branch's different `Math.min` behavior, the missing
outer-watchdog check, and the comment indentation, which the human reviewer
(who wrote the diff an hour earlier) had also missed. The `--format json`
receipt for the same run records the route, effort, and token usage, so the
example can be cited without trusting the terminal scrollback.

Other examples:

- [A three-model council on a CI question](council-three-models.md) —
  including a member dying mid-run and the council shipping without it
