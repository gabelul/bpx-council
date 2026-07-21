# Example: a three-model council

Unedited output from:

```bash
bpx-council --mode council --backends codex,claude,opencode \
  "Our test suite takes 40 minutes and it is blocking deploys. Do we
   parallelize it across more CI runners, or spend that same effort deleting
   slow integration tests we suspect are redundant?"
```

Two things worth noticing.

**The models genuinely disagree.** codex's architect argues for sharding with a
staged rollout. claude's critic rejects the framing outright — both options
answer "make the number smaller," neither answers "stop the number from gating
deploys." That gap is the reason to run different models rather than one model
with three stances.

**The third member died and the council shipped anyway.** opencode failed to
respond, so the run continued with two. The stderr log said so at the time:

```
── council: architect→codex, critic→claude, simplifier→opencode
⚠ simplifier (opencode) did not answer — continuing without it.
── synthesizing verdict …
```

That's the intended behaviour — a dead member costs you a perspective, not the
run. (The opencode failure was a real bug: its preset CLI args were a copy of
codex's. Fixed, though not yet verified end to end. See
`docs/dev-docs/troubleshooting.md`.)

---

### architect [for] · codex
Parallelize the suite across more CI runners now. Do not delete suspected-redundant integration tests as the primary fix.

A 40-minute deploy gate is an infrastructure throughput problem first. Sharding can cut wall-clock time quickly while preserving the regression coverage that protects production. Deleting tests based on suspicion trades a visible delay for an invisible reliability loss—and integration tests are exactly where redundancy is hardest to judge from names or code paths alone.

Make the investment concrete:

1. Split tests into deterministic shards using historical timing, targeting 8–12 minutes per shard. Balance by measured duration, not test count.
2. Keep one small, mandatory deploy gate: lint/typecheck/unit tests plus the highest-signal integration smoke tests.
3. Run the complete integration suite in parallel on merge/main and before release, with failure reporting that identifies the shard and test immediately.
4. Instrument before removing anything: collect per-test duration, failure history, code-path coverage, and whether each test catches a distinct contract.
5. Only then delete or merge tests that have demonstrated overlap. Treat this as a separate reliability-improvement project, not an emergency performance fix.

The stop condition is clear: deploy-critical checks consistently complete in under 15 minutes without reducing the set of validated production contracts. If runner cost or CI concurrency is genuinely unavailable, then prioritize profiling and consolidation—but still delete tests only with evidence of duplicate coverage, not intuition.

### critic [against] · claude
## The case against both, before the recommendation

**Parallelization is a treadmill with a floor you haven't measured.**

Amdahl's law eats this alive. If one integration test file takes 11 minutes, sharding across 20 runners gets you an 11-minute suite, not a 2-minute one. You have no idea where the floor is because nobody in the framing mentioned per-test timings — which means the honest answer to "how much faster does 4x runners make it?" is currently *unknown*. Spending a sprint on sharding to discover your critical path is 14 minutes is a real outcome.

It also gets worse over time in ways that are easy to miss:
- Setup cost multiplies. 3 minutes of container pull + install + migrate × 20 shards = 60 runner-minutes burned before a single assertion runs.
- Integration tests touch shared state. Sharding them surfaces every latent ordering dependency and DB contention bug at once, as **flakes**. A 40-minute deterministic suite blocks deploys predictably. A 25-minute suite that fails 6% of the time for no reason blocks them *unpredictably*, and people start re-running until green — which is how you lose the suite entirely as a signal.
- You now own sharding config as permanent infra. It needs rebalancing every time the suite grows.

**Deletion is worse, and "suspect" is the tell.**

"We suspect are redundant" is not evidence, and the failure mode is invisible. Delete a test, ship for six months, eat a production incident — nobody ever traces that back to the deletion. You get no feedback signal telling you that you were wrong. That asymmetry should terrify you more than 40 minutes does.

Two specific traps:
- **Coverage overlap is not redundancy.** Two tests hitting identical lines can assert entirely different things — one checks the endpoint returns 200, the other checks the transaction rolls back when the downstream call fails. Coverage tooling cannot tell these apart.
- Integration tests are slow *because* they test the wiring that unit tests structurally cannot reach. You'd be deleting from precisely the layer that catches the bugs that reach customers.

