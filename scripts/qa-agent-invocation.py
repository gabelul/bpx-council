#!/usr/bin/env python3
"""Offline shell/CLI contract, not Claude Code discovery or account diagnosis.

Run from repo: python3 scripts/qa-agent-invocation.py
Defaults test repo dist and installed global artifact separately. BPX_QA_CLI
selects one JS entry; BPX_QA_NODE selects Node (including Node 20/22 fixtures).
Raw logs survive in printed artifact directory; HOME/config/executables vanish.
"""

import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
GLOBAL_BIN = shutil.which('bpx-council')
GLOBAL = Path(GLOBAL_BIN).resolve() if GLOBAL_BIN else None

# Preload patches run before ESM imports. Forbidden operations leave evidence even
# if CLI swallows their exceptions (update-check deliberately does).
GUARD = r'''
const fs = require('node:fs');
const cp = require('node:child_process');
const log = row => fs.appendFileSync(process.env.BPX_QA_GUARD_LOG, JSON.stringify(row) + '\n');
const deny = operation => function () {
  log({ blocked: operation });
  throw new Error('Offline QA blocked ' + operation);
};
const spawn = cp.spawn;
cp.spawn = function (command, args, options) {
  if (command !== process.env.BPX_QA_FAKE || options?.shell || (args || []).length)
    return deny('child_process.spawn')();
  const child = spawn.call(this, command, args, options);
  log({ command, pid: child.pid });
  return child;
};
for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawnSync', 'fork'])
  cp[name] = deny('child_process.' + name);
globalThis.fetch = deny('fetch');
for (const module of ['http', 'https']) {
  const api = require('node:' + module);
  for (const name of ['request', 'get']) api[name] = deny(module + '.' + name);
}
require('node:net').Socket.prototype.connect = deny('net.connect');
const dns = require('node:dns');
for (const api of [dns, dns.promises])
  for (const name of Object.keys(api))
    if (name === 'lookup' || name.startsWith('resolve')) api[name] = deny('dns.' + name);
require('node:module').syncBuiltinESMExports();
'''

FAKE = r'''
import json, os, sys
from pathlib import Path
root = Path(os.environ['BPX_QA_CALLS'])
path = root / (str(os.getpid()) + '.json')
row = {'pid': os.getpid(), 'cwd': os.getcwd(), 'home': os.environ['HOME'],
       'argv': sys.argv[1:], 'prompt': None}
path.write_text(json.dumps(row))
row['prompt'] = sys.stdin.read()
path.write_text(json.dumps(row))
if os.environ['BPX_QA_CASE'] == 'backend-failure' or (
    os.environ['BPX_QA_CASE'] == 'partial-council' and
    '=== Original Question ===' in row['prompt']):
    print('fixture error detail on stderr, not account data', file=sys.stderr)
    sys.exit(23)
print('OFFLINE_ADVICE_' + str(os.getpid()))
'''


def require(condition, message):
    """Fail with contract detail; unlike assert, works under python -O."""
    if not condition:
        raise RuntimeError(message)


