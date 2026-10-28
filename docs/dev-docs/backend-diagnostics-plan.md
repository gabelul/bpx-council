# Backend diagnostics follow-up

User requested clear backend labels and an option checking installed CLIs.
Implemented and verified locally; see config-workbench-qa.md.
No publication/global replacement authorized.

- Add Backends between Debate and Preferences; shortcuts become 1–8.
- Inventory includes every known CLI, including absent/unusable entries, plus
  stock Anthropic API key presence. Presence is not a login or model test.
- Check installed CLIs is an explicit cancellable action using allowlisted
  version commands, bounded output/time and a private cwd. Unknown/manual
  commands can be located but are never executed by a guessed version preset.
- Config startup and npm postinstall spawn no version/model calls. Manual install
  shows inventory and offers optional local version checks before integration.
- Backend picker uses current installation state, not blanket login warnings.
  Manual entry reads Enter backend manually… and explains CLI/route vs API key.
- Test connection uses existing configured-route confirmation and real abort
  cleanup. Successful version check is not connection success. Unsupported model
  tests show Not supported, not Failed. Generation restrictions stay unchanged.
- Results are session-local; editing a route invalidates its connection receipt.
  A response is labeled with requested route and latency, not model attestation.
- Preserve staged Save/Discard, headless behavior, project restrictions, editable
  fields, NO_COLOR and cleanup before process.exit.

Shared service contract in src/backend-diagnostics.ts:

BackendDiagnostic: name, label, kind (cli/http), status
(installed/missing/unusable/key-present/key-missing), optional path/version/detail,
check (not-checked/version-found/failed/unsupported/cancelled/not-applicable).

BackendDiagnostics.inventory(extraNames?) is filesystem/environment presence only.
BackendDiagnostics.check(signal, onUpdate?, extraNames?) returns final rows and
emits immutable partial snapshots. No auth-file reads or model requests.

Verification: fake CLIs/account HOME only, full suites under Node 20/22/24,
source/packed real terminal tests, native Pi explicitly selected and localhost-only.
CLI startup may migrate its own global settings even for metadata requests; don't
promise that private cwd or --version makes third-party startup write-free.
