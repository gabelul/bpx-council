#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { startMock, synthetic } from './mock.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const repo = resolve(source, '../..');
const names = ['pi-coding-agent', 'pi-ai', 'pi-agent-core', 'pi-codemode', 'pi-mcp', 'pi-tui', 'chord', 'pi-telemetry'];
const dependencies = Object.fromEntries(names.map(name => [`@earendil-works/${name}`, '1.1.0']));
const plainEnv = { PATH: '', HOME: '', LANG: 'C', LC_ALL: 'C', TMPDIR: tmpdir() };
let phase = 'preflight';
let activePrefix;
/** Execute argv without shell. Capture logs, never print raw SDK errors.
 * @param {string} executable Program. @param {string[]} args Arguments.
 * @param {object} options Child environment/cwd and log destination.
 * @returns {Promise<object>} Exit code, wall time and captured stdout.
 */
async function command(executable, args, options = {}) {
  const start = performance.now();
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', async (code, signal) => {
      try {
        // Built-in errors may echo credentials; artifacts never do.
        const redact = text => Object.values(synthetic).reduce((value, token) => value.replaceAll(token, '[fixture-credential-redacted]'), text);
        if (options.log) await writeFile(options.log, redact(stdout + stderr));
        resolveRun({ code, signal, elapsedMs: performance.now() - start, stdout: redact(stdout) });
      } catch (error) { reject(error); }
    });
  });
}
/** Hash all pre-existing tracked/untracked files, excluding only owned proof directory.
 * @returns {Promise<object>} File hashes and current changed-path count.
 */
async function snapshot() {
  const listing = await command('/usr/bin/git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repo, env: { ...plainEnv, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  if (listing.code !== 0) throw new Error('Git snapshot failed');
  const hashes = {};
  for (const path of listing.stdout.split('\0').filter(Boolean)) {
    if (path.startsWith('scripts/sdk-proof/')) continue;
    try { hashes[path] = createHash('sha256').update(await readFile(join(repo, path))).digest('hex'); }
    catch (error) { if (error.code !== 'EISDIR') throw error; }
  }
  const status = await command('/usr/bin/git', ['status', '--porcelain=v1', '-z'],
    { cwd: repo, env: { ...plainEnv, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  return { hashes, priorChangeCount: status.stdout.split('\0').filter(p => p && !p.includes('scripts/sdk-proof/')).length };
}
/** Measure apparent installed file bytes, physical allocation and file count.
 * @param {string} path Installed dependency tree. @returns {Promise<object>} Footprint.
 */
async function footprint(path) {
  let bytes = 0, allocatedBytes = 0, files = 0;
  /** Visit package files only. @param {string} dir Directory. @returns {Promise<void>} */
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) { const info = await stat(file); bytes += info.size; allocatedBytes += info.blocks * 512; files++; }
    }
  }
  await visit(path);
  return { bytes, allocatedBytes, files };
}
/** Write pinned install manifest, with overrides for every transitive Earendil package.
 * @param {string} path Isolated prefix. @param {object} deps Exact dependency pins.
 * @returns {Promise<void>}
 */
async function manifest(path, deps) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: deps,
    overrides: Object.fromEntries(Object.keys(deps).map(name => [name, '1.1.0'])) }, null, 2));
}
/** Run SDK process in OS loopback sandbox, empty HOME/PATH and hostile synthetic ambient auth.
 * @param {string} prefix Isolated install. @param {string} script Copied proof script.
 * @param {object} extra Extra synthetic environment. @returns {Promise<object>} Process receipt.
 */
async function sandbox(prefix, script, extra = {}) {
  const env = { ...plainEnv, HOME: join(prefix, 'home'), PROOF_SENTINEL: join(prefix, 'sentinel'),
    PI_CODING_AGENT_DIR: join(prefix, 'sentinel'), OPENAI_API_KEY: synthetic.ambient,
    ANTHROPIC_API_KEY: synthetic.ambient, ANTHROPIC_OAUTH_TOKEN: synthetic.ambient,
    GEMINI_API_KEY: synthetic.ambient, COPILOT_GITHUB_TOKEN: synthetic.ambient,
    AWS_ACCESS_KEY_ID: synthetic.ambient, AWS_SECRET_ACCESS_KEY: synthetic.ambient,
    AWS_BEARER_TOKEN_BEDROCK: synthetic.ambient, AWS_PROFILE: 'fixture-profile',
    AWS_SHARED_CREDENTIALS_FILE: join(prefix, 'sentinel', 'aws-credentials'),
    GOOGLE_APPLICATION_CREDENTIALS: join(prefix, 'sentinel', 'adc.json'),
    GOOGLE_CLOUD_PROJECT: 'fixture-project', GOOGLE_CLOUD_LOCATION: 'fixture-location',
    GOOGLE_CLOUD_API_KEY: synthetic.ambient, HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '', NO_PROXY: '*',
    ...extra };
  return command('/usr/bin/sandbox-exec', ['-D', `PRIVATE_HOME=${homedir()}`, '-D', `PRIVATE_REPO=${repo}`,
    '-f', join(prefix, 'loopback.sb'), join(prefix, 'node'), '--require', join(prefix, 'guard.cjs'), join(prefix, script)],
    { cwd: prefix, env, log: join(prefix, `${extra.PROOF_LOG ?? script}.log`) });
}
/** Verify all installed Earendil versions and preserve npm integrity metadata.
 * @param {string} prefix Temporary installation. @returns {Promise<object[]>} Package evidence.
 */
