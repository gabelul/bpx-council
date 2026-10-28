"""Real-terminal nested settings QA, isolated HOME and synthetic Claude only."""
import copy
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
import tempfile
import time
import pexpect
import pyte

REPO = Path(__file__).resolve().parents[1]
CLI = Path(os.environ.get('BPX_QA_CLI', str(REPO / 'dist/index.js')))
NODE_PATH = os.environ.get('BPX_QA_NODE') or shutil.which('node')
if not NODE_PATH:
    raise SystemExit('Node required for config workbench QA.')
NODE = Path(NODE_PATH)
ROOT = Path(tempfile.mkdtemp(prefix='bpx-nested-qa-'))
ACTIVE_TERMINALS = []
FIXTURE = {'defaultMode': 'solo', 'solo': {'backend': {'type': 'cli', 'command': 'claude', 'model': 'seed-model', 'effort': 'high', 'timeoutMs': 15000}}, 'council': {'members': ['architect', 'critic', 'simplifier'], 'backends': {'critic': 'claude:critic-model'}}}
RIGHT, LEFT, DOWN, UP, ESC, ENTER = '\x1b[C', '\x1b[D', '\x1b[B', '\x1b[A', '\x1b', '\r'

class Terminal:
    """Render VT frames and retain raw transcripts plus exact terminal state."""
    def __init__(self, name, columns=100, rows=30, color=True, fixture=None, project=False):
        """Start CLI with fake account HOME, fake backend and explicit terminal dimensions."""
        self.directory = ROOT / name
        self.directory.mkdir()
        self.home = self.directory / 'home'
        self.home.mkdir()
        binaries = self.directory / 'bin'
        binaries.mkdir()
        self.calls = self.directory / 'calls.jsonl'
        self.response = self.directory / 'response.txt'
        self.response.write_text('OK\n')
        self.delay = self.directory / 'delay.txt'
        self.delay.write_text('0')
        self.pid = self.directory / 'pid.txt'
        fake = binaries / 'claude'
        fake.write_text('#!' + str(NODE) + '\n' + '''const fs=require('node:fs'); let body=''; process.stdin.on('data', b=>body+=b); process.stdin.on('end', ()=>{fs.writeFileSync(process.env.BPX_FAKE_PID,String(process.pid));fs.appendFileSync(process.env.BPX_FAKE_CALLS, JSON.stringify({args:process.argv.slice(2),body,cwd:process.cwd()})+'\\n');const rawDelay=fs.readFileSync(process.env.BPX_FAKE_DELAY,'utf8');const delays=JSON.parse(rawDelay);const delay=Array.isArray(delays)?delays[fs.readFileSync(process.env.BPX_FAKE_CALLS,'utf8').trim().split('\\n').length-1]:delays;setTimeout(()=>{process.stdout.write(fs.readFileSync(process.env.BPX_FAKE_RESPONSE));},Number(delay));});\n''')
        fake.chmod(0o755)
        self.config = self.directory / ('.bpx-council.json' if project else 'config.json')
        self.original = json.dumps(fixture or FIXTURE, indent=2) + '\n'
        self.config.write_text(self.original)
        if project:
            (self.home/'.bpx-council.json').write_text(json.dumps(FIXTURE))
        env = {k:v for k,v in os.environ.items() if not any(word in k for word in ('API_KEY','TOKEN','SECRET')) and k not in ('FORCE_COLOR','NO_COLOR','BPX_TEST_PI_CLI','PI_CODING_AGENT_DIR','BPX_COUNCIL_MODEL','ANTHROPIC_MODEL')}
        env.update(HOME=str(self.home), PATH=str(binaries)+':/usr/bin:/bin', TERM='xterm-256color', TMPDIR=str(self.directory), BPX_FAKE_CALLS=str(self.calls), BPX_FAKE_RESPONSE=str(self.response), BPX_FAKE_DELAY=str(self.delay), BPX_FAKE_PID=str(self.pid))
        env['FORCE_COLOR' if color else 'NO_COLOR'] = '3' if color else '1'
        self.screen = pyte.Screen(columns,rows)
        self.stream = pyte.Stream(self.screen)
        self.vt_pending = ''
        config_args = ' config --scope project' if project else ' config --config '+shlex.quote(str(self.config))
        command = 'before=$(stty -g); ' + shlex.quote(str(NODE))+' '+shlex.quote(str(CLI))+config_args+'; result=$?; after=$(stty -g); if [ "$before" = "$after" ]; then restored=yes; else restored=no; fi; printf "\\nQA_EXIT=%s QA_RESTORED=%s\\n" "$result" "$restored"'
        self.child = pexpect.spawn('/bin/bash',['-c',command],cwd=str(self.directory),env=env,dimensions=(rows,columns),encoding='utf-8',timeout=10)
        ACTIVE_TERMINALS.append(self)
        self.raw = ''
        self.log = (self.directory / 'terminal.log').open('w')
        self.wait('bpx-council')

    def pump(self, seconds=.16):
        """Feed current frame, never match stale output."""
        until=time.monotonic()+seconds
        while time.monotonic()<until:
            try:
                data=self.child.read_nonblocking(65536,timeout=.04)
                self.raw+=data
                self.log.write(data)
                self.log.flush()
                self.feed_frames(data)
            except pexpect.TIMEOUT:
                continue
            except pexpect.EOF:
                return

    def feed_frames(self, data):
        """Commit synchronized Ink redraws atomically, including split marker bytes."""
        begin,end='\x1b[?2026h','\x1b[?2026l'
        self.vt_pending += data
        while self.vt_pending:
            start=self.vt_pending.find(begin)
            if start<0:
                keep=max((n for n in range(1,len(begin)) if self.vt_pending.endswith(begin[:n])),default=0)
                complete=self.vt_pending[:-keep] if keep else self.vt_pending
                self.stream.feed(complete)
                self.vt_pending=self.vt_pending[-keep:] if keep else ''
                return
            if start:
                self.stream.feed(self.vt_pending[:start]);self.vt_pending=self.vt_pending[start:]
            finish=self.vt_pending.find(end,len(begin))
            if finish<0:return
            self.stream.feed(self.vt_pending[len(begin):finish])
            self.vt_pending=self.vt_pending[finish+len(end):]

    @property
    def text(self):
        """Return visible frame instead of historical terminal output."""
        return '\n'.join(self.screen.display)

    def wait(self, text, timeout=7):
        """Require visible text from latest VT frame."""
        until=time.monotonic()+timeout
        while time.monotonic()<until:
            self.pump()
            if text in self.text:
                return
        (self.directory/'failure-screen.txt').write_text(self.text)
        raise AssertionError('Missing '+repr(text)+'\n'+self.text)

    def send(self, key):
        """Send one real key event, then observe current frame."""
        self.child.send(key)
        self.pump()

    def focus(self, label, limit=30):
        """Select list row by current pointer, wrapping manually with Home."""
        self.send('\x1b[H')
        for _ in range(limit):
            for y,line in enumerate(self.screen.display):
                x=line.find('► '+label)
                if x>=0:
                    cell=self.screen.buffer[y][x]
                    if cell.bg=='ffd787' or (cell.bg=='default' and cell.bold):
                        return
            self.send(DOWN)
        raise AssertionError('No selectable '+repr(label)+'\n'+self.text)

    def open(self, label):
        """Activate selected row with Enter, never a programmatic click."""
        self.focus(label)
        self.send(ENTER)

    def section(self, number):
        """Use workbench's public section shortcut."""
        self.send(str(number))

    def unchanged(self):
        """Check original config bytes, not only parsed object equality."""
        assert self.config.read_text()==self.original

    def count(self):
        """Count synthetic subprocess requests recorded by fake Claude."""
        return len(self.calls.read_text().splitlines()) if self.calls.exists() else 0

    def close(self, code=0):
        """Assert CLI waits for cleanup and exact stty restoration."""
        until=time.monotonic()+10
        while time.monotonic()<until:
            self.pump()
            if 'QA_RESTORED=' in self.raw:
                break
        assert f'QA_EXIT={code} QA_RESTORED=yes' in self.raw, self.raw[-3000:]
        (self.directory/'screen.txt').write_text(self.text)
        self.child.close()
        self.log.close()

    def abort(self):
        """Discard using Ctrl-C and require restored terminal plus original bytes."""
        self.send('\x03')
        self.close(130)
        self.unchanged()