And the effort isn't bounded. Auditing a 40-minute integration suite for redundancy is an open-ended research project where every single call is a judgment with no ground truth.

## The framing itself is the biggest problem

"40 minutes" and "blocking deploys" are being treated as the same fact. They aren't. Ask what the *actual* p50 time-to-deploy is. If flakes force one re-run in five, your effective suite time is closer to 50 minutes — and neither option fixes that. If you run the full suite on every merge with no merge queue, ten merges a day means the pipeline is saturated regardless of duration.

Both proposals are answers to "make the number smaller." Neither is an answer to "stop the number from gating deploys."

## Concrete recommendation

**Split the pipeline by risk. Don't parallelize, don't delete — not yet.**

1. **Two days of instrumentation first.** Per-test duration and per-test flake rate over the last 30 days of CI runs. This is cheap and it's a prerequisite for either option being anything other than a guess. Expect the classic shape: ~15 tests owning ~70% of the runtime.

2. **Restructure the gate.** Unit + lint + typecheck become the blocking pre-merge gate, target under 10 minutes. The integration suite moves to post-merge against main, with alerting and an auto-revert path. This unblocks deploys *this week*, deletes nothing, and buys zero runners. You keep every test's signal — you just stop making it synchronous with shipping.

3. **Then attack the tail with real data.** The slowest handful of tests are usually slow for a dumb reason (a `sleep`, a missing index, a fixture rebuilt per-test instead of per-suite). Fixing five of those beats sharding all of them.

4. **Deletion last, with a real evidence bar.** For any test you want to cut, someone writes one sentence: what unique failure does this catch that nothing else does? If they can't, it goes. If you want rigor, mutation testing on the target module gives you actual evidence of redundancy. Coverage overlap does not.

**The trap to avoid:** step 2 turning into "integration tests run post-merge and nobody looks at the failures." That fails silently and you end up with no safety net *and* no deletion decision ever made. Post-merge failure has to page someone or auto-revert. If you can't commit to that, don't do step 2 — do step 3 alone and accept a slower fix.

The honest summary: parallelization buys time you haven't proven exists, deletion buys speed at a cost you can't observe, and the thing actually blocking your deploys is that a slow suite is on the critical path at all.

### Verdict
Don’t delete suspected-redundant integration tests, and don’t make runner sharding the first move.

The advisors agree on the key point: **“suspected” redundancy is not enough evidence to remove integration coverage.** The architect recommends preserving coverage and sharding; the critic goes further: first separate deploy-critical checks from the full integration suite, then use timing and flake data to fix the actual tail.

My call: **take the critic’s pipeline change first, then selectively optimize and shard.**

1. Instrument the suite for two days: per-test duration, setup time, retries/flake rate, and the actual p50/p95 deploy wait.
2. Make the blocking deploy gate under 10 minutes:
   - lint, typecheck, unit tests
   - a deliberately small set of high-signal integration smoke tests
3. Move the full integration suite to post-merge/main or a release gate only if failures have an owner plus alerting and an automatic rollback/revert path. If you cannot operationally support that response loop, keep it blocking and skip this step.
4. Fix the slowest tests first. Look for avoidable sleeps, repeated environment setup, serial database work, missing indexes, and unnecessary external-service waits.
5. Once timing data proves parallelism helps, shard the remaining full suite by historical duration, targeting roughly 8–12 minutes per shard. Validate isolation before expanding runner count, since shared state can turn a predictable 40-minute gate into flaky rerun churn.
6. Treat test deletion as a separate, evidence-backed cleanup. For every candidate, document its unique failure contract. Delete or merge it only when another test demonstrably protects that same contract; line coverage overlap alone does not prove redundancy.

The disagreement is about sequencing, not the safety principle:

- The architect says sharding is the fastest way to reduce wall-clock time while retaining protection.
- The critic says sharding may reveal a serial floor, multiply setup cost, and introduce shared-state flakes before you know whether it materially helps.

Both are right in their domains. Sharding is likely valuable after measurement, but changing what blocks deploys and attacking the slow tail is the fastest way to restore delivery flow without gambling on coverage.

**Stop condition:** deploy-critical validation is consistently below 10–15 minutes, full integration failures are actively handled, and no test is removed without a written contract-level redundancy case.