async function packageEvidence(prefix) {
  const lock = JSON.parse(await readFile(join(prefix, 'package-lock.json'), 'utf8'));
  const evidence = Object.entries(lock.packages).filter(([path]) => path.includes('node_modules/@earendil-works/'))
    .map(([path, pkg]) => ({ path, version: pkg.version, resolved: pkg.resolved, integrity: pkg.integrity }));
  if (evidence.some(pkg => pkg.version !== '1.1.0')) throw new Error('Earendil dependency drift');
  return evidence;
}
/** Orchestrate installation and offline hard gate; production repository files remain unchanged.
 * @returns {Promise<void>}
 */
async function main() {
  const version = process.versions.node.split('.').map(Number);
  if (version[0] < 22 || (version[0] === 22 && version[1] < 19)) throw new Error('Node >=22.19 required');
  if (process.platform !== 'darwin') throw new Error('This runner requires macOS sandbox-exec; no unsafe fallback');
  const before = await snapshot();
  const supplied = process.argv.indexOf('--prefix');
  const prefix = supplied >= 0 ? resolve(process.argv[supplied + 1]) : await mkdtemp(join(tmpdir(), 'council-sdk-proof-'));
  if (prefix.startsWith(repo + '/') || prefix === repo || prefix.startsWith(homedir() + '/')) throw new Error('Prefix must be outside repo and real HOME');
  activePrefix = prefix;
  await mkdir(prefix, { recursive: true });
  for (const entry of ['suite-own', 'suite-results.json', 'shared', 'qa.json']) {
    try { await stat(join(prefix, entry)); throw new Error('Existing scenario state rejected; use fresh prefix'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(join(prefix, 'before.json'), JSON.stringify(before, null, 2));
  await copyFile(process.execPath, join(prefix, 'node'));
  for (const file of (await readdir(source)).filter(file => /\.(mjs|cjs|sb)$/.test(file))) await copyFile(join(source, file), join(prefix, file));
  for (const directory of ['home', 'install-home', 'sentinel', 'shared']) await mkdir(join(prefix, directory), { recursive: true });
  for (const file of ['auth.json', 'models.json', 'settings.json', 'adc.json', 'aws-credentials', 'AGENTS.md'])
    await writeFile(join(prefix, 'sentinel', file), JSON.stringify({ fixture: 'must-not-read' }));
  await writeFile(join(prefix, 'empty-user.npmrc'), '');
  await writeFile(join(prefix, 'empty-global.npmrc'), '');
  const npm = process.env.npm_execpath ?? join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const installEnv = { ...plainEnv, HOME: join(prefix, 'install-home'), PATH: dirname(process.execPath),
    npm_config_userconfig: join(prefix, 'empty-user.npmrc'), npm_config_globalconfig: join(prefix, 'empty-global.npmrc'),
    npm_config_cache: join(prefix, 'npm-cache') };
  phase = 'install-published-sdk';
  await manifest(prefix, dependencies);
  const install = await command(process.execPath, [npm, 'install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: prefix, env: installEnv, log: join(prefix, 'install.log') });
  if (install.code !== 0) throw new Error('Isolated npm installation failed; inspect install.log');
  const packages = await packageEvidence(prefix);
  const fullFootprint = await footprint(join(prefix, 'node_modules'));
  phase = 'sdk-suite';
  const suite = await sandbox(prefix, 'suite.mjs');
  const suiteResults = JSON.parse(await readFile(join(prefix, 'suite-results.json'), 'utf8'));
  if (suiteResults.some(r => !r.pass && r.id.startsWith('sandbox-'))) throw new Error('Egress gate failed; no further SDK calls');
  phase = 'ModelRuntime-ambient-probe';
  const ambient = await sandbox(prefix, 'ambient-probe.mjs');
  const ambientResult = JSON.parse(await readFile(join(prefix, 'ambient-probe.json'), 'utf8'));
  const rawLimitations = [{ id: 'ModelRuntime-missing-own-auth-refuses', pass: ambientResult.missingOwnAuthRefused,
    kind: 'sdk-limitation', evidence: ambientResult }, ...suiteResults.filter(r => r.kind === 'sdk-limitation')];
  await writeFile(join(prefix, 'preliminary.json'), JSON.stringify({ rawLimitations, suiteExit: suite.code, ambientExit: ambient.code }, null, 2));
  console.log(JSON.stringify({ phase: 'preliminary', prefix, sdkLimitations: rawLimitations.filter(r => !r.pass).map(r => r.id),
    requirementFailures: suiteResults.filter(r => !r.pass && r.kind === 'requirement').map(r => r.id) }));

  phase = 'cross-process-oauth';
  // Two OS-sandboxed processes share locked credentials, but never import native CLIs.
  await writeFile(join(prefix, 'shared', 'auth.json'), JSON.stringify({ anthropic: {
    type: 'oauth', access: synthetic.access, refresh: synthetic.refresh, expires: 0 } }), { mode: 0o600 });
  const mock = await startMock();
  mock.state.oauthDelayMs = 100;
  let workers;
  try {
    const pendingWorkers = ['openai', 'xai'].map((provider, index) => sandbox(prefix, 'suite.mjs', {
      PROOF_ROLE: 'worker', PROOF_SHARED: join(prefix, 'shared'), PROOF_MOCK: mock.baseUrl,
      PROOF_READY: join(prefix, `worker-ready-${index}.json`), PROOF_GO: join(prefix, 'worker-go'),
      PROOF_OTHER_PROVIDER: provider, PROOF_RESULT: join(prefix, `worker-${index}.json`), PROOF_LOG: `worker-${index}`,
    }));
    const ready = [];
    const readyDeadline = Date.now() + 15000;
    for (let index = 0; index < 2; index++) {
      for (;;) {
        try { ready[index] = JSON.parse(await readFile(join(prefix, `worker-ready-${index}.json`), 'utf8')); break; }
        catch (error) {
          if (error.code !== 'ENOENT' || Date.now() > readyDeadline) throw error;
          await new Promise(resolveWait => setTimeout(resolveWait, 10));
        }
      }
    }
    await writeFile(join(prefix, 'worker-go'), 'start');
    workers = await Promise.all(pendingWorkers);
    const workerResults = await Promise.all([0, 1].map(async index => JSON.parse(await readFile(join(prefix, `worker-${index}.json`), 'utf8'))));
    const data = JSON.parse(await readFile(join(prefix, 'shared', 'auth.json'), 'utf8'));
    const refreshes = mock.state.oauthRequests;
    suiteResults.push({ id: 'cross-process-single-oauth-refresh', pass: workers.every(w => w.code === 0) && refreshes === 1
      && ready.every(r => r.expired) && workerResults.some(r => r.oauthLockContentions > 0),
      kind: 'requirement', evidence: { workerExitCodes: workers.map(w => w.code), refreshes,
        bothReachedExpiredCredential: ready.every(r => r.expired), oauthLockContentions: workerResults.map(r => r.oauthLockContentions) } });
    suiteResults.push({ id: 'cross-process-other-provider-updates-preserved', pass: !!data.openai && !!data.xai
      && data.anthropic?.refresh === synthetic.rotatedRefresh, kind: 'requirement',
      evidence: { credentialProviders: Object.keys(data).sort(), rotatedCredentialPreserved: data.anthropic?.refresh === synthetic.rotatedRefresh } });
  } finally { await mock.stop(); }
  phase = 'startup-footprint';
  const samples = {};
  for (const mode of ['ModelRuntime', 'createModels']) {
    samples[mode] = [];
    for (let index = 0; index < 5; index++) {
      const resultPath = join(prefix, `startup-${mode}-${index}.json`);
      const run = await sandbox(prefix, 'startup.mjs', { PROOF_STARTUP: mode, PROOF_RESULT: resultPath, PROOF_LOG: `startup-${mode}-${index}` });
      if (run.code !== 0) throw new Error('Startup probe failed');
      samples[mode].push({ ...JSON.parse(await readFile(resultPath, 'utf8')), processWallMs: run.elapsedMs });
    }
  }
  const aiPrefix = join(prefix, 'ai-only');
  await manifest(aiPrefix, { '@earendil-works/pi-ai': '1.1.0', '@earendil-works/pi-telemetry': '1.1.0' });
  const aiInstall = await command(process.execPath, [npm, 'install', '--prefix', aiPrefix, '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: aiPrefix, env: installEnv, log: join(prefix, 'ai-only-install.log') });
  if (aiInstall.code !== 0) throw new Error('Lower-level-only install failed');
  await packageEvidence(aiPrefix);
  const lowerFootprint = await footprint(join(aiPrefix, 'node_modules'));
  phase = 'lower-only-full-suite';
  await copyFile(process.execPath, join(aiPrefix, 'node'));
  for (const file of (await readdir(source)).filter(file => /\.(mjs|cjs|sb)$/.test(file))) await copyFile(join(source, file), join(aiPrefix, file));
  for (const directory of ['home', 'sentinel']) await mkdir(join(aiPrefix, directory));
  for (const file of ['auth.json', 'models.json', 'settings.json', 'adc.json', 'aws-credentials', 'AGENTS.md'])
    await writeFile(join(aiPrefix, 'sentinel', file), JSON.stringify({ fixture: 'must-not-read' }));
  const lowerOnlyRun = await sandbox(aiPrefix, 'suite.mjs', { PROOF_SKIP_RUNTIME: '1' });
  const lowerOnlyResults = JSON.parse(await readFile(join(aiPrefix, 'suite-results.json'), 'utf8'));
  suiteResults.push({ id: 'lower-only-dependencies-full-suite', pass: lowerOnlyRun.code === 0
    && !lowerOnlyResults.some(r => !r.pass && r.kind === 'requirement'), kind: 'requirement',
    evidence: { exitCode: lowerOnlyRun.code, requirementFailures: lowerOnlyResults.filter(r => !r.pass && r.kind === 'requirement').map(r => r.id),
      packages: (await packageEvidence(aiPrefix)).map(p => p.path) } });
  phase = 'final-receipt';
  const after = await snapshot();
  const changed = Object.keys(before.hashes).filter(path => after.hashes[path] !== before.hashes[path]);
  const added = Object.keys(after.hashes).filter(path => !(path in before.hashes));
  suiteResults.push({ id: 'prior-files-preserved', pass: changed.length === 0 && added.length === 0,
    kind: 'requirement', evidence: { priorChangeCount: before.priorChangeCount, changed, added } });
  const failures = suiteResults.filter(r => !r.pass && r.kind === 'requirement');
  const qa = { schemaVersion: 1, scope: 'FIRST HARD GATE only; no production integration',
    status: failures.length ? 'FAIL' : 'CONDITIONAL-PASS-LOWER-LEVEL', node: process.version,
    generatedAt: new Date().toISOString(), prefix, command: 'node scripts/sdk-proof/run.mjs',
    sdkPackages: packages, installation: { codingAgentMs: install.elapsedMs, lowerOnlyMs: aiInstall.elapsedMs,
      scriptsDisabled: true, codingAgent: fullFootprint, lowerOnly: lowerFootprint }, startup: samples,
    rawSDKFailures: rawLimitations.filter(r => !r.pass), checks: suiteResults,
    remainingRequirementFailures: failures.map(r => r.id),
    routeContract: { providerId: 'openai | anthropic (proof allowlist)', modelId: 'exact SDK catalog ID',
      effort: 'validated SDK model thinking level', auth: 'Council-owned CredentialStore entry required',
      noTools: true, noCatalogNetworkRefresh: true, noAmbientAuth: true,
      cancellation: 'abort signal + operation-scoped storage lease barrier; separate shutdown drain' },
    artifacts: { qa: join(source, 'qa.json'), matrix: join(source, 'provider-matrix.json'),
      logs: ['install.log', 'ai-only-install.log', 'suite.mjs.log', 'ambient-probe.mjs.log', 'worker-0.log', 'worker-1.log'].map(file => join(prefix, file)),
      results: ['suite-results.json', 'ambient-probe.json', 'preliminary.json', 'suite-wire.json', 'startup.json', 'package-lock.json',
        'ai-only/suite-results.json', 'ai-only/suite.mjs.log', 'ai-only/package-lock.json'].map(file => join(prefix, file)) } };
  const rendered = JSON.stringify(qa, null, 2);
  if (Object.values(synthetic).some(token => rendered.includes(token))) throw new Error('Credential appeared in receipt');
  await writeFile(join(prefix, 'qa.json'), rendered);
  await writeFile(join(source, 'qa.json'), rendered);
  await copyFile(join(prefix, 'provider-matrix.json'), join(source, 'provider-matrix.json'));
  console.log(JSON.stringify({ status: qa.status, prefix, qa: join(source, 'qa.json'), failures: qa.remainingRequirementFailures }));
  if (failures.length) process.exitCode = 1;
}
main().catch(async error => {
  const failure = { status: 'FAIL', phase, prefix: activePrefix, errorCode: error.code ?? 'runner-error', name: error.name };
  if (activePrefix) await writeFile(join(activePrefix, 'runner-failure.json'), JSON.stringify(failure, null, 2));
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
});
