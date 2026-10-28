"""Real PTY direct-provider UI QA. SDK facade synthetic; network forbidden."""
import importlib.util
import json
import os
from pathlib import Path
import shlex

MODULE = Path(__file__).with_name('qa-config-workbench.py')
spec = importlib.util.spec_from_file_location('terminal_qa', MODULE)
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)
PRELOAD = Path(__file__).with_name('sdk-qa') / 'preload.mjs'
KEY = 'fixture-sdk-key-never-print'
CODE = 'fixture-oauth-code-never-print'


def terminal(name, **kwargs):
    """Inject only synthetic SDK facade; use production UI/controllers and CLI."""
    previous = os.environ.get('NODE_OPTIONS')
    os.environ['NODE_OPTIONS'] = '--import=' + shlex.quote(str(PRELOAD))
    try:
        return qa.Terminal(name, **kwargs)
    finally:
        if previous is None:
            os.environ.pop('NODE_OPTIONS', None)
        else:
            os.environ['NODE_OPTIONS'] = previous


def account_rows(t):
    """Read synthetic persisted accounts, separate from config routing."""
    file = t.home / '.bpx-sdk-ui-fixture' / 'accounts.json'
    return json.loads(file.read_text()) if file.exists() else {}


def operations(t):
    """Read only safe fixture operation metadata."""
    file = t.home / '.bpx-sdk-ui-fixture' / 'operations.jsonl'
    return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []


def direct(t, provider='OpenAI'):
    """Open nested direct-provider account setup through public keyboard flow."""
    t.section(5)
    t.open('Direct providers')
    t.open(provider)
    t.wait('API key')


def api_key(t, key=KEY):
    """Submit masked key explicitly and require immediate account-only receipt."""
    t.open('API key')
    t.wait('Enter saves literal input')
    t.send(key)
    assert key not in t.text and key not in t.raw
    t.send(qa.ENTER)
    t.wait('Account change saved.')
    assert key not in t.raw
    t.unchanged()
    t.send(qa.ENTER)


def persist_and_route():
    """Account save survives config Discard; route/test/save remain explicit."""
    t = terminal('sdk-key-route')
    direct(t)
    assert not account_rows(t)
    api_key(t)
    assert account_rows(t)['openai']['key'] == KEY
    assert not any(row['type'] == 'call' for row in operations(t))
    t.section(1)
    t.open('Backend')
    t.open('Direct: OpenAI')
    t.open('Model')
    t.open('gpt-sdk-fixture')
    t.unchanged()
    t.open('Test this route')
    t.wait('Quota/cost: 1 call(s)')
    t.send(qa.ENTER)
    assert not any(row['type'] == 'call' for row in operations(t))
    t.open('Test this route')
    t.send(qa.DOWN)
    t.send(qa.ENTER)
    t.wait('Response received')
    calls = [row for row in operations(t) if row['type'] == 'call']
    assert len(calls) == 1 and calls[0]['model'] == 'gpt-sdk-fixture' and calls[0]['provider'] == 'openai'
    t.send(qa.ESC)
    t.section(8)
    t.open('Discard & exit')
    t.wait('Exit configuration?')
    t.open('Discard & exit')
    t.close()
    t.unchanged()
    assert account_rows(t)['openai']['key'] == KEY
    assert KEY not in t.raw
    print('PASS SDK masked account-only persistence, explicit model/test, safe-default cost cancel, staged discard; stty restored')


