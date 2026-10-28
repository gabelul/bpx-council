"""Real-terminal local diagnostics QA; fake HOME/CLIs, no provider accounts."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import time
import pexpect
import pyte

spec = importlib.util.spec_from_file_location('workbench_qa', Path(__file__).with_name('qa-config-workbench.py'))
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def versions(t, slow=False):
    """Install explicit version-only fixtures without replacing Claude's fake model responder."""
    log = t.directory/'versions.jsonl'
    prefix = """if(process.argv.includes('--version')){const fs=require('node:fs');
const row={name:'claude',cwd:process.cwd(),pid:process.pid};
"""
    if slow:
        prefix += """process.on('SIGTERM',()=>{}); const child=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});row.descendant=child.pid;
"""
    prefix += 'fs.appendFileSync('+json.dumps(str(log))+",JSON.stringify(row)+'\\n');"
    prefix += 'setInterval(()=>{},1000);' if slow else "console.log('2.1.47 (Claude Code)');process.exit(0);"
    prefix += '}else{\n'
    file=t.directory/'bin'/'claude'
    original=file.read_text().split('\n',1)[1]
    file.write_text('#!'+str(qa.NODE)+'\n'+prefix+original+'\n}')
    if not slow:
        for name, output in [('codex','codex-cli 0.123.4'),('amp','amp 2.3.4'),('pi','Login required; do-not-display-secret')]:
            body="const fs=require('node:fs');if(!process.argv.includes('--version'))throw new Error('unexpected model request');"
            body+='fs.appendFileSync('+json.dumps(str(log))+',JSON.stringify({name:'+json.dumps(name)+",cwd:process.cwd(),pid:process.pid})+'\\n');console.log("+json.dumps(output)+');'
            file=t.directory/'bin'/name
            file.write_text('#!'+str(qa.NODE)+'\n'+body)
            file.chmod(0o755)
    return log


def receipts(log):
    """Read only owned synthetic subprocess metadata."""
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def alive(pid):
    """Treat Linux zombies as exited while requiring actual executable termination."""
    try:
        os.kill(pid,0)
    except ProcessLookupError:
        return False
    stat=Path(f'/proc/{pid}/stat')
    return not stat.exists() or stat.read_text().split(') ',1)[1][0] not in ('Z','X')


def cleaned(log):
    """Require private cwd removal and no owned executable children after cancellation."""
    for row in receipts(log):
        assert not Path(row['cwd']).exists(),row
        for key in ('pid','descendant'):
            if key in row:
                until=time.monotonic()+2
                while alive(row[key]) and time.monotonic()<until:
                    time.sleep(.02)
                assert not alive(row[key]),row


def open_clis(t):
    """Enter CLI diagnostics from the SDK/CLI hub, retaining older injected controller fixtures."""
    t.section(5)
    if 'Direct providers' in t.text:
        t.open('Installed CLIs')
    t.wait('Check installed CLIs')


def local_and_connection():
    """Version success is separate from exact-model response; manual entry has plain wording."""
    t=qa.Terminal('diagnostics')
    log=versions(t)
    open_clis(t)
    assert not log.exists() and t.count()==0
    t.send(qa.RIGHT)
    assert not log.exists(), 'Right must not run local checks'
    t.send(qa.ENTER)
    t.wait('0.123.4')
    t.wait('2.1.47')
    assert 'anthropic:' not in t.text, 'Legacy HTTP must not appear as an installed CLI'
    assert len(receipts(log))==4 and t.count()==0
    for name, color in [('codex','87ffd7'),('claude','ffaf87'),('pi','d7afff')]:
        matches=[(y,line.index(name+':')) for y,line in enumerate(t.screen.display) if name+':' in line]
        assert matches and t.screen.buffer[matches[0][0]][matches[0][1]].fg==color,name
    assert 'do-not-display-secret' not in t.text
    t.focus('pi'); t.send(qa.RIGHT)
    t.wait('version unavailable')
    t.send(qa.LEFT)
    t.focus('claude'); t.send(qa.RIGHT)
    t.wait('Path:')
    assert 'Response received' not in t.text
    t.open('Test Advisor connection')
    t.wait('Quota/cost:')
    t.send(qa.ENTER)
    assert t.count()==0
    t.open('Test Advisor connection')
    t.send(qa.RIGHT); t.send(qa.ENTER)
    t.wait('Response received')
    assert t.count()==1
    t.send(qa.ESC)
    t.wait('Response received')
    t.section(1); t.open('Model'); t.send('changed-model'); t.send(qa.ENTER); t.send(qa.ENTER)
    open_clis(t); t.open('claude')
    assert 'Response received' not in t.text, 'New model cannot inherit prior receipt'
    t.section(1); t.open('Backend')
    t.wait('Installed')
    t.open('Enter backend manually')
    t.wait('CLI name or')
    assert 'Enter backend ID' not in t.text and 'login not verified' not in t.text
    t.send(qa.ESC); t.abort()
    cleaned(log)
    print('PASS explicit installed/version checks, unsupported vs failure, exact-model receipt, manual copy; no implicit calls/save; stty restored')


