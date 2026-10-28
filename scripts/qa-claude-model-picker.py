"""Verify Claude models are selectable by arrows, with no CLI probe or model request."""
import copy
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('workbench_qa', Path(__file__).with_name('qa-config-workbench.py'))
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def open_models(t, council=False):
    """Open actual model picker; observe presets without typing a search or model ID."""
    t.section(3 if council else 1)
    if council:
        t.open('critic')
    t.open('Model')
    t.wait('Claude aliases')
    t.send('\x1b[H')
    for alias in ['sonnet', 'opus', 'haiku']:
        assert alias in t.text, t.text
    assert 'Catalog empty/unavailable' not in t.text, t.text
    assert t.count() == 0
    t.unchanged()


def retained_and_cancelled():
    """Opening/cancelling keeps exact saved custom pin and produces no subprocess calls."""
    t = qa.Terminal('claude-presets-retained', columns=80, rows=24)
    open_models(t, council=True)
    assert 'critic-model' in t.text, t.text
    t.send(qa.ESC)
    assert 'critic-model' in t.text, t.text
    t.abort()
    assert t.count() == 0
    print('PASS Claude presets visible without typing; saved custom pin and bytes retained; no probes/calls; stty restored')


def council_save():
    """Choose Opus by keyboard and save only selected Council seat after confirmation."""
    t = qa.Terminal('claude-presets-save')
    open_models(t, council=True)
    t.open('opus')
    t.wait('UNSAVED')
    assert t.count() == 0
    t.unchanged()
    t.section(7)
    t.open('Save')
    t.wait('Save changes?')
    t.send(qa.RIGHT)
    t.send(qa.ENTER)
    t.close()
    expected = copy.deepcopy(qa.FIXTURE)
    expected['council']['backends']['critic'] = 'claude:opus'
    assert json.loads(t.config.read_text()) == expected, t.config.read_text()
    assert t.count() == 0
    print('PASS arrows/Enter select Opus; explicit Save changes critic only; zero CLI probes/model calls; stty restored')


def narrow_discard():
    """Choose Haiku without typing at 40x12/NO_COLOR; dirty discard preserves original bytes."""
    t = qa.Terminal('claude-presets-narrow', columns=40, rows=12, color=False)
    open_models(t)
    t.open('haiku')
    t.wait('UNSAVED')
    assert 'haiku' in t.text, t.text
    assert all(cell.fg == 'default' and cell.bg == 'default' for row in t.screen.buffer.values() for cell in row.values())
    t.section(8)
    t.open('Discard & exit')
    t.wait('Exit configuration?')
    t.send(qa.DOWN)
    t.send(qa.DOWN)
    t.send(qa.ENTER)
    t.close()
    t.unchanged()
    assert t.count() == 0
    print('PASS narrow NO_COLOR Haiku selection uses no typed ID; explicit discard retains bytes; zero calls; stty restored')


if __name__ == '__main__':
    print('Evidence:', qa.ROOT, 'CLI:', qa.CLI)
    try:
        retained_and_cancelled()
        council_save()
        narrow_discard()
    finally:
        for terminal in qa.ACTIVE_TERMINALS:
            if terminal.child.isalive():
                terminal.child.send('\x03')
                terminal.pump(1)
                terminal.child.close(force=True)
                terminal.log.close()
