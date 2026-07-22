/**
 * update-check — a tiny, dependency-free "there's a newer version" notice.
 *
 * Design, learned the hard way: notify from a cached result (instant, no
 * network, zero latency), and refresh that cache in a DETACHED background
 * process the CLI never waits on. An earlier version fetched inline with a 1s
 * timeout — but a cold DNS+TLS handshake routinely blows past 1s, so the notice
 * almost never fired. Bumping the timeout just trades a silent notice for a
 * visible hang. The detached refresh is what `update-notifier` does too; this
 * reimplements the useful 5% of it rather than taking ~47 transitive packages
 * (3.4 MB) for a one-line message on a tool whose whole pitch is "zero deps."
 *
 * Consequences of the cache-first design (both intended):
 *   - the notice is always "one run behind" a version bump — the first run
 *     after a release refreshes the cache, the next run shows the notice. Same
 *     as every other update notifier.
 *   - the current command never pays for the check: the answer is already on
 *     stdout, and the refresh runs in a child that outlives us.
 *
 * It stays quiet in CI, when stderr isn't a terminal, or when NO_UPDATE_NOTIFIER
 * is set; writes only to stderr so piped stdout stays clean; and swallows every
 * error — a flaky registry must never affect the CLI.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** How long a cached "latest version" is trusted before we refresh it. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PackageMeta {
	name: string;
	version: string;
}

/**
 * Read this package's name and version from its own package.json.
 *
 * Resolved relative to the compiled module (dist/update-check.js → ../
 * package.json), which is the package root both in the published tarball and in
 * dev via tsx. Same trick as TEMPLATES_ROOT — avoids a JSON import that would
 * fall outside tsc's rootDir.
 */
export function readPackageMeta(): PackageMeta {
	const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string; version?: string };
	return { name: pkg.name ?? "@booplex/bpx-council", version: pkg.version ?? "0.0.0" };
}

/**
 * Is `latest` a higher version than `current`?
 *
 * Plain numeric compare of major.minor.patch. Pre-release/build suffixes are
 * dropped (`1.2.0-rc.1` → `1.2.0`) — good enough to decide whether to nudge
 * someone, and it never has to be exact.
 */
export function isNewer(latest: string, current: string): boolean {
	const parse = (v: string): [number, number, number] => {
		const [maj, min, pat] = v.split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
		return [maj ?? 0, min ?? 0, pat ?? 0];
	};
	const [aMaj, aMin, aPat] = parse(latest);
	const [bMaj, bMin, bPat] = parse(current);
	if (aMaj !== bMaj) return aMaj > bMaj;
	if (aMin !== bMin) return aMin > bMin;
	return aPat > bPat;
}

/** Should we even look? Stay quiet where a notice would be noise or unwanted. */
function shouldCheck(): boolean {
	if (process.env.NO_UPDATE_NOTIFIER) return false;
	if (process.env.CI) return false;
	// Not a terminal (piped/redirected stderr, cron, hooks) → don't chatter.
	return process.stderr.isTTY === true;
}

interface Cache {
	/** Epoch ms of the last registry check. */
	lastCheck: number;
	/** Latest version seen, if any. */
	latest?: string;
}

function cachePath(): string {
	return join(homedir(), ".bpx-council-update-check.json");
}

function readCache(): Cache | undefined {
	try {
		return JSON.parse(readFileSync(cachePath(), "utf-8")) as Cache;
	} catch {
		return undefined;
	}
}

/** The stderr notice. Plain text — no colour dep, no box. */
function printNotice(meta: PackageMeta, latest: string): void {
	process.stderr.write(
		`\n  Update available: ${meta.version} → ${latest}\n` +
			`  Run: npm i -g ${meta.name}@latest  (then re-run \`bpx-council install\` to refresh agent files)\n\n`,
	);
}

/**
 * The refresh job, as a self-contained script run in a detached child.
 *
 * Node's `-e` runs CommonJS, so `require` and the global `fetch`/AbortController
 * (Node 18+) are all available. It fetches the latest version, writes the
 * cache, and exits — outliving the parent, which never waits on it. A 3s
 * timeout here is fine precisely because nobody is blocked on it.
 */
const REFRESH_SCRIPT = `
const fs = require("node:fs");
const name = process.env.BPX_UPDATE_NAME;
const cache = process.env.BPX_UPDATE_CACHE;
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 3000);
const stamp = (latest) => {
  try { fs.writeFileSync(cache, JSON.stringify({ lastCheck: Date.now(), latest })); } catch {}
};
fetch("https://registry.npmjs.org/" + name + "/latest", { signal: ac.signal, headers: { accept: "application/json" } })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => { clearTimeout(timer); stamp(d && typeof d.version === "string" ? d.version : undefined); })
  .catch(() => { clearTimeout(timer); stamp(undefined); });
`;

/** Launch the detached refresh. Best-effort — a failure to spawn is a non-event. */
function spawnRefresh(name: string): void {
	try {
		const child = spawn(process.execPath, ["-e", REFRESH_SCRIPT], {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, BPX_UPDATE_NAME: name, BPX_UPDATE_CACHE: cachePath() },
		});
		// Let the parent exit without waiting for the child.
		child.unref();
	} catch {
		// Some sandboxes forbid spawning. No notice, no harm.
	}
}

/**
 * Best-effort update notice. Synchronous and non-blocking: it prints from cache
 * and, if the cache is stale, kicks off a detached refresh for next time. Call
 * it after the real output. Never throws.
 *
 * @param meta - This package's name and version.
 */
export function maybeNotifyUpdate(meta: PackageMeta): void {
	try {
		if (!shouldCheck()) return;

		const cached = readCache();
		if (cached?.latest && isNewer(cached.latest, meta.version)) printNotice(meta, cached.latest);

		const stale = !cached || Date.now() - cached.lastCheck > CHECK_INTERVAL_MS;
		if (stale) spawnRefresh(meta.name);
	} catch {
		// An update check must never affect the tool. Swallow everything.
	}
}
