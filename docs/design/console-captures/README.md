# Implemented console captures

These are real terminal-cell captures from the built CLI, rendered with pyte,
Pillow and a monospace font. They are not generated mockups or desktop screenshots.
Backend names, versions, prompts and connection outcomes are synthetic fixtures;
no provider accounts were used.

- [Workbench](workbench.png): centered 112×15 window on a 220×60 terminal.
- [Local backend check](backend-check.png): fixed 80×24 dialog; all nine rows visible.
- [Backend picker](backend-picker.png): shared editor window and muted parent focus.
- [Save confirmation](save-confirmation.png): matching frame and safe Cancel default.
- [NO_COLOR confirmation](no-color-confirmation.png): 40×12, no leaking parent text.
- [Persona preview](persona-preview.png): staged candidate, not a saved persona.

Reproduce with `scripts/qa-console-layout.py`; set `BPX_QA_FONT` outside macOS.
The script needs Python pexpect, pyte and Pillow. `BPX_QA_CLI` and `BPX_QA_NODE`
select an isolated packed CLI or alternate Node runtime.
