# Console design

## Reference and scope

Gabi approved `docs/design/backend-check-dialog.png` and asked to apply the same
visual language across the interactive configuration workbench. CLI stdout,
headless commands, backend transports and installer semantics remain unchanged.

## Theme

An operator configures advisor routes in a large desktop terminal, then may shrink
it while editing. Use a focused DOS window rather than flooding the whole terminal
with blue. Flat ANSI surfaces only; do not reproduce generated image shading.

- Surround: charcoal `#151820` when terminal has spare space.
- Window: DOS navy `#000080`; text light gray/white.
- Borders: light neutral, double-line outer window; restrained single separators.
- Active selection/key hints: amber `#ffd787` with readable dark text when filled.
- Backend identities: Codex/OpenAI mint `#87ffd7`, Claude/Anthropic peach `#ffaf87`,
  Pi lavender `#d7afff`, OpenCode cyan `#87ffff`; other identities neutral.
- Success, warning, error and waiting always have literal status words.

## Typography

Use caller's fixed-width terminal font. Hierarchy comes from position, blank rows,
color and bold, not font-size changes. Measure Unicode display cells, not string
length. Never alter stored values merely to make a label fit.

## Layout

- Center a bounded main workbench, cap 112 columns × 32 rows. Sparse screens
  should use only the height their fields and navigation need, not an empty blue slab.
- Retain sidebar/detail panes and remembered keyboard focus.
- Editors, confirmations and running operations use the same centered bordered
  window language, bounded dialog widths around 80 columns where practical.
- Backend check: current probe and checked-step count, determinate segmented bar,
  aligned backend/status rows, no-model-calls note and local cancellation footer.
- Model calls: indeterminate spinner; do not pretend elapsed time is progress.
- On narrow/short terminals remove margins/padding before important content.
- Render and keyboard PageUp/PageDown must share actual visible-row budgets.

## Behavior constraints

Keep existing staged Review/Save/discard, safe-default confirmations, Enter-only
paid/destructive actions, Left/Right pane navigation and input caret ownership.
Busy dialogs trap all keys except cancellation and wait for actual cleanup before
returning/exiting 130. Resize must not remount an editor or reset its caret. All
color props pass through the existing NO_COLOR gate.

## Verification

Inspect real terminal captures at 220×60, 120×40, 80×24, 40×12 and 20×8, including
idle, picker, progress, confirmations and persona preview. Geometry assertions
must check boundedness/centering and active-row visibility, not just copy. Use
fake accounts/CLIs or explicit isolated localhost fixtures, never user accounts.