def nested():
    """Only selected seat fields, nested arrows/refocus and independent Debate."""
    t=Terminal('nested')
    t.section(3)
    t.wait('architect')
    assert 'architect / Backend' not in t.text and 'critic / Model' not in t.text
    t.open('architect')
    t.wait('Model')
    assert 'critic-model' not in t.text, t.text
    t.send(LEFT)
    t.wait('critic')
    t.send(RIGHT)
    t.wait('Model')
    t.send(ESC)
    t.section(4)
    t.open('advocate')
    t.wait('Model')
    t.send(LEFT)
    t.wait('critic')
    assert t.count()==0
    t.abort()
    print('PASS nested Council/Debate arrows, focused seat isolation, zero advisor calls; stty restored')


def manual():
    """Create multiline persona, unseat without loss, save explicitly."""
    t=Terminal('manual')
    t.section(3)
    t.open('Add persona')
    t.open('Manual persona')
    t.open('Name')
    t.wait('Value:')
    t.send('security')
    t.send(ENTER)
    t.open('Stance')
    t.send('\x1b[H')
    t.send(DOWN)
    t.send(ENTER)
    t.open('System prompt')
    t.wait('Enter newline')
    t.send('Hunt security flaws.')
    t.send(ENTER)
    t.send('Explain concrete fixes.')
    t.send('\x13')
    t.open('Preview candidate')
    t.wait('security')
    t.unchanged()
    assert t.count()==0
    t.open('Accept into draft')
    t.wait('UNSAVED')
    t.open('Manage seating')
    t.open('security')
    t.open('Unseat persona')
    t.wait('Seat persona')
    t.unchanged()
    t.section(7)
    t.open('Save')
    t.wait('Save changes?')
    t.send(RIGHT)
    t.send(ENTER)
    t.close()
    expected=copy.deepcopy(FIXTURE)
    expected['personas']={'security':{'stance':'against','systemPrompt':'Hunt security flaws.\nExplain concrete fixes.'}}
    assert json.loads(t.config.read_text())==expected, t.config.read_text()
    assert t.count()==0
    print('PASS manual name/stance/multiline prompt, unseat retains definition, explicit Save; stty restored')


