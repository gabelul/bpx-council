import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, renameSync, realpathSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lock } from "proper-lockfile";
import type { AuthOperationOptions, Credential, CredentialInfo } from "@earendil-works/pi-ai";
import { SdkCredentialError, SdkOperationBarrier, validSharedSdkCredential, isSdkCredentialProvider } from "./sdk-credentials.js";
import type { AccountIntent, CredentialService } from "./sdk-credentials.js";
import type { SdkAccountSummary } from "./sdk-types.js";

/**
 * Opt-in shared-pi credential backend.
 *
 * Reads and writes the pi coding agent's flat `~/.pi/agent/auth.json` under the
 * same proper-lockfile discipline pi itself uses (lockdir at `<auth.json>.lock`,
 * realpath off, 60s staleness), so council and concurrent pi sessions refresh
 * each provider at most once. Council touches only providers it admits; every
 * other entry — and unknown fields inside admitted entries — survives verbatim.
 * Unlike the Council-owned store there are no generation wrappers; the change
 * revision is a content hash, so "account changed; confirm route again" keeps
 * its meaning. Local logout removes the entry for pi too; callers must disclose
 * that before confirming.
 */
export class PiSharedCredentials implements CredentialService {
	readonly barrier = new SdkOperationBarrier();
	private resolvedDirectory: string | undefined;
	private readonly defaultHome: string | undefined;
	private readonly revisions = new AsyncLocalStorage<{ provider: string; revision: string; synchronizationLost: boolean }>();
	/** @param directory Explicit pi agent directory; default binds canonical HOME lazily. @param barrier Shared service leases. */
	constructor(directory?: string, barrier?: SdkOperationBarrier) {
		this.resolvedDirectory = directory === undefined ? undefined : resolve(directory);
		this.defaultHome = directory === undefined ? homedir() : undefined;
		if (barrier) this.barrier = barrier;
	}
	/** Bind default HOME alias once, on first method access. @returns Canonical pi agent directory. */
	get directory(): string {
		if (this.resolvedDirectory === undefined) {
			try { this.resolvedDirectory = join(realpathSync(this.defaultHome!), ".pi", "agent"); }
			catch { throw new SdkCredentialError("storage"); }
		}
		return this.resolvedDirectory;
	}
	/** Resolve file only below bound pi directory. @returns Internal file path. */
	private get path(): string { return join(this.directory, "auth.json"); }

	/** Stable content revision so route confirmations notice any credential change. @param credential Stored credential. @returns 12-hex digest, or missing marker. */
	private static revision(credential: unknown): string {
		if (!credential || typeof credential !== "object") return "missing";
		const entries = Object.entries(credential as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
		return createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 12);
	}

