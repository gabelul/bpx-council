#!/usr/bin/env python3
"""Record an animated GIF of a bpx-council council run from PTY cell grids.

The UI on screen — layout, colors, progress lines, verdict assembly — is the
built CLI. The advisor REPLIES are staged fixtures printed by fake
codex/claude/opencode binaries with artificial delays, so no provider account
is touched. The GIF must be captioned as a scripted demonstration.

Usage: python3 scripts/qa-demo-gif.py [--keep]
Requires pyte, pexpect, Pillow and ffmpeg. Writes docs/demo/council-demo.gif
and refuses to encode unless the CLI exited 0 and every expected seat and
verdict heading appeared in the terminal output.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pexpect
import pyte
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT_PATH = os.environ.get('BPX_QA_FONT', '/System/Library/Fonts/Menlo.ttc')

QUESTION = ('Our test suite takes 40 minutes and blocks deploys. Shard it across '
            'more CI runners, or delete the integration tests we suspect are redundant?')

ARCHITECT = ('Shard the suite now. Split tests into deterministic shards using '
             'historical timing, targeting 8-12 minutes per shard. Balance by '
             'measured duration, not test count. Deleting suspected-redundant tests '
             'is not the primary fix.')
CRITIC = ('Sharding is a treadmill with a floor you have not measured. One 11-minute '
          'file still gates the suite. And "we suspect" is not evidence: delete a '
          'test and a failure mode goes invisible for months.')
SIMPLIFIER = ('Measure first. Time every test this week, then decide. The slowest '
              'file probably holds most of the answer.')
VERDICT = ('Measure before sharding. Time the suite per file, split the slowest '
           'tests across runners, keep every test until timing proves it is safe to move.')

EXPECTED_HEADINGS = [
	'── council: architect→codex, critic→claude, simplifier→opencode',
	'### architect [for] · codex',
	'### critic [against] · claude',
	'### simplifier [neutral] · opencode',
	'### Verdict · codex',
]

COLORS = {'default': '#151820', 'black': '#10111b', 'white': '#e4e7ef', 'red': '#ff9580',
          'green': '#87ffd7', 'yellow': '#ffd787', 'blue': '#87afff', 'magenta': '#d7afff',
          'cyan': '#87ffff', 'brown': '#ffd787', 'brightblack': '#afafd7', 'brightwhite': '#e4e7ef'}
HEX = re.compile('[0-9a-fA-F]{6}')


def codex_event(text: str) -> str:
	"""One codex JSONL completion event carrying the reply text."""
	return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}})


def opencode_event(text: str) -> str:
	"""One opencode JSONL text event carrying the reply text."""
	return json.dumps({"type": "text", "part": {"text": text}})


def write_fakes(bin_dir: Path) -> None:
	"""Fake advisor CLIs: distinct staged replies with visible delays."""
	marker = json.dumps(CRITIC[:24])
	codex = bin_dir / 'codex'
	codex.write_text(
		'#!/bin/sh\n'
		'P=$(cat)\n'
		'case "$P" in\n'
		f'  *{marker}*) sleep 3.0; printf \'%s\\n\' \'{codex_event(VERDICT)}\' ;;\n'
		f'  *) sleep 4.0; printf \'%s\\n\' \'{codex_event(ARCHITECT)}\' ;;\n'
		'esac\n')
	(bin_dir / 'claude').write_text('#!/bin/sh\ncat >/dev/null\nsleep 5.0\n'
	                                f"printf '%s\\n' {json.dumps(CRITIC)}\n")
	(bin_dir / 'opencode').write_text('#!/bin/sh\ncat >/dev/null\nsleep 2.6\n'
	                                  f"printf '%s\\n' '{opencode_event(SIMPLIFIER)}'\n")
	for name in ('codex', 'claude', 'opencode'):
		(bin_dir / name).chmod(0o755)


def cell_color(value: str, fallback: str, foreground: bool) -> str:
	"""Resolve a pyte cell color to hex without reading terminal settings."""
	value = str(value)
	if value == 'default':
		return '#e4e7ef' if foreground else fallback
	if HEX.fullmatch(value):
		return '#' + value
	return COLORS.get(value, '#e4e7ef' if foreground else fallback)


def record(cols: int, rows: int, node: str, cli_js: str, work: Path, timeout_s: float):
	"""Run the CLI in a pty and record (offset, chunk) pairs plus exit status.

	Returns (chunks, exitstatus, saw_eof). Raises SystemExit-able error strings
	on timeout, where the child is force-cleaned because it is ours.
	"""
	home = work / 'home'
	(home / '.bpx-council').mkdir(parents=True)
	# Pre-answer the one-time onboarding offer: a first interactive run would
	# otherwise block on "Wire bpx-council into your coding agents now? [Y/n]".
	(home / '.bpx-council-onboarded').write_text(str(int(time.time())))
	(home / '.bpx-council.json').write_text(json.dumps({
		'defaultMode': 'solo',
		'solo': {'backend': {'type': 'cli', 'command': 'codex'}},
	}) + '\n')
	env = {**os.environ, 'HOME': str(home), 'PATH': f'{work / "bin"}:{Path(node).parent}:/usr/bin:/bin',
	       'TERM': 'xterm-256color', 'ANTHROPIC_API_KEY': '', 'NO_UPDATE_NOTIFIER': '1'}
	child = pexpect.spawn(node, [cli_js, '--mode', 'council', '--backends', 'codex,claude,opencode',
	                             '--synthesizer', 'codex', '--no-stdin', QUESTION],
	                      env=env, encoding='utf-8', dimensions=(rows, cols), cwd=str(work), timeout=timeout_s)
	chunks = []
	start = time.time()
	saw_eof = False
	while True:
		try:
			data = child.read_nonblocking(size=8192, timeout=1.0)
			chunks.append((time.time() - start, data))
		except pexpect.EOF:
			saw_eof = True
			break
		except pexpect.TIMEOUT:
			if not child.isalive():
				break
			if time.time() - start > timeout_s:
				print(f'Capture timeout after {timeout_s}s; killing owned child.', file=sys.stderr)
				child.close(force=True)
				return chunks, None, False
	exitstatus = child.exitstatus
	child.close()
	exitstatus = child.exitstatus  # pexpect reaps on close; status is only valid after
	return chunks, exitstatus, saw_eof


def render(screen: pyte.Screen, path: Path, font, cols: int, rows: int) -> None:
	"""Paint the current cell grid as one frame."""
	cw, ch = round(font.getlength('M')), 22
	image = Image.new('RGB', (cols * cw, rows * ch), '#151820')
	draw = ImageDraw.Draw(image)
	for y in range(rows):
		for x in range(cols):
			cell = screen.buffer[y][x]
			bg = cell_color(cell.bg, '#151820', False)
			fg = cell_color(cell.fg, bg, True)
			if cell.reverse:
				fg, bg = bg, fg
			px, py = x * cw, y * ch
			draw.rectangle((px, py, px + cw - 1, py + ch - 1), fill=bg)
			if cell.data.strip():
				draw.text((px, py), cell.data, font=font, fill=fg)
	image.save(path)


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument('--keep', action='store_true', help='keep the work directory (also saves raw output)')
	parser.add_argument('--out', default=str(ROOT / 'docs' / 'demo' / 'council-demo.gif'))
	parser.add_argument('--fps', type=float, default=5.0, help='capture frames per second')
	args = parser.parse_args()

	if not Path(FONT_PATH).is_file():
		print('Set BPX_QA_FONT to a monospace TTF/TTC font.', file=sys.stderr)
		return 1
	subprocess.run(['npm', 'run', 'build'], cwd=ROOT, check=True, capture_output=True)
	cli_js = str((ROOT / 'dist' / 'index.js').resolve())
	if not Path(cli_js).is_file():
		print('dist/index.js missing after build.', file=sys.stderr)
		return 1
	node = shutil.which('node') or sys.executable

	work = Path(tempfile.mkdtemp(prefix='bpx-demo-'))
	print(f'work dir: {work}', file=sys.stderr)
	if not args.keep:
		import atexit
		atexit.register(lambda: shutil.rmtree(work, ignore_errors=True))
	(work / 'bin').mkdir()
	write_fakes(work / 'bin')

	cols, rows = 100, 30
	chunks, exitstatus, saw_eof = record(cols, rows, node, cli_js, work, timeout_s=90)
	raw = ''.join(data for _, data in chunks)
	if args.keep:
		(work / 'raw-output.txt').write_text(raw)
		(work / 'chunks.json').write_text(json.dumps(chunks))

	if exitstatus != 0:
		print(f'CLI did not exit 0 (status={exitstatus}, eof={saw_eof}). Not encoding.', file=sys.stderr)
		return 1
	missing = [h for h in EXPECTED_HEADINGS if h not in raw]
	if missing:
		print(f'Missing expected headings: {missing}. Not encoding.', file=sys.stderr)
		return 1

	screen = pyte.Screen(cols, rows)
	stream = pyte.Stream(screen)
	frames_dir = work / 'frames'
	frames_dir.mkdir()
	font = ImageFont.truetype(FONT_PATH, 16)
	interval = 1.0 / args.fps
	pending = list(chunks)
	frame = 0
	elapsed = 0.0
	end = chunks[-1][0] + interval
	while elapsed <= end:
		while pending and pending[0][0] <= elapsed:
			_, data = pending.pop(0)
			stream.feed(data)
		render(screen, frames_dir / f'f{frame:04d}.png', font, cols, rows)
		frame += 1
		elapsed += interval
	for _ in range(int(args.fps * 2)):  # hold the verdict so it reads
		render(screen, frames_dir / f'f{frame:04d}.png', font, cols, rows)
		frame += 1
	final_text = '\n'.join(screen.display)
	if not all(h in final_text for h in EXPECTED_HEADINGS):
		print('Replayed screen does not contain all expected headings. Not encoding.', file=sys.stderr)
		return 1

	out = Path(args.out)
	out.parent.mkdir(parents=True, exist_ok=True)
	palette = work / 'palette.png'
	subprocess.run(['ffmpeg', '-y', '-framerate', str(args.fps), '-i', str(frames_dir / 'f%04d.png'),
	                '-vf', 'palettegen=max_colors=128', str(palette)], check=True, capture_output=True)
	subprocess.run(['ffmpeg', '-y', '-framerate', str(args.fps), '-i', str(frames_dir / 'f%04d.png'),
	                '-i', str(palette), '-lavfi', 'paletteuse=dither=bayer:bayer_scale=3',
	                '-loop', '0', str(out)], check=True, capture_output=True)
	print(f'{frame} frames -> {out} ({out.stat().st_size / 1024:.0f} KiB)')
	return 0


if __name__ == '__main__':
	raise SystemExit(main())