def generated():
    """Paid-call guard, generated collision, edit/accept then real dirty discard."""
    t=Terminal('generated')
    t.response.write_text(json.dumps({'name':'architect','stance':'neutral','systemPrompt':'Inspect security assumptions.\nRecommend concrete fixes.'}))
    t.section(3)
    t.open('Add persona')
    t.open('AI-assisted persona')
    t.open('Describe focus')
    t.wait('Enter newline')
    t.send('Security review for deployment decisions.')
    t.send('\x13')
    t.open('Generator route')
    t.open('Advisor')
    t.open('Generate candidate')
    t.wait('Quota/cost: 1 call(s)')
    assert t.count()==0
    t.send(ENTER)
    assert t.count()==0
    t.open('Generate candidate')
    t.send(RIGHT)
    t.send(ENTER)
    t.wait('Name already exists.')
    assert t.count()==1
    t.unchanged()
    t.open('Edit candidate')
    t.open('Name')
    t.send('\x01')
    for _ in 'architect': t.send('\x1b[3~')
    t.send('guardian')
    t.send(ENTER)
    t.open('Preview candidate')
    t.wait('guardian')
    t.unchanged()
    t.open('Accept into draft')
    t.wait('UNSAVED')
    t.section(8)
    t.open('Discard & exit')
    t.wait('Exit configuration?')
    t.send(DOWN)
    t.send(DOWN)
    t.send(ENTER)
    t.close()
    t.unchanged()
    call=json.loads(t.calls.read_text().splitlines()[0])
    assert '--model' in call['args'] and 'seed-model' in call['args']
    assert '--tools' in call['args'] and call['args'][call['args'].index('--tools')+1]==''
    assert call['cwd'] != str(t.directory) and call['cwd'] != str(REPO)
    assert not Path(call['cwd']).exists()
    print('PASS AI quota Cancel/Run, collision without overwrite, candidate edit/accept/discard, private cwd cleanup; stty restored')