	/** Read pi's flat file with no writes, symlink following or oversized allocation. @returns Preserved map. */
	private load(): Record<string, unknown> {
		let fd: number | undefined;
		try {
			if (!PiSharedCredentials.inspectDirectory(this.directory)) return {};
			try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
				|| (process.getuid && stat.uid !== process.getuid())) throw new SdkCredentialError("storage");
			const size = Math.min(stat.size, 1024 * 1024);
			const buffer = Buffer.alloc(size);
			let bytes = 0;
			while (bytes < buffer.length) {
				const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
				if (!count) break;
				bytes += count;
			}
			const value: unknown = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
			if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SdkCredentialError("storage");
			for (const [provider, credential] of Object.entries(value as Record<string, unknown>)) {
				if (isSdkCredentialProvider(provider) && !validSharedSdkCredential(provider, credential)) throw new SdkCredentialError("storage");
			}
			return value as Record<string, unknown>;
		} catch { throw new SdkCredentialError("storage"); }
		finally { if (fd !== undefined) closeSync(fd); }
	}

	/** Reject symlinked path components; pi's directory is not 0700 and that is fine. @param directory Absolute path. @returns Whether final directory exists. */
	private static inspectDirectory(directory: string): boolean {
		const root = parse(directory).root;
		let current = root;
		const parts = directory.slice(root.length).split(/[\\/]/).filter(Boolean);
		for (let index = 0; index < parts.length; index++) {
			current = join(current, parts[index]);
			let stat;
			try { stat = lstatSync(current); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new SdkCredentialError("storage"); }
			if (stat.isSymbolicLink()) throw new SdkCredentialError("storage");
			if (index === parts.length - 1 && (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))) throw new SdkCredentialError("storage");
		}
		return true;
	}

	/** Safe local metadata for one admitted account. @param provider ID. @returns No credentials. */
	summary(provider: string): SdkAccountSummary {
		if (!isSdkCredentialProvider(provider)) throw new SdkCredentialError("provider");
		try {
			const credential = this.load()[provider];
			return { state: credential !== undefined ? "stored" : "missing", method: (credential as { type?: "api_key" | "oauth" } | undefined)?.type,
				revision: credential !== undefined ? PiSharedCredentials.revision(credential) : "missing" };
		} catch { return { state: "invalid", revision: "invalid", error: "Shared pi account storage is unavailable or invalid." }; }
	}
	/** Read admitted provider credential only. @param provider ID. @param options Cancellation. @returns Credential copy. */
	read(provider: string, options: AuthOperationOptions = {}): Promise<Credential | undefined> {
		return this.barrier.track(async () => {
			if (!isSdkCredentialProvider(provider)) throw new SdkCredentialError("provider");
			options.signal?.throwIfAborted();
			const credential = this.load()[provider];
			this.checkRevision(provider, credential);
			return credential === undefined ? undefined : structuredClone(credential) as Credential;
		});
	}
	/** List admitted-provider metadata only; pi's other providers stay invisible. @param options Cancellation. @returns Credential types. */
	list(options: AuthOperationOptions = {}): Promise<readonly CredentialInfo[]> {
		return this.barrier.track(async () => {
			options.signal?.throwIfAborted();
			return Object.entries(this.load()).flatMap(([providerId, credential]) =>
				isSdkCredentialProvider(providerId) && credential !== undefined ? [{ providerId, type: (credential as { type: CredentialInfo["type"] }).type }] : []);
		});
	}
	/** Freeze confirmed account identity through SDK auth and dispatch. @param provider ID. @param revision Confirmed identity. @param task SDK operation. @returns Operation result. */
	inferenceAction<T>(provider: string, revision: string, task: () => Promise<T>): Promise<T> {
		return this.revisions.run({ provider, revision, synchronizationLost: false }, task);
	}
	/** Report only safe operation-scoped persistence loss, never a raw error. @returns Whether reconnect is required. */
	synchronizationFailed(): boolean { return this.revisions.getStore()?.synchronizationLost ?? false; }
	/** Check identity immediately before provider dispatch. @param provider ID. @returns Nothing. */
	assertRevision(provider: string): void { this.checkRevision(provider, this.load()[provider]); }
	/** Check content revision at authoritative reads. @param provider ID. @param credential Latest entry. @returns Nothing. */
	private checkRevision(provider: string, credential: unknown): void {
		const expected = this.revisions.getStore();
		if (expected && (expected.provider !== provider || expected.revision !== PiSharedCredentials.revision(credential))) throw new SdkCredentialError("stale");
	}
	/** Mark SDK login/logout as explicit CAS account action. @param intent Expected identity and commit receipt. @param task SDK action. @returns Scoped result. */
	accountAction<T>(intent: AccountIntent, task: () => Promise<T>): Promise<T> {
		return this.barrier.scope(task);
	}
	/** Serialize SDK refresh or explicit login; refresh never creates accounts. @param provider ID. @param fn SDK mutation. @param options Lock-wait signal. @returns Persisted credential. */
	modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options: AuthOperationOptions = {}): Promise<Credential | undefined> {
		return this.barrier.track(() => this.mutate(provider, options, async file => {
			const current = file[provider];
			this.checkRevision(provider, current);
			const next = await fn(current === undefined ? undefined : structuredClone(current) as Credential);
			if (next === undefined) return current === undefined ? undefined : structuredClone(current) as Credential;
			if (!validSharedSdkCredential(provider, next)) throw new SdkCredentialError("credential");
			file[provider] = structuredClone(next);
			await this.persist(file);
			return structuredClone(next);
		}));
	}
	/** Delete under same lock; removes the provider's login for pi too. @param provider ID. @param options Lock-wait signal. @returns Cleanup completion. */
	delete(provider: string, options: AuthOperationOptions = {}): Promise<void> {
		return this.barrier.track(() => this.mutate(provider, options, async file => {
			if (file[provider] === undefined) return;
			delete file[provider];
			await this.persist(file);
		}));
	}
	/** Bounded cancellable lock acquisition shared with pi's own sessions. @param provider ID. @param options Lock signal. @param task Locked mutation. @returns Result after unlock. */
	private async mutate<T>(provider: string, options: AuthOperationOptions, task: (file: Record<string, unknown>) => Promise<T>): Promise<T> {
		if (!isSdkCredentialProvider(provider)) throw new SdkCredentialError("provider");
		options.signal?.throwIfAborted();
		try {
			await mkdir(this.directory, { recursive: true, mode: 0o755 });
			const end = Date.now() + 20_000;
			let release: (() => Promise<void>) | undefined;
			while (!release) {
				options.signal?.throwIfAborted();
				try {
					release = await lock(this.path, { realpath: false, stale: 60_000, update: 5_000, retries: 0 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
					if (Date.now() >= end) throw new SdkCredentialError("lock");
					await delay(20, undefined, { signal: options.signal });
				}
			}
			try {
				options.signal?.throwIfAborted();
				return await task(this.load());
			} finally {
				try { await release(); } catch { /* Lock retirement races a stale takeover; storage revalidates. */ }
			}
		} catch (error) {
			if (options.signal?.aborted) throw options.signal.reason;
			if (error instanceof SdkCredentialError) {
				if (error.code === "lock") { const scope = this.revisions.getStore(); if (scope) scope.synchronizationLost = true; }
				throw error;
			}
			throw new SdkCredentialError("storage");
		}
	}
	/** Atomic restrictive write, syncing file and directory, preserving every untouched entry. @param file Full preserved map. @returns Durable completion. */
	private async persist(file: Record<string, unknown>): Promise<void> {
		const text = JSON.stringify(file);
		if (Buffer.byteLength(text) > 1024 * 1024) throw new SdkCredentialError("storage");
		const temp = join(this.directory, `auth.${randomUUID()}.tmp`);
		let handle;
		try {
			handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			await handle.chmod(0o600);
			await handle.writeFile(text, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			renameSync(temp, this.path);
			const directory = await open(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			try { await directory.sync(); } finally { await directory.close(); }
		} finally {
			await handle?.close();
			await unlink(temp).catch(() => undefined);
		}
	}
}
