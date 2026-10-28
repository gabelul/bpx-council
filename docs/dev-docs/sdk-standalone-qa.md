# Standalone SDK acceptance

Locally implemented and verified, not released. Council now calls providers through pinned `@earendil-works/pi-ai@1.1.0` without a Pi installation. Existing CLI/HTTP/tmux routes stay separate; no account or billing transport is silently converted.

Initial direct providers: OpenAI API keys; Anthropic API keys and SDK OAuth. OAuth login/refresh tests use the published handler against synthetic exchanges. They do not prove a real account's subscription entitlement. OpenAI OAuth and other SDK providers are not admitted.

## Runtime and account boundary

`ModelRuntime` failed the empty-own-store gate by using an ambient OpenAI credential. Council instead uses public lower-level `createModels`, explicit provider factories, an in-memory static catalog and an auth context denying ambient/file fallback. No coding-agent session, project resources, tools, credential helpers or automatic catalog refresh.

Accounts live in Council's owner-only plaintext `~/.bpx-council/auth.json` (0700 directory, 0600 file), separate from staged route configuration. Explicit key/login/logout changes persist immediately. Configuration Discard cannot undo them. Secrets stay in concealed inputs; setup returns to the originating picker without assigning a route.

Storage rereads under a whole-file `proper-lockfile` lock, then checks ownership, account generation and credential version before atomic synced replacement. Tests cover same/different-provider writers, compromised late refresh, rotation/logout preservation, default HOME aliases, unsafe leaf/lock symlinks and malformed-file preservation. Started credential work drains before cancellation returns. A lock recovery does not repeat the provider refresh callback.

Cost confirmation freezes the original account generation through action dispatch, credential reads and HTTP admission. A changed account requires reconfirmation. Fresh model collections prevent warm credential reuse. Trusted stock endpoints and own headers override hostile vendor endpoint/org/project settings; unsupported debug/custom-header switches are refused. SDK inference retries are disabled.

## Final evidence

| Gate | Parent-verified result |
| --- | --- |
| Build/typecheck | Exit 0 |
| Node 24.21.0 full suite | 1045 passed, 59 files |
| Minimum Node 22.19.0 full suite | 1045 passed, 59 files |
| Node 22.22.1 full suite | 1045 passed, 59 files |
| Optional native CLI fixtures | Explicit Pi 1.1.0 and Codex 0.161.0; isolated credentials/loopback only |
| Fresh tarball install | Node 22.19.0, engine-strict, isolated prefix/HOME, scripts disabled |
| Production SDK through packed CLI | Three gate groups on Node 24 and 22.19; empty HOME/PATH without advisor executables |
| SDK account UI | Six real PTY scenarios on source and packed Node 24/22.19 |
| Existing console regressions | Ten nested/persona, three layout, five diagnostics and five progress scenarios |
| Packed code | All 52 emitted JS modules match build; validated AppleDouble metadata excluded |
| Runtime dependency audit | Zero vulnerabilities (`--omit=dev`), not a claim about dev dependencies |
| Diff whitespace check | Passed |

The production CLI fixture confines the child to loopback and denies subprocess creation with macOS sandbox-exec. It proves startup creates no account files, ambient-only auth yields zero requests, own OpenAI/Anthropic keys reach exact model/effort/token/tool-free requests, and provider 400/429/503 failures make one request with private JSON errors. It uses actual SDK factories, not a fake service.

The UI fixture deliberately injects a fake account service and blocks network. It covers masked immediate account persistence versus staged discard, setup return/model selection/explicit Save, exact-route tests and safe cost cancellation, manual OAuth Escape/Ctrl-C cleanup, 40x12 NO_COLOR/Cancel-first logout, and a 20x8 visible persistence warning before masked entry. Every scenario restores exact stty state. Combining these fixtures verifies UI and runtime contracts separately; it does not pretend to be a live login.

Native subprocess tests prove repeated SIGINT waits for synthetic OAuth rotation, mixed CLI descendant cleanup and slow stdout publication, retaining completed answers before exit 130.

## Bugs the larger fixtures caught

A loopback base URL hid pi-ai's stock OpenAI key classification: non-`sk-` synthetic keys were treated as ChatGPT OAuth and lost the token field. Stock-endpoint tests now retain bundled metadata, remap only test fetch, use realistic `sk-` fixtures and refuse unsupported OpenAI credentials before calling.

The old workbench test cap of eight tokens was below OpenAI's sixteen-token minimum. Generation's 2400 cap also broke legacy Anthropic thinking. SDK actions now keep the admitted configured/default ceiling and selected thinking, with quota/ceiling disclosure before consent. SDK Gut-check actions honor its saved budget. Real SDK action tests cover successful probes/generation and impossible budgets making zero requests. SDK doctor keeps the same ceiling with time/byte bounds and cleanup-aware SIGINT.

SDK initializes usage to zero after failures that reported no usage. All-zero counters now remain unknown; zero cache fields are omitted, while positive partial usage survives. Known resolved wire credential echoes and empty successful replies are rejected after terminal/storage drain. Failed response text is blanked because a truncated credential cannot be safely checked as a full string; completed other seats and earned usage survive.

OAuth callback tests share the SDK's fixed loopback port. Run runtime suites sequentially on one machine. Concurrent suite launches interfered with callback-closure assertions; isolated reruns and the final sequential matrix passed.

## Reproduce

```sh
npm ci --ignore-scripts
npm run build
npm test
node scripts/qa-sdk-standalone.mjs
```

The native standalone harness requires macOS sandbox-exec and refuses unconfined execution. Optional native CLI tests run only with explicit `BPX_TEST_PI_CLI` / `BPX_TEST_CODEX_CLI` paths; ordinary `npm test` skips them when unset.

Install `pexpect` and `pyte` in an isolated Python environment, then run `scripts/qa-sdk-providers.py`. `BPX_QA_NODE` selects the runtime, `BPX_QA_CLI` selects a packed entry. `qa-sdk-standalone.mjs` accepts a package root argument. No user account stores are needed.

Raw logs: `/tmp/bpx-sdk-final-{default,minimum,node22}-tests.log`, `/tmp/bpx-sdk-{ui-pty,packed-ui,packed-ui-minimum,packed-native,packed-native-minimum}.log`, `/tmp/bpx-sdk-{nested,layout,diagnostics,progress}-regression.log`, `/tmp/bpx-sdk-final-audit.json`. Logs are temporary; durable commands and assertions are in the repository scripts/tests.

## Limits that remain

Decoded inference bytes are capped before SDK parsing; visible/thinking/tool bytes have a separate consumer cap. This does not establish a peak-RSS, upstream single-chunk or SDK object-queue bound. The inference fetch hook does not cover SDK-owned OAuth response bodies; no OAuth body-byte ceiling is claimed.

A provider-side token rotation and disk commit cannot be one crash-atomic transaction. Reconnection may be required after a crash between them. Hung kernel/filesystem I/O cannot be transactionally cancelled; started persistence is awaited, not abandoned.

No real provider account, paid call, subscription entitlement or Windows account-store acceptance was tested. The unidentified original Claude-host CLI failure remains unconfirmed; these SDK fixtures do not retroactively diagnose it. Global Council installation and publication are separate, untouched actions.