def route_tests():
    """Test unsaved model without writes, then all exact seat models."""
    t=Terminal('route-tests')
    t.section(1)
    t.open('Model')
    t.send('unsaved-model')
    t.send(ENTER)
    t.wait('Value: unsaved-model')
    t.send(ENTER)
    t.open('Test this route')
    t.wait('Quota/cost: 1 call(s)')
    t.wait('unsaved-model')
    t.send(ENTER)
    assert t.count()==0
    t.open('Test this route')
    t.send(RIGHT)
    t.send(ENTER)
    t.wait('Route responded.')
    t.unchanged()
    calls=[json.loads(line) for line in t.calls.read_text().splitlines()]
    assert len(calls)==1 and 'unsaved-model' in calls[0]['args'] and 'seed-model' not in calls[0]['args']
    t.section(3)
    t.open('Test all members')
    t.wait('Quota/cost: 3 call(s)')
    t.send(RIGHT)
    t.send(ENTER)
    deadline=time.monotonic()+7
    while t.count()<4 and time.monotonic()<deadline:t.pump()
    assert t.count()==4
    t.wait('simplifier')
    calls=[json.loads(line) for line in t.calls.read_text().splitlines()]
    assert ['unsaved-model','critic-model','unsaved-model']==[call['args'][call['args'].index('--model')+1] for call in calls[1:]]
    assert all(not Path(call['cwd']).exists() for call in calls)
    t.abort()
    print('PASS exact unsaved route, safe cost cancellation and all-member route dispatch; no implicit Save; stty restored')


def cancel_test():
    """Escape aborts actual in-flight child and Ctrl-C waits for cleanup."""
    t=Terminal('cancel-test')
    t.delay.write_text('10000')
    t.section(1)
    t.open('Test this route')
    t.send(RIGHT)
    t.send(ENTER)
    t.wait('Testing connection')
    deadline=time.monotonic()+3
    while t.count()<1 and time.monotonic()<deadline:t.pump()
    assert t.count()==1
    t.send(ESC)
    t.wait('cancelled',timeout=7)
    call=json.loads(t.calls.read_text().splitlines()[0])
    assert not Path(call['cwd']).exists()
    pid=int(t.pid.read_text())
    try:os.kill(pid,0)
    except ProcessLookupError:pass
    else:raise AssertionError('Cancelled advisor alive')
    t.abort()
    print('PASS paid-test Escape cancellation, child terminated and scratch removed before exit; stty restored')


def narrow_generation():
    """Generated preview remains actionable after live resize to 40x12."""
    t=Terminal('narrow-generation')
    t.response.write_text(json.dumps({'name':'guardian','stance':'neutral','systemPrompt':'Inspect security risks. '*40}))
    t.section(3)
    t.open('Add persona')
    t.open('AI-assisted persona')
    t.open('Describe focus')
    t.send('Security reviewer')
    t.send('\x13')
    t.open('Generate candidate')
    t.send(RIGHT)
    t.send(ENTER)
    t.wait('guardian')
    t.child.setwinsize(12,40)
    t.screen.resize(12,40)
    t.pump(.5)
    t.focus('Accept into draft')
    t.wait('Accept into draft')
    t.unchanged()
    t.send(ENTER)
    t.wait('UNSAVED')
    t.abort()
    print('PASS 40x12 generated preview selection/Accept and no implicit save; stty restored')


