"""Fake-only PTY proof of busy locks, failure selection and basic Codex probes."""
import copy
import importlib.util
import json
import time
from pathlib import Path

spec=importlib.util.spec_from_file_location('diagnostics_qa',Path(__file__).with_name('qa-backend-diagnostics.py'))
diag=importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)
qa=diag.qa


def wait_calls(t,count):
    """Wait for an owned fake invocation, not merely a busy screen."""
    until=time.monotonic()+4
    while t.count()<count and time.monotonic()<until:t.pump(.04)
    assert t.count()==count,t.text


def fake_codex(t):
    """Install a synthetic Codex that records exact argv/stdin and emits agent-message JSONL."""
    executable=t.directory/'bin'/'codex'
    executable.write_text('#!'+str(qa.NODE)+'\n'+r'''const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('codex-cli 0.123.4');process.exit(0)}
if(process.argv.includes('debug')){console.log('{"models":[]}');process.exit(0)}
let body='';process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{
const delay=Number(fs.readFileSync(process.env.BPX_FAKE_DELAY,'utf8'));
const row={args:process.argv.slice(2),body,cwd:process.cwd(),pid:process.pid};
if(delay>10000){process.on('SIGTERM',()=>{});const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});row.descendant=child.pid;}
fs.writeFileSync(process.env.BPX_FAKE_PID,String(process.pid));fs.appendFileSync(process.env.BPX_FAKE_CALLS,JSON.stringify(row)+'\n');
setTimeout(()=>{const reply=fs.readFileSync(process.env.BPX_FAKE_RESPONSE,'utf8');if(reply.startsWith('FAIL')){process.stderr.write('Synthetic rejected model.');process.exit(1)}console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:reply}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));},delay);
});
''')
    executable.chmod(0o755)


def lock_keys(t,title):
    """Attempt edits, pane moves, shortcuts and activation while modal owns input."""
    t.child.send('3\t\x1b[C\x1b[B\r7\x13editing')
    t.pump(.25)
    assert title in t.text,t.text
    assert 'Find:' not in t.text and 'Value:' not in t.text and 'Save changes?' not in t.text
    assert '► 1 Advisor' not in t.text and '► 5 Backends' not in t.text
    t.unchanged()


def live_versions():
    """Show start/status counters, ignore navigation, then restore original focused section."""
    t=qa.Terminal('progress-versions')
    log=diag.versions(t)
    script=t.directory/'bin'/'claude'
    body=script.read_text().replace("console.log('2.1.47 (Claude Code)');process.exit(0);","setTimeout(()=>{console.log('2.1.47 (Claude Code)');process.exit(0)},1800);")
    script.write_text(body)
    diag.open_clis(t);t.open('Check installed CLIs')
    t.wait('Local backend check')
    t.wait('1/4')
    t.wait('CLI: claude')
    assert 'Checking' in t.text and 'codex' in t.text
    lock_keys(t,'Local backend check')
    t.wait('Backends > Installed CLIs')
    assert 'Local backend check' not in t.text
    assert 'Backends' in t.text and len(diag.receipts(log))==4 and t.count()==0
    t.open('pi');t.wait('Version:');assert 'version unavailable' in t.text.lower(),t.text
    assert 'do-not-display-secret' not in t.text
    t.send(qa.LEFT);t.section(1);t.open('Backend');t.send('pi')
    assert 'pi (Installed;' in t.text,t.text
    assert 'version unavailable' in t.text.lower(),t.text
    t.send(qa.ESC);t.abort();diag.cleaned(log)
    print('PASS live start/counter/status, modal locks all other keys, focus returns; unrecognized version warning remains pickable; stty restored')