def kill_group(pid):
    """Kill owned process group; completed groups are harmless no-ops."""
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def run_case(node, cli, fixture, artifacts, name, flags, question):
    """Run safely quoted shell command with stdin PIPE held open until exit.

    Return exit code, raw stdout/stderr, fake captures and elapsed seconds.
    Kill CLI group and separately detached advisor groups on every exit path.
    """
    calls = fixture / name
    calls.mkdir()
    guard_log = artifacts / (name + '.guard.jsonl')
    guard_log.touch()
    env = {
        'HOME': str(fixture / 'home'), 'PATH': str(fixture / 'bin'),
        'TMPDIR': str(fixture / 'tmp'), 'CI': '1', 'NO_UPDATE_NOTIFIER': '1',
        'BPX_QA_FAKE': str(fixture / 'bin' / 'offline-advisor'),
        'BPX_QA_CALLS': str(calls), 'BPX_QA_CASE': name,
        'BPX_QA_GUARD_LOG': str(guard_log),
    }
    # No inherited API keys, NODE_OPTIONS, ANTHROPIC_MODEL or BPX_COUNCIL_MODEL.
    argv = [node, '--require', str(fixture / 'guard.cjs'), str(cli),
            '--config', str(fixture / 'home' / '.bpx-council.json'), *flags]
    argv += [question] if name == 'legacy-open-pipe' else ['--question', question]
    command = 'exec ' + shlex.join(argv)
    (artifacts / (name + '.command.txt')).write_text(command + '\n')
    start = time.monotonic()
    proc = None
    timed_out = False
    try:
        with (artifacts / (name + '.stdout')).open('wb') as out, \
                (artifacts / (name + '.stderr')).open('wb') as err:
            proc = subprocess.Popen(['/bin/sh', '-c', command], cwd=fixture / 'cwd',
                                    env=env, stdin=subprocess.PIPE, stdout=out,
                                    stderr=err, start_new_session=True)
            # communicate() closes stdin. wait() preserves caller's open pipe.
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                timed_out = True
    finally:
        if proc is not None:
            kill_group(proc.pid)
        events = [json.loads(line) for line in guard_log.read_text().splitlines()]
        for event in events:
            if event.get('pid'):
                kill_group(event['pid'])
        if proc is not None:
            proc.wait(timeout=3)
            proc.stdin.close()
        captures = [json.loads(path.read_text()) for path in sorted(calls.glob('*.json'))]
        (artifacts / (name + '.calls.json')).write_text(json.dumps(captures, indent=2) + '\n')
    elapsed = time.monotonic() - start
    code = proc.returncode
    stdout = (artifacts / (name + '.stdout')).read_text()
    stderr = (artifacts / (name + '.stderr')).read_text()
    (artifacts / (name + '.result.json')).write_text(json.dumps({
        'exit': code, 'seconds': elapsed, 'calls': len(captures), 'timeout': timed_out,
    }, indent=2) + '\n')
    require(not timed_out, name + ': harness timeout (not CLI stdin deadline)')
    require(not any('blocked' in row for row in events), name + ': forbidden operation: ' + repr(events))
    require(len(events) == len(captures), name + ': spawn/capture mismatch')
    for row in captures:
        require(row['cwd'] == str(fixture / 'cwd') and row['home'] == env['HOME']
                and row['argv'] == [], name + ': fake escaped scratch invocation')
    return code, stdout, stderr, captures, elapsed


