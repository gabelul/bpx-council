# Pi model runtime for Council

Plan approved, 2026-10-08. The proof passed for lower-level `pi-ai`, and the local checkout now implements Council-owned direct SDK accounts/routes on Node >=22.19. The planning sequence below records that decision, not a pending dependency change. Nothing is published or installed globally; tests use synthetic accounts and loopback providers.

I'd keep Council's interface and orchestration, and use Pi's provider/auth machinery underneath an explicitly selected route. Council ships its own pinned SDK dependencies and owns its provider configuration and credential storage. No separately installed Pi executable is required. We don't need to start a coding agent just to ask a model for an opinion.

## Implementation gate update

The isolated published-package fixture found that `ModelRuntime` can issue inference using an ambient `OPENAI_API_KEY` despite an explicit empty Council credential store and `modelsPath: null`. That fails Council's independent-account boundary. It is not the selected production layer.

The lower-level public `pi-ai` `createModels({ credentials, modelsStore, authContext })`, with explicit provider registration and an auth context refusing ambient environment/files, passed the initial missing-own-credential and exact-own-key loopback checks. This still uses Pi's provider and OAuth implementations, not copied provider code. OpenAI API-key and Anthropic API-key/OAuth gates passed under loopback confinement. SDK native cancellation returned before refresh writes finished, so Council adds its own operation-wide credential/storage drain. Production uses strict owned stores, fresh collections, account-generation and credential-version fences, trusted endpoints and no ambient auth. Evidence and reproducible runner are under `scripts/sdk-proof/`; broader providers remain unadmitted.

## Supported pieces

Pi 1.1.0 publicly exports `ModelRuntime` from `@earendil-works/pi-coding-agent`. Its installed published declarations show that it implements pi-ai's `Models`, with `getModel`, `getModels`, availability/auth operations, `streamSimple` and `completeSimple`.

`ModelRuntime.create()` defaults to Pi's global file-backed credentials and model configuration. Council must override those defaults with Council-owned storage, while reusing the supported credential resolver and coordinated OAuth refresh rather than extract or copy tokens. Existing Pi configuration reuse is an optional future convenience, not the default. Direct model calls avoid creating an `AgentSession`: no need for project resource discovery, sessions, coding tools or CLI output parsing.

This is not a guarantee of zero local side effects. Credential/catalog storage can create locks/files; refresh can write rotated credentials. Command-backed credential configuration can execute helpers even without agent tools. Catalog initialization defaults to no network model refresh, but later refresh and availability calls need explicit policy. Model metadata must be allowlisted before exposing it; never return raw configuration headers or credentials in receipts.

Pi Durable's published 1.1.0 `HarnessOptions` requires `models: Models`. `ModelRuntime` is structurally that bridge, passed explicitly. Durable does not automatically read coding-agent credentials. Its plain pi-ai `createModels()` examples don't establish Pi auth reuse.

## First step I'd take

A separate, pinned Node >=22.19 prototype using the public pi-ai model/provider layer, synthetic auth/model stores and a loopback-only provider. Keep Council's current Node >=20 installation and existing CLI routes unchanged while proving:

- Exact provider/model, effort and persona reach the request, with no tool declarations.
- Streaming text, bounded output, errors and aborted responses are handled explicitly.
- Cancellation settles without a later request or hidden retry.
- Synthetic OAuth refresh coordinates and persists safely, including its cancellation behavior.
- No project resources are discovered and no credentials appear in receipts/logs.

Do not use the user's real global defaults simply to inspect the API. Do not import an SDK from the user's managed global Pi path as a supported application design.

Gabi approved Node >=22.19 for the SDK-enabled Council release, plus both API keys and SDK-supported subscription/OAuth login. Adopt that baseline after the standalone proof passes; the current package and CI remain unchanged during this planning phase. A compatibility worker is not part of the plan. Dynamic import alone wouldn't make a Node >=22.19 dependency install correctly under Node 20 with engine-strict.

Both authentication categories are in scope, not every provider's subscription. Record which published SDK flows actually support each provider. Unsupported subscription routes retain explicit CLI alternatives; never substitute API billing.

Existing Codex/Claude CLI routes must not silently turn into Pi provider routes. Authentication, model alias resolution and billing can differ. Reusing Pi credentials only gives access to providers those credentials support; it does not turn API billing into subscription billing or change provider restrictions.

## Implementation sequence