def cancel_local(exit=False):
    """Local Escape/Ctrl-C await resistant descendant and scratch cleanup at 40×12."""
    t=qa.Terminal('diag-interrupt' if exit else 'diag-cancel',columns=40,rows=12,color=False)
    log=versions(t,slow=True)
    open_clis(t); t.open('Check installed CLIs')
    until=time.monotonic()+2
    while not log.exists() and time.monotonic()<until:
        t.pump()
    assert log.exists()
    t.send('\x03' if exit else qa.ESC)
    if exit:
        t.close(130); t.unchanged()
    else:
        t.wait('Local check cancelled')
        for line in t.screen.buffer.values():
            for cell in line.values():
                assert cell.fg=='default' and cell.bg=='default'
        t.abort()
    assert t.count()==0
    cleaned(log)
    print('PASS local '+('Ctrl-C' if exit else 'Escape/NO_COLOR')+' cleanup; original bytes and stty restored')


def manual_install(check):
    """Manual setup defaults No, checks only on Yes, and writes nothing before integration consent."""
    t=qa.Terminal('install-check' if check else 'install-decline')
    log=versions(t)
    t.abort()
    env={k:v for k,v in os.environ.items() if not any(word in k.upper() for word in ('API_KEY','TOKEN','SECRET','PASSWORD','CREDENTIAL')) and k not in ('PI_CODING_AGENT_DIR','BPX_COUNCIL_MODEL','ANTHROPIC_MODEL','FORCE_COLOR','NO_COLOR')}
    env.update(HOME=str(t.home),PATH=str(t.directory/'bin')+':/usr/bin:/bin',TERM='xterm-256color',TMPDIR=str(t.directory),NO_COLOR='1')
    command='before=$(stty -g); '+shlex.quote(str(qa.NODE))+' '+shlex.quote(str(qa.CLI))+' install; result=$?; after=$(stty -g); [ "$before" = "$after" ] && restored=yes || restored=no; printf "\\nQA_EXIT=%s QA_RESTORED=%s\\n" "$result" "$restored"'
    t.child=pexpect.spawn('/bin/bash',['-c',command],cwd=str(t.directory),env=env,dimensions=(30,100),encoding='utf-8',timeout=10)
    t.screen=pyte.Screen(100,30);t.stream=pyte.Stream(t.screen);t.raw='';t.log=(t.directory/'install-terminal.log').open('w')
    t.wait('Check installed CLI versions now?')
    assert not log.exists()
    t.send(('y' if check else 'n')+'\r')
    t.wait('wire it into your coding agents')
    assert len(receipts(log))==(4 if check else 0)
    t.send('\x03');t.close(130)
    assert not (t.directory/'AGENTS.md').exists()
    assert not (t.directory/'.agents').exists()
    cleaned(log)
    print('PASS manual install '+('accepted' if check else 'declined')+' local checks; no integration writes, stty restored')


if __name__=='__main__':
    print('Evidence:',qa.ROOT,'CLI:',qa.CLI)
    try:
        local_and_connection()
        cancel_local()
        cancel_local(True)
        manual_install(False)
        manual_install(True)
    finally:
        for terminal in qa.ACTIVE_TERMINALS:
            if terminal.child.isalive():
                terminal.child.send('\x03');terminal.pump(3);terminal.child.close(force=True)
