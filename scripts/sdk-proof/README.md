# Council SDK first hard gate

Proof only. No production dependencies, routes, config, UI or existing tests changed. All 64 prior changes hashed unchanged during recorded run.

## Run

Requires macOS with `/usr/bin/sandbox-exec`, Node >=22.19 and npm belonging to that Node installation. No advisor CLI or model account required.

```sh
node scripts/sdk-proof/run.mjs
```

Runner installs published 1.1.0 packages in a fresh temporary prefix with `--ignore-scripts --no-audit --no-fund`. Every installed Earendil dependency is pinned/verified at 1.1.0. Separate empty npm user/global configs prevent private npm configuration access. SDK children use copied Node executable, empty synthetic HOME/PATH, hostile synthetic ambient credentials and PI_CODING_AGENT_DIR sentinel fixtures. OS sandbox permits loopback only and denies real HOME/repository access. TCP IPv4/IPv6, TLS and UDP TEST-NET egress must fail with EPERM/EACCES before SDK import. No unsafe fallback. Native subprocesses are forbidden; sentinel filesystem operations are audited and rejected.

Optional `--prefix /absolute/new/temp/path` selects a fresh prefix outside real HOME/repo. Existing scenario state is rejected. Dependencies, lockfiles and detailed logs stay outside repository. New `qa.json` and `provider-matrix.json` contain safe observations only.

## Recorded result

Command above returned `CONDITIONAL-PASS-LOWER-LEVEL`; remaining requirement failures: none. This is first gate evidence, not production migration completion.

Latest logs/results:

```text
/var/folders/_d/zbfq7c8j5_91rkcjrdqf9g3r0000gn/T/council-sdk-proof-jcO422
```

See `qa.json` for exact command, package integrities, every assertion, startup samples, install footprint and absolute artifact paths. Main logs: `install.log`, `suite.mjs.log`, `ambient-probe.mjs.log`, `worker-0.log`, `worker-1.log`, `ai-only-install.log`, `ai-only/suite.mjs.log`. Raw mock observations: `suite-wire.json`. Full suite also ran against lower-only installation containing pi-ai and pi-telemetry, without coding-agent dependencies.

Three upstream failures remain explicit, not hidden:

- `ModelRuntime` with empty own credential store still dispatched mock `/v1/responses` using synthetic ambient OPENAI_API_KEY. Reject this integration boundary.
- ModelRuntime native abort returned while OAuth refresh/storage operation remained pending.
- Lower createModels native abort did the same. Public resolver deliberately finishes started token rotation/persistence under independent 15-second refresh timeout. Native aborted setup currently reports `stopReason: error`; service must classify cancellation from its own signal.

Own operation-scoped barrier passed abort during refresh before writes, and abort during persistence/unlock. Logout serialized against rotation without recreating account. Queued abort demonstrably attempted lock acquisition and produced no refresh/write or remaining lease. Two sandboxed workers both observed expired credentials, contended on OAuth lock, refreshed once, and preserved different-provider updates.

429/503 tests use supported `maxRetries: 0`; each produced one request. Positive `maxRetries: 1` produced two requests. Cancellation during configured 500ms retry backoff produced no later request after 1200ms observation. Static production catalog contract has no automatic network refresh.

## Viable service contract

Use public imports only:

```js
import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
```

Create collection with explicit Council-owned `credentials`, explicit `modelsStore`, and `authContext: { env: async () => undefined, fileExists: async () => false }`. Register explicit allowlisted factories. Never use ModelRuntime defaults, compat global registry, AgentSession, concurrent process.env mutation, command credentials or automatic catalog refresh.

Route fields: distinct SDK transport kind, exact SDK `providerId`, exact catalog `modelId`, supported model effort, output token budget. Resolve through `models.getModel(providerId, modelId)` and validate effort through `getSupportedThinkingLevels(model)`. No CLI aliases or implicit CLI-to-SDK conversion. Model endpoint comes from trusted factory/catalog; loopback overrides exist only in proof. Secrets stay outside route config.

Initial proof allowlist: `openai`, `anthropic`. Missing/incomplete own credential must reject before inference for each offered provider, even when SDK could resolve ambient auth. Reject cloud/unsupported factories initially. Deny arbitrary per-request apiKey/env/auth-header overrides. An authContext alone is not a guarantee that every provider SDK ignores native process environment.

Request uses Context.systemPrompt for selected persona, text messages, no tools, validated reasoning, maxTokens, explicit maxRetries:0 and owned AbortSignal/deadline. Consumer caps output bytes, aborts on limit, awaits terminal stream result, and emits only normalized status/usage/model attribution. Never serialize raw SDK error, cause, credential or headers. Proof verifies OpenAI gpt-5-mini API-key inference and Anthropic claude-sonnet-4-6 API-key/OAuth inference; Anthropic low effort maps to adaptive thinking and output_config.effort=low. Both request 16 output tokens, selected persona and zero tool declarations.

CredentialStore.read/list/modify/delete is supported public storage boundary. `modify` lease must register synchronously before first async boundary and cover lock acquisition, refresh callback, persistence and unlock. Lock whole shared credential file or otherwise preserve other-provider updates. Logout uses same lock. Started OAuth rotation must persist safely despite caller cancellation. Operation-scoped drain is separate from service-global shutdown drain. `storage.mjs` demonstrates this with AsyncLocalStorage scopes and cross-process directory lock; it is proof storage, not production crash-recovery implementation.

Login/logout use public Models.login/logout and published provider-owned auth handlers. Anthropic PKCE/state, token exchange, refresh and auth derivation executed unchanged; only exact token fetch endpoint remapped to loopback mock. No OAuth protocol rewritten, no real account request.

## Auth inventory versus verified routes

`provider-matrix.json` records 42 published factories, API-key login capability, OAuth login/refresh/toAuth descriptors and model API families. Offline descriptors are not verified Council routes.

| Provider | API-key descriptor | OAuth subscription flag |
| --- | --- | --- |
| anthropic | yes | true |
| github-copilot | yes | true |
| kimi-coding | yes | true |
| meta | yes | true |
| openai | yes | true |
| openai-codex | no | true |
| openrouter | yes | false |
| radius | yes | false |
| xai | yes | true |

Other factories expose API-key/ambient-auth descriptors, not OAuth handlers. Cloud/ADC/profile and provider-specific fields require separate admission tests. Only OpenAI API-key and Anthropic API-key/OAuth inference paths received successful mock wire verification here. No live login, subscription entitlement or billing claim follows from this inventory.

## Limits

Provider token budget and consumer output cap are proved; hostile single-frame/SDK queue memory bounds are not. Proof directory locks have no stale-lock/crash reclamation policy. OAuth refresh timeout bounds provider refresh, not an arbitrarily broken persistent store. Production storage must bound its own I/O and retain rotated credentials safely. No real-provider verification authorized or attempted. Repository build/test baseline was supplied by parent; this runner does not modify or rerun existing production tests.

Earlier harness failure was npm rejecting one file configured as both user/global config; separate files fixed it. Fresh-prefix runs passed after fix. Initial smoke artifacts remain in `/var/folders/_d/zbfq7c8j5_91rkcjrdqf9g3r0000gn/T/council-sdk-gate-_sgeqsn4`; failed install is not counted as passing evidence.