1. **Standalone SDK proof.** Pin pi-ai 1.1.0 in an isolated test fixture. Empty HOME, no Pi/Claude/Codex executables on PATH, synthetic Council-owned stores and network confined to a mock localhost provider. Prove direct calls, exact pins, errors, output bounds, cancellation and coordinated credential refresh. Measure install/startup footprint before committing to the heavier coding-agent SDK dependency rather than lower-level pi-ai plumbing.
2. **Provider and credential layer.** Add a small Council SDK runtime module with explicit storage paths, a supported provider/auth capability inventory and allowlisted model metadata. An own auth file alone does not block ambient environment/cloud credentials: prove that an unconfigured Council account cannot silently consume host credentials. Initial scope excludes command-backed credential helpers. Keep API keys/tokens out of route config, receipts and logs; sanitize SDK errors, which may contain credential objects.
3. **Explicit route schema and transport.** Extend existing backend types/validation with a distinct direct-SDK route; do not reinterpret `pi`, `claude` or `codex` CLI assignments. Add SDK dispatch behind `src/backend.ts`, preserving HTTP/CLI routes, inheritance, unmanaged config fields and existing automatic-selection behavior. Adopt Node >=22.19 and pinned dependencies only after the proof gate.
4. **Council-owned setup.** Extend the current workbench with direct providers alongside installed CLI backends. Provide supported API-key entry and OAuth login/logout, account status, auth-aware model choices and explicit connection tests. Secrets need concealed entry. Login/logout persist separately from staged routing: Review/Save/Discard must not pretend account actions were rolled back. Project config cannot author credentials or choose arbitrary credential-store paths.
5. **Existing mode integration.** Use the existing Solo, Council and Debate orchestration with the new transport. Preserve completed answers after seat/synthesis failure, exact model attribution and cleanup-awaited cancellation. Extend `src/models-list.ts` and `src/config-actions.ts`; frozen confirmations and session receipts must account for authentication changes as well as model/effort changes. Model lists and auth checks do not independently establish paid inference success or model identity.
6. **Fresh-install acceptance.** Pack/install into a clean isolated prefix without any advisor CLI. Test mocked setup/login/refresh, model selection, Solo and mixed SDK/CLI Council, failed synthesis retaining completed answers, cancellation and terminal restoration. Check old config preservation and multi-process credential refresh. Real provider/subscription verification requires separately authorized, bounded account tests; no automatic paid startup or install probes.

Likely integration points: `src/backend.ts`, `src/config-validation.ts`, `src/detect.ts`, `src/config-draft.ts`, `src/models-list.ts`, `src/config-actions.ts`, the workbench and package/CI metadata. Keep transport/auth details in sibling modules rather than add another agent harness to `src/index.ts`.

Refresh cancellation needs its own gate: the published auth resolver may let an already-started refresh persist under a timeout even after the caller stops waiting. A returned cancellation is not proof that credential writes have settled. Verify this before making cleanup guarantees.

First deliverable is the standalone SDK proof, not an immediate migration of existing routes. Publishing, global installation and private account access remain separate actions.

## Where Durable fits

[Pi Durable](https://earendil.com/posts/pi-durable/) adds persistent conversations/tasks, crash recovery and owned cancellation. That could be useful for a Council job surviving a process restart while retaining completed seat answers. It doesn't solve authentication or the unidentified Claude-host failure.

The package is experimental. Storage has one process owner and no cross-process locking. Interrupted model requests can be sent again after recovery: submission deduplication is not exactly-once inference, and a replay can consume quota again. Council needs an explicit recovery/cost policy before using this behavior. Start with direct model calls unless resumable/background jobs are part of the requested product.

## Evidence

- Installed published coding-agent 1.1.0: `dist/core/model-runtime.d.ts`, public SDK exports and package engine metadata. SDK docs describe heavier `createAgentSession()` defaults.
- [Versioned ModelRuntime implementation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/model-runtime.ts): runtime creation, model/auth resolution and direct generation methods.
- [Versioned credential refresh](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/resolve.ts): locked refresh and persistence.
- [Versioned Durable README](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md): experimental status, recovery and single-owner storage.
- npm registry `@earendil-works/pi-durable` latest is 1.1.0, requiring Node >=22.19. Downloaded tarball SHA512 matched registry integrity. Published `dist/harness/types.d.ts` confirms `HarnessOptions.models: Models`. Inspected artifact: `/tmp/bpx-pi-durable-package.SB2osb/package`.

The SDK-to-Durable bridge remains inspection-only. SDK inference/account tests now exercise lower-level public `pi-ai` directly; native CLI tests remain separate. See `sdk-standalone-qa.md` for the final implementation evidence and explicit limits.