def picker_return_save():
    """Setup launched from backend picker restores focus without assigning route."""
    t = terminal('sdk-picker-return')
    t.send(qa.RIGHT)
    t.open('Backend')
    t.open('Add direct provider')
    t.open('OpenAI')
    api_key(t)
    t.wait('Add direct provider')
    t.unchanged()
    t.open('Direct: OpenAI')
    t.open('Model')
    t.open('gpt-sdk-fixture')
    t.section(7)
    t.open('Save')
    t.wait('Save changes?')
    t.send(qa.DOWN)
    t.send(qa.ENTER)
    t.close()
    saved = json.loads(t.config.read_text())
    assert saved['solo']['backend']['type'] == 'sdk'
    assert saved['solo']['backend']['provider'] == 'openai'
    assert saved['solo']['backend']['model'] == 'gpt-sdk-fixture'
    assert KEY not in t.config.read_text() and KEY not in t.raw
    assert not any(row['type'] == 'call' for row in operations(t))
    print('PASS setup returns to picker, no implicit route, explicit SDK Advisor/model/Review Save without secret config; stty restored')


def oauth_cancel():
    """Manual URL and callback masked; Escape awaits cleanup before return."""
    t = terminal('sdk-oauth-cancel')
    direct(t, 'Anthropic')
    t.open('Claude subscription')
    t.wait('Open manually')
    t.wait('Paste OAuth code')
    t.send(CODE)
    assert CODE not in t.raw and CODE not in t.text
    t.send(qa.ESC)
    t.wait('Cancelled; no account change reported.')
    assert any(row['type'] == 'login-cleanup' for row in operations(t))
    assert not account_rows(t)
    t.send(qa.ENTER)
    t.abort()
    print('PASS SDK OAuth manual URL, masked callback, Escape cleanup, no account/config changes; stty restored')


def narrow_no_color_logout():
    """Narrow no-color fields and Cancel-first local removal remain usable."""
    t = terminal('sdk-narrow-no-color', columns=40, rows=12, color=False)
    direct(t)
    t.open('API key')
    t.send(KEY)
    assert KEY not in t.raw
    t.send(qa.ENTER)
    t.wait('Account change saved.')
    t.send(qa.ENTER)
    t.open('OpenAI')
    t.open('Remove local account')
    t.wait('Remove local account')
    t.send(qa.ENTER)
    assert account_rows(t)['openai']['key'] == KEY
    assert all(cell.fg == 'default' and cell.bg == 'default' for row in t.screen.buffer.values() for cell in row.values())
    t.send(qa.ESC)
    t.abort()
    assert KEY not in t.raw
    print('PASS 40x12 NO_COLOR key mask and Cancel-first logout, config untouched; stty restored')


def tiny_key_warning():
    """20x8 keeps immediate persistence warning above masked input."""
    t = terminal('sdk-tiny-key', columns=20, rows=8, color=False)
    t.section(5)
    t.send(qa.ENTER)
    t.send(qa.ENTER)
    t.send(qa.ENTER)
    t.wait('Enter saves NOW.')
    t.wait('No draft undo.')
    t.send(KEY)
    assert KEY not in t.raw and KEY not in t.text
    t.send(qa.ESC)
    assert not account_rows(t)
    t.abort()
    print('PASS 20x8 persistence warning visible before key entry, masked input/cancel/no writes; stty restored')


def oauth_interrupt():
    """Ctrl-C rejects pending prompt, waits service drain, exits 130."""
    t = terminal('sdk-oauth-interrupt')
    direct(t, 'Anthropic')
    t.open('Claude subscription')
    t.wait('Paste OAuth code')
    t.send(CODE)
    t.send('\x03')
    t.close(130)
    assert any(row['type'] == 'login-cleanup' for row in operations(t))
    assert not account_rows(t)
    assert CODE not in t.raw
    t.unchanged()
    print('PASS SDK OAuth Ctrl-C prompt rejection/awaited cleanup/130/no secret echo; stty restored')


if __name__ == '__main__':
    print('Evidence:', qa.ROOT, 'CLI:', qa.CLI)
    try:
        persist_and_route()
        picker_return_save()
        oauth_cancel()
        narrow_no_color_logout()
        tiny_key_warning()
        oauth_interrupt()
    finally:
        for item in qa.ACTIVE_TERMINALS:
            if item.child.isalive():
                item.child.send('\x03')
                item.pump(3)
                item.child.close(force=True)
