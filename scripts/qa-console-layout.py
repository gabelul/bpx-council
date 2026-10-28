"""Capture real PTY cell grids and verify bounded DOS windows with fake accounts only."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import time
from PIL import Image, ImageDraw, ImageFont

spec = importlib.util.spec_from_file_location('diagnostics_qa', Path(__file__).with_name('qa-backend-diagnostics.py'))
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)
qa = diag.qa
ARTIFACTS = Path(os.environ.get('BPX_QA_ARTIFACTS', str(qa.ROOT / 'console-captures')))
ARTIFACTS.mkdir(parents=True, exist_ok=True)
FONT_PATH = os.environ.get('BPX_QA_FONT', '/System/Library/Fonts/Menlo.ttc')
if not Path(FONT_PATH).is_file():
    raise SystemExit('Set BPX_QA_FONT to a monospace TTF/TTC font for terminal captures.')
FONT = ImageFont.truetype(FONT_PATH, 16)
CELL_WIDTH = round(FONT.getlength('M'))
CELL_HEIGHT = 22
COLORS = {'default': '#151820', 'black': '#10111b', 'white': '#e4e7ef', 'red': '#ff9580', 'green': '#87ffd7', 'yellow': '#ffd787', 'blue': '#000080', 'magenta': '#d7afff', 'cyan': '#87ffff', 'brown': '#ffd787', 'brightblack': '#afafd7', 'brightwhite': '#e4e7ef'}


def color(value, foreground=False):
    """Resolve VT cell color into RGB without reading terminal/account settings."""
    if value == 'default' and foreground:
        return '#e4e7ef'
    if re.fullmatch('[0-9a-fA-F]{6}', value):
        return '#' + value
    return COLORS.get(value, '#e4e7ef' if foreground else '#151820')


def capture(t, name):
    """Save actual emulator cell text/styles as PNG and plain text, not a generated mockup."""
    image = Image.new('RGB', (t.screen.columns * CELL_WIDTH, t.screen.lines * CELL_HEIGHT), '#151820')
    draw = ImageDraw.Draw(image)
    for y in range(t.screen.lines):
        for x in range(t.screen.columns):
            cell = t.screen.buffer[y][x]
            fg, bg = color(cell.fg, True), color(cell.bg)
            if cell.reverse:
                fg, bg = bg, fg
            px, py = x * CELL_WIDTH, y * CELL_HEIGHT
            draw.rectangle((px, py, px + CELL_WIDTH - 1, py + CELL_HEIGHT - 1), fill=bg)
            if cell.data.strip():
                draw.text((px, py), cell.data, font=FONT, fill=fg)
    image.save(ARTIFACTS / (name + '.png'))
    (ARTIFACTS / (name + '.txt')).write_text(t.text)


def windows(t):
    """Locate real double-border rectangles; background workspace and modal may coexist."""
    rectangles = []
    for y, line in enumerate(t.screen.display):
        for x, character in enumerate(line):
            if character != '╔':
                continue
            right = line.find('╗', x + 1)
            if right < 0:
                continue
            for bottom in range(y + 1, t.screen.lines):
                candidate = t.screen.display[bottom]
                if candidate[x:x + 1] == '╚' and candidate[right:right + 1] == '╝':
                    rectangles.append((x, y, right - x + 1, bottom - y + 1))
                    break
    return rectangles


def bounded(t, max_width, max_height, modal=False):
    """Assert window limits and balanced margins in the actual PTY, not only copy presence."""
    candidates = windows(t)
    assert candidates, t.text
    rect = min(candidates, key=lambda item: item[2] * item[3]) if modal else max(candidates, key=lambda item: item[2] * item[3])
    x, y, width, height = rect
    assert width <= max_width and height <= max_height, (rect, t.text)
    assert abs(x - (t.screen.columns - x - width)) <= 2, (rect, t.text)
    assert abs(y - (t.screen.lines - 1 - y - height)) <= 2, (rect, t.text)
    return rect


def resize(t, columns, rows):
    """Send real SIGWINCH through PTY and adjust emulator dimensions while retaining app input."""
    t.screen.resize(lines=rows, columns=columns)
    t.child.setwinsize(rows, columns)
    t.pump(.35)


def wide_editor_save():
    """Capture bounded idle/picker/text/Save and prove caret position survives narrow and wide resize."""
    t = qa.Terminal('console-wide', columns=220, rows=60)
    t.section(1)
    bounded(t, 112, 32)
    capture(t, 'wide-workbench')
    t.open('Backend')
    t.wait('Find:')
    bounded(t, 84, 32, True)
    capture(t, 'wide-backend-picker')
    t.send(qa.ESC)
    t.open('Model')
    t.send('abcdef')
    t.send(qa.ENTER)
    t.wait('Value: abcdef')
    t.send(qa.LEFT * 3)
    resize(t, 40, 12)
    t.wait('Value: abcdef')
    t.send('X')
    t.wait('abcXdef')
    capture(t, 'narrow-text-editor')
    resize(t, 220, 60)
    t.send('Y')
    t.wait('abcXYdef')
    bounded(t, 84, 32, True)
    capture(t, 'wide-text-editor')
    t.send(qa.ENTER)
    t.section(7)
    t.open('Save')
    t.wait('Save changes?')
    bounded(t, 84, 32, True)
    capture(t, 'wide-save-confirmation')
    t.send(qa.TAB if hasattr(qa, 'TAB') else '\t')
    t.send(qa.ENTER)
    t.close()
    assert json.loads(t.config.read_text())['solo']['backend']['model'] == 'abcXYdef'
    assert t.count() == 0
    print('PASS centered bounded idle/picker/text/Save, resize retains actual caret, explicit save only; stty restored')


def nine_versions(t):
    """Install nine synthetic version programs reproducing prototype's exact 6/9 state."""
    log = t.directory / 'versions.jsonl'
    names = ['codex', 'claude', 'pi', 'opencode', 'cursor-agent', 'gemini', 'qwen', 'crush', 'amp']
    for name in names:
        result = 'Unrecognized version format' if name == 'cursor-agent' else name + ' 1.2.3'
        code = 1 if name == 'gemini' else 0
        delay = 2300 if name == 'qwen' else 0
        file = t.directory / 'bin' / name
        file.write_text('#!' + str(qa.NODE) + '\n' +
            "const fs=require('node:fs');if(!process.argv.includes('--version'))throw new Error('not a version check');" +
            'fs.appendFileSync(' + json.dumps(str(log)) + ',JSON.stringify({name:' + json.dumps(name) + ",cwd:process.cwd(),pid:process.pid})+'\\n');" +
            'setTimeout(()=>{console.log(' + json.dumps(result) + ');process.exit(' + str(code) + ')},' + str(delay) + ');')
        file.chmod(0o755)
    return log