def partial_batch():
    """Retain completed batch replies; cancellation starts no further calls."""
    t=Terminal('partial-batch')
    t.delay.write_text('[0,10000,0]')
    t.section(3)
    t.open('Test all members')
    t.send(RIGHT)
    t.send(ENTER)
    deadline=time.monotonic()+5
    while t.count()<2 and time.monotonic()<deadline:t.pump(.04)
    assert t.count()==2
    t.send(ESC)
    t.wait('Call cancelled')
    t.wait('Response received')
    t.focus('council / simplifier')
    t.wait('Not called')
    assert t.count()==2
    calls=[json.loads(line) for line in t.calls.read_text().splitlines()]
    assert all(not Path(call['cwd']).exists() for call in calls)
    t.abort()
    print('PASS Test all partial reply retained, in-flight cancelled, future seat not called; stty restored')


def generation_interrupt():
    """Ctrl-C aborts generation before CLI exits, leaving config untouched."""
    t=Terminal('generation-interrupt')
    t.delay.write_text('10000')
    t.section(3)
    t.open('Add persona')
    t.open('AI-assisted persona')
    t.open('Describe focus')
    t.send('Security reviewer')
    t.send('\x13')
    t.open('Generate candidate')
    t.send(RIGHT)
    t.send(ENTER)
    deadline=time.monotonic()+5
    while t.count()<1 and time.monotonic()<deadline:t.pump(.04)
    assert t.count()==1
    t.abort()
    call=json.loads(t.calls.read_text().splitlines()[0])
    assert not Path(call['cwd']).exists()
    pid=int(t.pid.read_text())
    try:os.kill(pid,0)
    except ProcessLookupError:pass
    else:raise AssertionError('Interrupted generator alive')
    print('PASS generation Ctrl-C kills child, removes scratch, exits130 and leaves bytes; stty restored')


def no_color():
    """Monochrome nested views and cost cancellation stay fully usable."""
    t=Terminal('nested-no-color',color=False)
    t.section(3)
    t.open('architect')
    t.open('Test this route')
    t.wait('Quota/cost: 1 call(s)')
    assert all(cell.fg=='default' and cell.bg=='default' for row in t.screen.buffer.values() for cell in row.values())
    t.send(ENTER)
    assert t.count()==0
    t.abort()
    print('PASS nested NO_COLOR and cost Cancel with zero calls; stty restored')


def project_inheritance():
    """Never substitute auto-detection for absent inherited global route."""
    t=Terminal('project-inheritance',fixture={'defaultMode':'solo','solo':{}},project=True)
    global_config=t.home/'.bpx-council.json'
    global_bytes=global_config.read_bytes()
    t.send(RIGHT)
    t.open('Test this route')
    t.wait('Inherited global Advisor')
    t.wait('Global Advisor is not represented')
    assert 'Quota/cost:' not in t.text
    assert t.count()==0
    t.abort()
    assert global_config.read_bytes()==global_bytes
    print('PASS project inherited-global route blocked, no auto substitute or calls; stty restored')


if __name__=='__main__':
    print('Evidence:',ROOT,'CLI:',CLI)
    try:
        nested()
        manual()
        generated()
        route_tests()
        cancel_test()
        narrow_generation()
        partial_batch()
        generation_interrupt()
        no_color()
        project_inheritance()
    finally:
        for terminal in ACTIVE_TERMINALS:
            if terminal.child.isalive():
                terminal.child.send('\x03')
                terminal.pump(3)
                terminal.child.close(force=True)
