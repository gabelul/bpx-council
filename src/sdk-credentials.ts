import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, renameSync, realpathSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lock } from "proper-lockfile";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { SdkAccountSummary } from "./sdk-types.js";

const PROVIDERS = new Set(["openai", "anthropic", "openai-codex", "zai"]);
/** Providers whose SDK login is OAuth-backed (subscription or OAuth console). */
export const OAUTH_PROVIDERS = new Set(["anthropic", "openai-codex"]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SECRET_BYTES = 32 * 1024;
const MISSING_REVISION = "missing";
interface Account { generation: string; credentialVersion: string; credential?: Credential }
interface AccountFile { version: 1; accounts: Record<string, Account> }
/** Explicit login/logout identity; exported for the shared-pi store's CAS. */
export interface AccountIntent { provider: string; expectedRevision: string; receipt: { changed: boolean } }

/** Credential backend surface the SDK provider service depends on; both the
 * strict Council-owned store and the opt-in shared-pi store implement it. */
export interface CredentialService extends CredentialStore {
	/** Shared shutdown leases for SDK work. */
	readonly barrier: SdkOperationBarrier;
	/** Safe local metadata for one admitted account. @param provider ID. @returns No credentials. */
	summary(provider: string): SdkAccountSummary;
	/** Freeze confirmed account identity through SDK auth and dispatch. @param provider ID. @param revision Confirmed identity. @param task SDK operation. @returns Operation result. */
	inferenceAction<T>(provider: string, revision: string, task: () => Promise<T>): Promise<T>;
	/** Report only safe operation-scoped persistence loss, never a raw error. @returns Whether reconnect is required. */
	synchronizationFailed(): boolean;
	/** Check identity immediately before provider dispatch. @param provider ID. @returns Nothing. */
	assertRevision(provider: string): void;
	/** Mark SDK login/logout as explicit CAS account action. @param intent Expected identity and commit receipt. @param task SDK action. @returns Scoped result. */
	accountAction<T>(intent: AccountIntent, task: () => Promise<T>): Promise<T>;
}

/** Private, fixed-message storage error; never carries filesystem paths or SDK causes. */
export class SdkCredentialError extends Error {
	/** @param code Safe classification. */
	constructor(readonly code: "storage" | "stale" | "provider" | "credential" | "lock") {
		super(code === "stale" ? "Account changed; reopen account settings." : code === "lock"
			? "Council credential synchronization failed; reconnect account before trying again." : code === "credential"
				? "Credential format is unsupported for this provider. Enter a literal supported API key or use its SDK login."
				: "Council account storage is unavailable or invalid.");
		this.name = "SdkCredentialError";
	}
}

/** Test whether value is a plain JSON record. @param value Candidate. @returns Record guard. */
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate literal secret without command/helper interpretation. @param value Candidate. @returns Validity. */
function secret(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.trimStart().startsWith("!")
		&& !/[\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value) <= MAX_SECRET_BYTES;
}

/** Validate admitted SDK credentials; reject env overrides and unknown fields. @param provider ID. @param value Raw SDK value. @returns Validity. */
export function validSdkCredential(provider: string, value: unknown): value is Credential {
	if (!PROVIDERS.has(provider) || !record(value)) return false;
	// Stock SDK classifies non-sk OpenAI values as ChatGPT tokens, not API keys.
	if (value.type === "api_key") return provider !== "openai-codex" && Object.keys(value).every(key => ["type", "key"].includes(key)) && secret(value.key)
		&& (provider !== "openai" || value.key.startsWith("sk-"));
	return OAUTH_PROVIDERS.has(provider) && value.type === "oauth"
		&& Object.keys(value).every(key => ["type", "access", "refresh", "expires", ...(provider === "openai-codex" ? ["accountId"] : [])].includes(key))
		&& secret(value.access) && secret(value.refresh) && typeof value.expires === "number"
		&& Number.isFinite(value.expires) && value.expires >= 0
		&& (provider !== "openai-codex" || value.accountId === undefined || typeof value.accountId === "string");
}

/** Lenient shared-store validation: required fields must hold, unknown fields survive verbatim.
 * Pi's auth.json may carry fields this Council version has never seen; the shared
 * store must never drop or reject them, only refuse shapes it cannot honor.
 * @param provider ID. @param value Raw SDK value. @returns Validity. */
export function validSharedSdkCredential(provider: string, value: unknown): value is Credential {
	if (!PROVIDERS.has(provider) || !record(value)) return false;
	if (value.type === "api_key") return provider !== "openai-codex" && secret(value.key) && (provider !== "openai" || value.key.startsWith("sk-"));
	return OAUTH_PROVIDERS.has(provider) && value.type === "oauth" && secret(value.access) && secret(value.refresh)
		&& typeof value.expires === "number" && Number.isFinite(value.expires) && value.expires >= 0
		&& (provider !== "openai-codex" || value.accountId === undefined || typeof value.accountId === "string");
}

/** Check provider before any filesystem access. @param provider Exact ID. @returns Nothing. */
function admit(provider: string): void {
	if (!PROVIDERS.has(provider)) throw new SdkCredentialError("provider");
}

/** Admitted provider check for external stores (shared pi mode). @param provider Exact ID. @returns Admission. */
export function isSdkCredentialProvider(provider: string): boolean { return PROVIDERS.has(provider); }

/** Parse bounded own format, refusing malformed or unmanaged content. @param text File text. @returns Private account file. */
function decode(text: string): AccountFile {
	const value: unknown = JSON.parse(text);
	if (!record(value) || value.version !== 1 || !record(value.accounts)
		|| Object.keys(value).some(key => !["version", "accounts"].includes(key))) throw new SdkCredentialError("storage");
	for (const [provider, account] of Object.entries(value.accounts)) {
		if (!PROVIDERS.has(provider) || !record(account) || typeof account.generation !== "string"
			|| !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(account.generation)
			|| typeof account.credentialVersion !== "string" || !/^[0-9a-f-]{36}$/.test(account.credentialVersion)
			|| Object.keys(account).some(key => !["generation", "credentialVersion", "credential"].includes(key))
			|| (account.credential !== undefined && !validSdkCredential(provider, account.credential))) throw new SdkCredentialError("storage");
	}
	return value as unknown as AccountFile;
}

/** Classify only ENOENT, never expose original error. @param error Filesystem error. @returns Missing state. */
function missing(error: unknown): boolean { return record(error) && error.code === "ENOENT"; }

/** Reject symlink path components before creating/opening storage. @param directory Absolute path. @returns Whether final directory exists. */
function inspectDirectory(directory: string): boolean {
	const root = parse(directory).root;
	let current = root;
	const parts = directory.slice(root.length).split(/[\\/]/).filter(Boolean);
	for (let index = 0; index < parts.length; index++) {
		current = join(current, parts[index]);
		let stat;
		try { stat = lstatSync(current); }
		catch (error) { if (missing(error)) return false; throw new SdkCredentialError("storage"); }
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SdkCredentialError("storage");
		if (index === parts.length - 1 && ((stat.mode & 0o777) !== 0o700
			|| (process.getuid && stat.uid !== process.getuid()))) throw new SdkCredentialError("storage");
	}
	return true;
}

/** Track leases before asynchronous work, including SDK work that aborts early. */
export class SdkOperationBarrier {
	private readonly pending = new Set<Promise<unknown>>();
	private readonly scopes = new AsyncLocalStorage<Set<Promise<unknown>>>();
	/** Register task synchronously. @param task Owned work. @returns Tracked completion. */
	track<T>(task: () => Promise<T>): Promise<T> {
		const scope = this.scopes.getStore();
		const promise = Promise.resolve().then(task);
		this.pending.add(promise);
		scope?.add(promise);
		/** Remove completed lease from operation and shutdown sets. @returns Nothing. */
		const release = (): void => { this.pending.delete(promise); scope?.delete(promise); };
		promise.then(release, release);
		return promise;
	}
	/** Drain children before returning caller result. @param task Request/account work. @returns Result after cleanup. */
	scope<T>(task: () => Promise<T>): Promise<T> {
		return this.track(() => this.scopes.run(new Set(), async () => {
			try { return await task(); }
			finally { await this.drain(this.scopes.getStore()!); }
		}));
	}
	/** Wait for all shutdown leases. @returns Barrier completion. */
	async settle(): Promise<void> { await this.drain(this.pending); }
	/** Drain microtask-scheduled children too. @param leases Tracked set. @returns Quiescence. */
	private async drain(leases: Set<Promise<unknown>>): Promise<void> {
		for (;;) {
			await Promise.allSettled([...leases]);
			await Promise.resolve();
			if (!leases.size) return;
		}
	}
}

/** Council-owned strict whole-file CredentialStore. No SDK defaults or helpers. */
export class SdkCredentials implements CredentialStore {
	private resolvedDirectory: string | undefined;
	private readonly defaultHome: string | undefined;
	private readonly intents = new AsyncLocalStorage<AccountIntent>();
	private readonly revisions = new AsyncLocalStorage<{ provider: string; revision: string; synchronizationLost: boolean }>();
	/** @param directory Own storage, default separate from Council config. @param barrier Shared service leases. */
	constructor(directory?: string, readonly barrier = new SdkOperationBarrier()) {
		this.resolvedDirectory = directory === undefined ? undefined : resolve(directory);
		this.defaultHome = directory === undefined ? homedir() : undefined;
	}
	/** Bind default HOME alias once, on first method access; never follow account leaf. @returns Canonical own directory. */
	get directory(): string {
		if (this.resolvedDirectory === undefined) {
			try { this.resolvedDirectory = join(realpathSync(this.defaultHome!), ".bpx-council"); }
			catch { throw new SdkCredentialError("storage"); }
		}
		return this.resolvedDirectory;
	}
	/** Resolve file only below bound own directory. @returns Internal file path. */
	private get path(): string { return join(this.directory, "auth.json"); }
	/** Read own file synchronously with no writes, symlink following or oversized allocation. @returns Private validated map. */
	private load(): AccountFile {
		let fd: number | undefined;
		try {
			if (!inspectDirectory(this.directory)) return { version: 1, accounts: {} };
			try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
			catch (error) { if (missing(error)) return { version: 1, accounts: {} }; throw error; }
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
				|| (process.getuid && stat.uid !== process.getuid()) || stat.size > MAX_FILE_BYTES) throw new SdkCredentialError("storage");
			const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
			let bytes = 0;
			while (bytes < buffer.length) {
				const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
				if (!count) break;
				bytes += count;
			}
			if (bytes > stat.size || bytes > MAX_FILE_BYTES) throw new SdkCredentialError("storage");
			return decode(buffer.subarray(0, bytes).toString("utf8"));
		} catch { throw new SdkCredentialError("storage"); }
		finally { if (fd !== undefined) closeSync(fd); }
	}
	/** Safe local metadata for one admitted account. @param provider ID. @returns No credentials. */
	summary(provider: string): SdkAccountSummary {
		admit(provider);
		try {
			const account = this.load().accounts[provider];
			return { state: account?.credential ? "stored" : "missing", method: account?.credential?.type,
				revision: account?.generation ?? MISSING_REVISION };
		} catch { return { state: "invalid", revision: "invalid", error: "Council account storage is unavailable or invalid." }; }
	}
	/** Read internal SDK credential only. @param provider ID. @param options Cancellation. @returns Credential copy. */
	read(provider: string, options: AuthOperationOptions = {}): Promise<Credential | undefined> {
		return this.barrier.track(async () => {
			admit(provider); options.signal?.throwIfAborted();
			const account = this.load().accounts[provider];
			this.checkRevision(provider, account);
			return account?.credential;
		});
	}
	/** List safe stored metadata, never resolve authentication. @param options Cancellation. @returns Credential types. */
	list(options: AuthOperationOptions = {}): Promise<readonly CredentialInfo[]> {
		return this.barrier.track(async () => {
			options.signal?.throwIfAborted();
			return Object.entries(this.load().accounts).flatMap(([providerId, account]) => account.credential ? [{ providerId, type: account.credential.type }] : []);
		});
	}
	/** Freeze confirmed account identity through SDK auth and dispatch. @param provider ID. @param revision Confirmed identity. @param task SDK operation. @returns Operation result. */
	inferenceAction<T>(provider: string, revision: string, task: () => Promise<T>): Promise<T> {
		return this.revisions.run({ provider, revision, synchronizationLost: false }, task);
	}
	/** Report only safe operation-scoped persistence loss, never a raw error. @returns Whether reconnect is required. */
	synchronizationFailed(): boolean { return this.revisions.getStore()?.synchronizationLost ?? false; }
	/** Check identity immediately before provider dispatch. @param provider ID. @returns Nothing. */
	assertRevision(provider: string): void { this.checkRevision(provider, this.load().accounts[provider]); }
	/** Check generation at authoritative read/locked reread. @param provider ID. @param account Latest account. @returns Nothing. */
	private checkRevision(provider: string, account: Account | undefined): void {
		const expected = this.revisions.getStore();
		if (expected && (expected.provider !== provider || expected.revision !== (account?.generation ?? MISSING_REVISION))) throw new SdkCredentialError("stale");
	}
	/** Mark SDK login/logout as explicit CAS account action. @param intent Expected identity and commit receipt. @param task SDK action. @returns Scoped result. */
	accountAction<T>(intent: AccountIntent, task: () => Promise<T>): Promise<T> {
		return this.intents.run(intent, () => this.barrier.scope(task));
	}
	/** Serialize SDK refresh or explicit login; refresh never creates accounts. @param provider ID. @param fn SDK mutation. @param options Lock-wait signal. @returns Persisted credential. */
	modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options: AuthOperationOptions = {}): Promise<Credential | undefined> {
		const intent = this.intents.getStore();
		return this.barrier.track(async () => {
			let observed: { generation?: string; credentialVersion?: string } | undefined;
			let candidate: Credential | undefined;
			try {
				return await this.mutate(provider, options, async file => {
					const current = file.accounts[provider];
					this.checkIntent(provider, current, intent);
					this.checkRevision(provider, current);
					observed = { generation: current?.generation, credentialVersion: current?.credentialVersion };
					const next = await fn(current?.credential);
					if (next === undefined) return current?.credential;
					if (!validSdkCredential(provider, next) || (!intent && (!current?.credential || current.credential.type !== next.type))) throw new SdkCredentialError("credential");
					candidate = structuredClone(next);
					file.accounts[provider] = { generation: intent ? randomUUID() : current!.generation, credentialVersion: randomUUID(), credential: candidate };
					await this.persist(file, intent);
					return structuredClone(candidate);
				});
			} catch (error) {
				if (!(error instanceof SdkCredentialError) || error.code !== "lock" || !observed || !candidate) throw error;
				// Storage-only recovery. Never rerun the refresh/login callback or write under the lost lease.
				const recovered = await this.mutate(provider, {}, async fresh => {
					const current = fresh.accounts[provider];
					if (current?.generation !== observed!.generation || current?.credentialVersion !== observed!.credentialVersion) throw new SdkCredentialError("lock");
					this.checkIntent(provider, current, intent);
					this.checkRevision(provider, current);
					fresh.accounts[provider] = { generation: intent ? randomUUID() : current!.generation,
						credentialVersion: randomUUID(), credential: candidate! };
					await this.persist(fresh, intent);
					return structuredClone(candidate);
				});
				const scope = this.revisions.getStore(); if (scope) scope.synchronizationLost = false;
				return recovered;
			}
		});
	}
	/** Delete under same lock, retain generation tombstone to prevent stale login resurrection. @param provider ID. @param options Lock-wait signal. @returns Cleanup completion. */
	delete(provider: string, options: AuthOperationOptions = {}): Promise<void> {
		const intent = this.intents.getStore();
		return this.barrier.track(() => this.mutate(provider, options, async file => {
			const current = file.accounts[provider];
			this.checkIntent(provider, current, intent);
			if (!current?.credential) return;
			file.accounts[provider] = { generation: randomUUID(), credentialVersion: randomUUID() };
			await this.persist(file, intent);
		}));
	}
	/** Verify captured identity while holding lock. @param provider ID. @param account Latest account. @param intent Explicit action if any. @returns Nothing. */
	private checkIntent(provider: string, account: Account | undefined, intent: AccountIntent | undefined): void {
		if (intent && (intent.provider !== provider || intent.expectedRevision !== (account?.generation ?? MISSING_REVISION))) throw new SdkCredentialError("stale");
	}
	/** Bounded cancellable acquisition; entire refresh callback/write/unlock stays leased. @param provider ID. @param options Lock signal. @param task Locked mutation. @returns Result after unlock. */
	private async mutate<T>(provider: string, options: AuthOperationOptions, task: (file: AccountFile) => Promise<T>): Promise<T> {
		admit(provider);
		options.signal?.throwIfAborted();
		try {
			inspectDirectory(this.directory);
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			if (!inspectDirectory(this.directory)) throw new SdkCredentialError("storage");
			const end = Date.now() + 20_000;
			let release: (() => Promise<void>) | undefined;
			let compromised = false;
			let owner: fs.Stats | undefined;
			const lockPath = `${this.path}.lock`;
			/** Check stable lock-directory identity, independent of heartbeat mtime. @returns Ownership. */
			const ownsLock = (): boolean => {
				if (!owner) return true;
				try { const latest = lstatSync(lockPath); return latest.isDirectory() && !latest.isSymbolicLink()
					&& latest.ino === owner.ino && latest.dev === owner.dev && latest.birthtimeMs === owner.birthtimeMs; }
				catch { return false; }
			};
			// Prevent the library's cleanup/heartbeat from touching a replacement lock.
			const lockFs = { ...fs,
				/** @param path Lock path. @param callback Node callback. @returns Nothing. */
				mkdir: (path: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void): void => {
					fs.mkdir(path, { mode: 0o700 }, error => {
						if (!error && path === lockPath) {
							try { owner = lstatSync(lockPath); }
							catch { callback(Object.assign(new Error("Lock ownership lost."), { code: "ENOENT" })); return; }
						}
						callback(error);
					});
				},
				/** @param path Lock path. @param callback Node callback. @returns Nothing. */
				stat: (path: fs.PathLike, callback: (error: NodeJS.ErrnoException | null, stat?: fs.Stats) => void): void => {
					if (owner && path === lockPath && !ownsLock()) { callback(Object.assign(new Error("Lock ownership lost."), { code: "ENOENT" })); return; }
					fs.stat(path, callback);
				},
				/** @param path Lock path. @param atime Access time. @param mtime Heartbeat time. @param callback Node callback. @returns Nothing. */
				utimes: (path: fs.PathLike, atime: string | number | Date, mtime: string | number | Date, callback: (error: NodeJS.ErrnoException | null) => void): void => {
					if (owner && path === lockPath && !ownsLock()) { callback(Object.assign(new Error("Lock ownership lost."), { code: "ENOENT" })); return; }
					fs.utimes(path, atime, mtime, callback);
				},
				/** @param path Lock path. @param callback Node callback. @returns Nothing. */
				rmdir: (path: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void): void => {
					if (owner && path === lockPath && !ownsLock()) { callback(null); return; }
					fs.rmdir(path, callback);
				},
				/** @param path Lock path. @returns Nothing. */
				rmdirSync: (path: fs.PathLike): void => { if (!owner || path !== lockPath || ownsLock()) fs.rmdirSync(path); },
			};
			while (!release) {
				options.signal?.throwIfAborted();
				try {
					let stat;
					try { stat = lstatSync(lockPath); } catch (error) { if (!missing(error)) throw error; }
					if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))) throw new SdkCredentialError("storage");
					release = await lock(this.path, { realpath: false, stale: 60_000, update: 5_000, retries: 0,
						fs: lockFs, onCompromised: () => { compromised = true; } });
				} catch (error) {
					if (!record(error) || error.code !== "ELOCKED") throw error;
					if (Date.now() >= end) throw new SdkCredentialError("lock");
					await delay(20, undefined, { signal: options.signal });
				}
			}
			try {
				if (!ownsLock()) throw new SdkCredentialError("lock");
				options.signal?.throwIfAborted();
				const acquiredOwner = owner!;
				const file = this.load(); // Authoritative reread after whole-file lock.
				const snapshot = JSON.stringify(file);
				/** Fence late writers using ownership and every provider's generation/credential version. @returns Nothing. */
				const fence = (): void => {
					const latestOwner = lstatSync(`${this.path}.lock`);
					if (compromised || !latestOwner.isDirectory() || latestOwner.isSymbolicLink()
						|| latestOwner.ino !== acquiredOwner.ino || latestOwner.dev !== acquiredOwner.dev || latestOwner.birthtimeMs !== acquiredOwner.birthtimeMs
						|| JSON.stringify(this.load()) !== snapshot) throw new SdkCredentialError("lock");
				};
				return await this.compromises.run(fence, () => task(file));
			} finally {
				if (!ownsLock() && !compromised) {
					// Let proper-lockfile retire its internal lease before any newer local lease can be unlocked.
					const end = Date.now() + 6000;
					while (!compromised && Date.now() < end) await delay(10);
				}
				if (ownsLock() || compromised) {
					try { await release(); } catch (error) { if (!compromised) throw error; }
				}
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
	private readonly compromises = new AsyncLocalStorage<() => void>();
	/** Atomic restrictive write, syncing file and directory; mark receipt at rename commit. @param file Full preserved map. @param intent Explicit action. @returns Durable completion. */
	private async persist(file: AccountFile, intent?: AccountIntent): Promise<void> {
		const text = JSON.stringify(file);
		if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new SdkCredentialError("storage");
		const temp = join(this.directory, `auth.${randomUUID()}.tmp`);
		let handle;
		try {
			handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			await handle.chmod(0o600);
			await handle.writeFile(text, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			inspectDirectory(this.directory);
			this.load(); // Refuse a malformed/symlink target rather than overwriting it.
			try { this.compromises.getStore()?.(); }
			catch { throw new SdkCredentialError("lock"); }
			renameSync(temp, this.path); // No async gap between ownership/version fence and commit.
			if (intent) intent.receipt.changed = true;
			const directory = await open(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			try { await directory.sync(); } finally { await directory.close(); }
		} finally {
			await handle?.close();
			await unlink(temp).catch(() => undefined);
		}
	}
}
