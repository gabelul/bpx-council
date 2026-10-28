# Workbench hierarchy and missing settings flows

Scope confirmed by Gabi: manual and AI-assisted persona creation, nested seat
settings, seating and explicit route tests. Implemented locally and verified;
see config-workbench-qa.md. No real provider-account calls or publication.

## Why this change

Council currently exposes three route fields for every member plus the verdict.
The next workbench should show seats first, then one seat's details. Gabi also
asked for model testing and persona creation, using the original bpx-consult
workflow as a reference rather than copying its code or immediate-save behavior.

## Reference findings

`../bpx-mono/packages/bpx-consult/src/consult-ui.ts` contains:

- Council overview and member detail submenus (`buildCouncilMenu`,
  `runCouncilSubmenu`, `runMemberDetail`).
- Seat/unseat while keeping persona definitions and assigned routes.
- Manual and AI-generated persona creation, with generated drafts reviewed
  before acceptance (`runGeneratePersona`).
- Candidate route tests, assigned route tests and sequential Test all members.
- Separate synthesizer settings.

The reference does not expose general prompt/stance editing, persona deletion or
member reordering. Those must not be described as existing Pi UI features.
Standalone config already supports trusted persona definitions, ordered members
and independent routes; current workbench does not expose those mutations.

## Proposed navigation

Council overview: one row per seated persona, showing stance and effective route.
Verdict gets its own entry; management/testing actions stay outside seat fields.

Right/Enter opens `Council > architect`, for example, with only that seat's
Backend, Model, Effort, Persona and Test route actions. Left/Esc returns one
level and restores row focus; text input arrows remain caret controls. Debate
uses its own seat overview too, without changing its route schema into persona
assignments. Sidebar, backend accents and safe Save/Exit dialogs stay intact.

## Persona tools

Separate definitions from seating. Add/edit persona name, stance and multiline
prompt; allow seating/unseating without losing definitions or route assignments.
Creation and edits remain in the existing draft until Review/Save. Name collisions
must not silently replace personas. Bundled overrides need explicit edit/reset
intent. Keep current persona/roster limits and project trust restrictions; custom
prompts belong only to global or explicit trusted config.

AI generation: describe focus, choose generator route, explicitly
confirm the paid call, then inspect/edit generated name/stance/prompt before
accepting into the draft. Regenerate/cancel must not mutate stored config.

## Model/route tests

Expose Test route for Advisor, Gut-check and each member/verdict/role. Test the
selected unsaved draft, including model, effort and inheritance, not the file's
previous settings. Existing `doctor --probe` is Solo-only and excludes Pi; do not
reuse it as though it supports every seat.

A test sends a small synthetic request only after explicit cost/quota confirmation.
Resolve and preflight exact route; use supported guarded transports, timeout,
bounded response and cancellable cleanup. If custom args or unsupported transports
cannot be probed safely, explain that instead of weakening protections or silently
changing the user's route. No workspace context or account secrets in results.

Show responding/failed/cancelled with latency and attempted route; a response is
not independent proof of model identity, persona quality or broad entitlement.
Keep status session-local and invalidate it on route edits. Test all lists the
number of calls before confirmation and retains completed results on cancellation.
Tests never implicitly save config. A qualitative persona preview is a separate
potential feature, not part of the minimum smoke-test contract.

## Verification after scope approval

Controller tests for nested focus, custom-name identities, exact draft preservation,
seating limits, persona validation and safe test dispatch. Mock transport tests for
unsaved route selection, inheritance, cancellation and partial results. Real PTY
checks for nested Left/Right/Esc, multiline editing, confirmation, narrow views,
Save/Discard and exact terminal restoration. No real-account calls by the agent.