def hard_failure_saved():
    """Hard local failures disappear from new choices without removing stored assignments."""
    fixture=copy.deepcopy(qa.FIXTURE)
    fixture['solo']['backend']['command']='pi'
    fixture['solo']['backend']['model']='saved-pi'
    t=qa.Terminal('progress-failed-saved',fixture=fixture)
    log=diag.versions(t)
    script=t.directory/'bin'/'pi'
    script.write_text(script.read_text()+"\nprocess.exitCode=1;\n")
    diag.open_clis(t);t.open('Check installed CLIs');t.wait('Backends > Installed CLIs')
    t.open('pi');t.wait('Version:');assert 'check failed' in t.text.lower(),t.text
    t.send(qa.LEFT);t.section(1);t.open('Backend');t.send('pi')
    assert 'pi (Installed;' not in t.text,t.text
    assert 'keep exact' in t.text and 'failed' in t.text.lower(),t.text
    t.send(qa.ENTER);t.abort();diag.cleaned(log)
    print('PASS hard-failed backend excluded from new assignments; current exact saved route retained, no silent reset/save; stty restored')


def codex_connection():
    """Test literal model/effort pins with safe cost default, busy lock and separate strict generation."""
    fixture=copy.deepcopy(qa.FIXTURE)
    fixture['solo']['backend'].update(command='codex',model='probe@literal',effort='ultra')
    t=qa.Terminal('progress-codex',fixture=fixture)
    fake_codex(t)
    t.section(1);t.open('Test this route');t.wait('Quota/cost:')
    t.wait('read-only');t.wait('tools')
    t.send(qa.ENTER);assert t.count()==0
    t.open('Test this route');t.delay.write_text('1800');t.send(qa.RIGHT);t.send(qa.ENTER)
    t.wait('Testing connection');wait_calls(t,1)
    lock_keys(t,'Testing connection')
    t.wait('Response received')
    call=json.loads(t.calls.read_text().splitlines()[0])
    assert ['--sandbox','read-only']==call['args'][call['args'].index('--sandbox'):call['args'].index('--sandbox')+2],call
    assert 'project_doc_max_bytes=0' in call['args'],call
    assert call['args'][call['args'].index('--model')+1]=='probe@literal',call
    assert 'model_reasoning_effort=ultra' in call['args'],call
    assert 'Reply OK.' in call['body'] and not Path(call['cwd']).exists(),call
    t.send(qa.ESC);t.section(3);t.open('Add persona');t.open('AI-assisted persona');t.open('Describe focus')
    t.send('Security review');t.send('\x13');t.open('Generate candidate')
    t.wait('Codex')
    assert 'Quota/cost:' not in t.text and t.count()==1,t.text
    assert 'generat' in t.text.lower(),t.text
    t.abort();diag.cleaned(t.calls)
    print('PASS actual fake Codex tiny prompt, literal pins/ultra, quota Cancel, busy lock, private cleanup; Codex AI generation blocked; stty restored')


def codex_cancel(interrupt=False):
    """Busy Codex cancellation kills resistant descendants before returning/exiting."""
    fixture=copy.deepcopy(qa.FIXTURE)
    fixture['solo']['backend'].update(command='codex',model='cancel-model')
    t=qa.Terminal('progress-codex-interrupt' if interrupt else 'progress-codex-cancel',columns=40,rows=12,color=False,fixture=fixture)
    fake_codex(t);t.delay.write_text('30000')
    t.section(1);t.open('Test this route');t.wait('read-only');t.wait('tools')
    t.send(qa.RIGHT);t.send(qa.ENTER);t.wait('Testing connection');wait_calls(t,1)
    lock_keys(t,'Testing connection')
    t.send('\x03' if interrupt else qa.ESC)
    if interrupt:t.close(130);t.unchanged()
    else:
        t.wait('Cancelled')
        diag.cleaned(t.calls)
        for line in t.screen.buffer.values():
            for cell in line.values():assert cell.fg=='default' and cell.bg=='default'
        t.abort()
    diag.cleaned(t.calls)
    print('PASS narrow Codex '+('Ctrl-C' if interrupt else 'Escape/NO_COLOR')+' cleanup, no edits and exact terminal restoration')


if __name__=='__main__':
    print('Evidence:',qa.ROOT,'CLI:',qa.CLI)
    try:
        live_versions()
        hard_failure_saved()
        codex_connection()
        codex_cancel()
        codex_cancel(True)
    finally:
        for terminal in qa.ACTIVE_TERMINALS:
            if terminal.child.isalive():terminal.child.send('\x03');terminal.pump(3);terminal.child.close(force=True)