def test_artifact(node, cli, label, root):
    """Check four contracts against one artifact without sharing HOME or calls."""
    artifacts = root / label
    artifacts.mkdir()
    (artifacts / 'artifact.json').write_text(json.dumps({
        'cli': str(cli), 'sha256': hashlib.sha256(cli.read_bytes()).hexdigest(), 'node': node,
    }, indent=2) + '\n')
    with tempfile.TemporaryDirectory(prefix='bpx-invocation-fixture-') as temporary:
        fixture = Path(temporary).resolve()
        for directory in ['home', 'bin', 'cwd', 'tmp']:
            (fixture / directory).mkdir()
        fake = fixture / 'bin' / 'offline-advisor'
        fake.write_text('#!' + sys.executable + '\n' + FAKE)
        fake.chmod(0o700)
        (fixture / 'guard.cjs').write_text(GUARD)
        config = {'defaultMode': 'council', 'solo': {'backend': {
            'type': 'cli', 'command': str(fake), 'timeoutMs': 2000,
        }}, 'council': {'members': ['architect', 'critic']}}
        (fixture / 'home' / '.bpx-council.json').write_text(json.dumps(config))
        markers = [fixture / name for name in ['dollar-injected', 'backtick-injected', 'newline-injected']]
        question = ("Literal 'single' \"double\" $(/usr/bin/touch " + str(markers[0]) + ') '
                    + '`/usr/bin/touch ' + str(markers[1]) + '`\n'
                    + '/usr/bin/touch ' + str(markers[2]) + '\nlast line')
        cases = [
            ('legacy-open-pipe', ['--mode', 'gut-check'], 0, 'deadline'),
            ('quoted-solo', ['--mode', 'solo', '--format', 'json', '--no-stdin'], 1, 'complete'),
            ('backend-failure', ['--mode', 'solo', '--format', 'json', '--no-stdin'], 1, 'failed'),
            ('partial-council', ['--mode', 'council', '--format', 'json', '--no-stdin'], 3, 'partial'),
        ]
        for name, flags, count, status in cases:
            code, out, err, captures, elapsed = run_case(node, cli, fixture, artifacts, name, flags, question)
            require(len(captures) == count, name + ': wrong advisor count')
            require(not any(path.exists() for path in markers), name + ': shell injection')
            if status == 'deadline':
                require(code != 0 and not out and 'stdin did not end within 3000ms' in err
                        and '--no-stdin' in err and 2.8 <= elapsed < 8, name + ': wrong stdin failure')
            else:
                receipt = json.loads(out)  # Reject extra stdout, not merely find JSON within it.
                require(receipt['schemaVersion'] == 1 and receipt['status'] == status
                        and len(receipt['attempts']) == count
                        and receipt['usage']['attempted'] == count, name + ': wrong receipt')
                require((code == 0) == (status == 'complete'), name + ': wrong exit status')
                if status == 'complete':
                    require(receipt['mode'] == 'solo' and receipt['error'] is None
                            and receipt['advice'].startswith('OFFLINE_ADVICE_'), name + ': wrong advice/mode')
                    require(captures[0]['prompt'].split('\n\n---\n\n=== User ===\n', 1)[1]
                            == question + '\n', name + ': question changed')
                else:
                    require('exited 23' in receipt['error'] and
                            sum(row['status'] == 'failed' for row in receipt['attempts']) == 1,
                            name + ': missing useful backend error')
                    if status == 'failed':
                        require(receipt['advice'] is None, name + ': failure claimed advice')
                    else:
                        require('Synthesis failed' in receipt['error'] and
                                receipt['attempts'][-1]['seat'] == 'synthesizer', name + ': wrong failed seat')
                        for row in captures:
                            if '=== Original Question ===' not in row['prompt']:
                                require('OFFLINE_ADVICE_' + str(row['pid']) in receipt['advice'],
                                        name + ': member advice lost')
            print(f'PASS {label}/{name} exit={code} calls={count} seconds={elapsed:.3f} artifacts={artifacts}', flush=True)
    print(f'PASS {label} cases=4 calls=5 fixtures=clean artifacts={artifacts}', flush=True)


def main():
    """Resolve explicit artifact/node overrides; retain only raw QA evidence."""
    node = shutil.which(os.environ.get('BPX_QA_NODE', 'node'))
    require(node is not None, 'BPX_QA_NODE/node executable not found')
    node = str(Path(node).absolute())
    override = os.environ.get('BPX_QA_CLI')
    targets = [('override', Path(override).resolve())] if override else [('repo-dist', REPO / 'dist' / 'index.js')]
    if not override:
        if GLOBAL and GLOBAL.suffix == '.js':
            targets.append(('global-dist', GLOBAL))
        else:
            print('SKIP global artifact: no directly resolved JS entry; use BPX_QA_CLI for wrappers.')
    for _, cli in targets:
        require(cli.is_file(), 'Missing CLI artifact: ' + str(cli))
    root = Path(tempfile.mkdtemp(prefix='bpx-agent-invocation-')).resolve()
    print('Artifacts:', root, flush=True)
    try:
        for label, cli in targets:
            test_artifact(node, cli, label, root)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
        (root / 'failure.txt').write_text(str(error) + '\n')
        print(f'FAIL {error} artifacts={root}', file=sys.stderr)
        return 1
    print(f'PASS total cases={4 * len(targets)} calls={5 * len(targets)} artifacts={root}')
    print('Fixture proves open-pipe invocation defect; user root cause unknown. Claude Code discovery not tested.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
