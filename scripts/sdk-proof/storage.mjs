import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Proof-only cross-process CredentialStore. Atomic directory lock covers whole file.
 * Never abandon started OAuth rotation; caller cancellation applies while waiting for lock.
 */
export class LockedCredentials {
  pending = new Set();
  scopes = new AsyncLocalStorage();
  writes = 0;
  writeDelayMs = 0;
  unlockDelayMs = 0;
  writeStarts = 0;
  unlockStarts = 0;
  lockAttempts = 0;
  lockContentions = {};
  maxActive = 0;
  active = 0;
  /** @param {string} directory Council-owned temporary storage directory. */
  constructor(directory) { this.directory = directory; }
  /** Track storage work even when SDK stops awaiting it.
   * @param {Function} task Storage operation. @returns {Promise<unknown>} Operation result.
   */
  track(task) {
    const scope = this.scopes.getStore();
    const promise = Promise.resolve().then(task);
    // Lease starts synchronously, before lock acquisition or SDK refresh callback.
    this.pending.add(promise);
    scope?.add(promise);
    /** Release both operation and shutdown leases after unlock settles. */
    const release = () => { this.pending.delete(promise); scope?.delete(promise); };
    promise.then(release, release);
    return promise;
  }
  /** Await only this operation's storage work; global quiesce remains shutdown-only.
   * @param {Function} task Request/auth operation. @returns {Promise<unknown>} Operation result.
   */
  async runScope(task) {
    const scope = new Set();
    return this.scopes.run(scope, async () => {
      try { return await task(); }
      finally {
        while (scope.size) await Promise.allSettled([...scope]);
        await Promise.resolve();
        while (scope.size) await Promise.allSettled([...scope]);
      }
    });
  }
  /** Read full synthetic file internally; never expose it in receipts.
   * @returns {Promise<object>} Credential map.
   */
  async load() {
    try { return JSON.parse(await readFile(join(this.directory, 'auth.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  /** @param {string} providerId Provider key. @param {object} options Optional signal.
   * @returns {Promise<object|undefined>} Raw credential for SDK only.
   */
  read(providerId, options = {}) {
    return this.track(async () => { options.signal?.throwIfAborted(); return (await this.load())[providerId]; });
  }
  /** @param {object} options Optional signal. @returns {Promise<object[]>} Non-secret metadata. */
  list(options = {}) {
    return this.track(async () => {
      options.signal?.throwIfAborted();
      return Object.entries(await this.load()).map(([providerId, value]) => ({ providerId, type: value.type }));
    });
  }
  /** Acquire cross-process lock; no stale-lock guessing in short-lived fixture.
   * @param {AbortSignal|undefined} signal Caller lock-wait signal. @param {string} providerId Mutation key.
   * @returns {Promise<Function>} Awaited lock release callback.
   */
  async lock(signal, providerId) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'auth.lock');
    const deadline = Date.now() + 20000;
    for (;;) {
      signal?.throwIfAborted();
      try {
        this.lockAttempts++;
        await mkdir(path, { mode: 0o700 });
        /** Remove lock only after callback and atomic persistence settle. */
        return async () => {
          this.unlockStarts++;
          if (this.unlockDelayMs) await delay(this.unlockDelayMs);
          await rm(path, { recursive: true });
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        this.lockContentions[providerId] = (this.lockContentions[providerId] ?? 0) + 1;
        if (Date.now() > deadline) throw new Error('Proof lock deadline exceeded');
        await delay(5, undefined, signal ? { signal } : undefined);
      }
    }
  }
  /** Mutate under one file lock, preserving other providers.
   * @param {string} providerId Provider key. @param {Function} fn SDK mutation callback.
   * @param {object} options Optional lock-wait signal.
   * @returns {Promise<object|undefined>} Post-write credential.
   */
  modify(providerId, fn, options = {}) {
    return this.track(async () => {
      const release = await this.lock(options.signal, providerId);
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        options.signal?.throwIfAborted();
        const all = await this.load();
        const next = await fn(all[providerId]);
        if (next !== undefined) {
          this.writeStarts++;
          if (this.writeDelayMs) await delay(this.writeDelayMs);
          all[providerId] = next;
          await this.persist(all);
        }
        return all[providerId];
      } finally { this.active--; await release(); }
    });
  }
  /** Commit rotated token atomically before releasing lock.
   * @param {object} all Credential map. @returns {Promise<void>}
   */
  async persist(all) {
    const path = join(this.directory, `auth.${process.pid}.tmp`);
    await writeFile(path, JSON.stringify(all), { mode: 0o600 });
    await rename(path, join(this.directory, 'auth.json'));
    this.writes++;
  }
  /** Serialize logout against refresh rather than racing file writes.
   * @param {string} providerId Provider key. @param {object} options Optional lock-wait signal.
   * @returns {Promise<void>}
   */
  delete(providerId, options = {}) {
    return this.track(async () => {
      const release = await this.lock(options.signal, providerId);
      try {
        options.signal?.throwIfAborted();
        const all = await this.load();
        delete all[providerId];
        await this.persist(all);
      } finally { await release(); }
    });
  }
  /** Wait beyond SDK's early abort return for all owned storage operations.
   * @returns {Promise<void>} Settles after callbacks, writes and lock releases.
   */
  async quiesce() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    await Promise.resolve();
    if (this.pending.size) await this.quiesce();
  }
}

/** Explicit app-owned model catalog store; tracks pending writes.
 * Used only by this proof, not proposed as production persistence.
 */
export class OwnModelsStore {
  entries = new Map();
  pending = new Set();
  writeDelayMs = 0;
  writes = 0;
  /** @param {string} id Provider ID. @param {object} options Optional signal.
   * @returns {Promise<object|undefined>} Cached catalog.
   */
  async read(id, options = {}) { options.signal?.throwIfAborted(); return this.entries.get(id); }
  /** @param {string} id Provider ID. @param {object} entry Catalog entry.
   * @param {object} options Optional signal. @returns {Promise<void>}
   */
  write(id, entry, options = {}) {
    const promise = (async () => {
      if (this.writeDelayMs) await delay(this.writeDelayMs);
      options.signal?.throwIfAborted();
      this.entries.set(id, structuredClone(entry));
      this.writes++;
    })();
    this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  /** @param {string} id Provider ID. @param {object} options Optional signal. @returns {Promise<void>} */
  async delete(id, options = {}) { options.signal?.throwIfAborted(); this.entries.delete(id); }
  /** @returns {Promise<void>} Settles after every catalog write. */
  async quiesce() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
}