def wide_progress():
    """Capture centered status table and real six-of-nine progress without a model request."""
    t = qa.Terminal('console-progress', columns=220, rows=60)
    log = nine_versions(t)
    t.section(5)
    t.open('Check installed CLIs')
    t.wait('6/9')
    t.wait('CLI: qwen')
    bounded(t, 84, 30)
    assert 'Version unavailable' in t.text and 'Check failed' in t.text and 'Waiting' in t.text
    for name in ['codex','claude','pi','opencode','cursor-agent','gemini','qwen','crush','amp']:
        assert re.search(r'\b'+re.escape(name)+r'\s+│',t.text),t.text
    assert 'CONFIG WORKBENCH' not in t.text and 'Find:' not in t.text
    capture(t, 'wide-backend-check')
    t.send('3\t' + qa.RIGHT + qa.ENTER + 'typed')
    assert 'Local backend check' in t.text and 'Find:' not in t.text
    t.abort()
    diag.cleaned(log)
    assert t.count() == 0
    print('PASS centered 6/9 aligned progress/table, no underlying focus/edits, awaited cancellation; stty restored')


def narrow_cost_and_persona():
    """Keep Codex warnings/actions and long generated candidate Accept reachable at narrow sizes."""
    for columns, rows in [(40, 12), (20, 8)]:
        fixture = copy.deepcopy(qa.FIXTURE)
        fixture['solo']['backend'].update(command='codex', model='pin@literal', effort='ultra')
        t = qa.Terminal('console-cost-' + str(columns), columns=80, rows=24, color=False, fixture=fixture)
        t.section(1)
        t.open('Test this route')
        resize(t, columns, rows)
        t.wait('Quota/cost:')
        t.wait('read-only;')
        t.wait('tools may remain.')
        assert 'Cancel' in t.text and 'Backend' not in t.text,t.text
        assert 'codex:pin@literal@ultra' in ''.join(line.strip() for line in t.screen.display),t.text
        for line in t.screen.display:
            for char in line:
                assert char != '\x1b'
        assert all(t.screen.buffer[y][x].fg == 'default' and t.screen.buffer[y][x].bg == 'default' for y in range(t.screen.lines) for x in range(t.screen.columns))
        capture(t, 'cost-confirmation-' + str(columns))
        t.send(qa.ENTER)
        assert t.count() == 0
        t.abort()
    t = qa.Terminal('console-persona', columns=120, rows=40)
    t.section(3)
    t.open('Add persona')
    t.open('Manual persona')
    t.open('Name')
    t.send('security')
    t.send(qa.ENTER)
    t.open('System prompt')
    t.send('Review permissions.\rPrefer least privilege.')
    t.send('\x13')
    t.open('Preview')
    t.wait('Accept')
    bounded(t, 112, 32)
    capture(t, 'persona-preview')
    t.unchanged()
    t.abort()
    print('PASS narrow warning/buttons/NO_COLOR, candidate preview follows same window style; zero calls and stty restored')


if __name__ == '__main__':
    print('Artifacts:', ARTIFACTS, 'CLI:', qa.CLI)
    try:
        wide_editor_save()
        wide_progress()
        narrow_cost_and_persona()
    finally:
        for terminal in qa.ACTIVE_TERMINALS:
            if terminal.child.isalive():
                try:
                    terminal.abort()
                except Exception:
                    terminal.child.terminate(force=True)
