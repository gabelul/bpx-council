/** Audit synthetic sentinel access and reject subprocesses before SDK import. */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { resolve } = require('node:path');
const audit = { sentinelAccess: [], subprocessAttempts: [] };
globalThis.sdkProofAudit = audit;
/** Record sentinel operations without recording file contents or credentials.
 * @param {string} method Filesystem operation.
 * @param {unknown} path Candidate path.
 * @returns {void}
 */
function inspect(method, path) {
  if (typeof path !== 'string' && !(path instanceof URL)) return;
  const value = path instanceof URL ? path.pathname : path;
  if (resolve(value).startsWith(resolve(process.env.PROOF_SENTINEL))) {
    audit.sentinelAccess.push({ method, file: value.split('/').at(-1) });
    throw Object.assign(new Error('Synthetic sentinel access denied'), { code: 'EPERM' });
  }
}
for (const name of ['readFile', 'readFileSync', 'open', 'openSync', 'access', 'accessSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'readdir', 'readdirSync', 'existsSync', 'createReadStream', 'realpath', 'realpathSync']) {
  const original = fs[name];
  /** Audit first path before forwarding unchanged arguments to Node fs. */
  fs[name] = function (...args) { inspect(name, args[0]); return original.apply(this, args); };
}
for (const name of ['readFile', 'open', 'access', 'stat', 'lstat', 'readdir', 'realpath']) {
  const original = fsp[name];
  /** Audit first path before forwarding unchanged arguments to Node promises. */
  fsp[name] = async function (...args) { inspect(name, args[0]); return original.apply(this, args); };
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  /** Reject native helpers; retain method name only, never argv or tokens. */
  cp[name] = function () {
    audit.subprocessAttempts.push(name);
    throw new Error('Subprocesses forbidden in SDK proof');
  };
}
syncBuiltinESMExports();
