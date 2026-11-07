// Shared by the split and measure tests: runs a tool the way its users do (a
// child process) from a copy in a temp folder (split.mjs, measure.mjs), and builds the stub
// `claude` that measure's tests put first on PATH. No test ever reaches a real
// claude: PATH holds the stub's folder and the system's /usr/bin and /bin only,
// and stubEnv() checks that no other `claude` is found there.
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(TEST_DIR, '..', 'skills', 'claude-config-tune');

// Neither bold nor a parent's colour setting may leak into the output under test.
delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;

// A fresh temp folder, removed when `fn` finishes (a promise it returns is awaited).
export async function withTemp(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cct-trim-')));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A copy of a tool, inside `dir`.
export function installTool(dir, name) {
  const to = path.join(dir, `${name}.mjs`);
  copyFileSync(path.join(SKILL_DIR, `${name}.mjs`), to);
  return to;
}

export function runTool(script, args, { env = {}, cwd } = {}) {
  const base = { PATH: '/usr/bin:/bin', HOME: path.dirname(script), ...env };
  return spawnSync(process.execPath, [script, ...args], { env: base, cwd, encoding: 'utf8', timeout: 30000 });
}

export const lines = (stdout) => stdout.replace(/\n$/, '').split('\n');

// The sample CLAUDE.md files kept in test/fixtures.
export const fixture = (name) => readFileSync(path.join(TEST_DIR, 'fixtures', name), 'utf8');
export const FIXTURES = ['global-claude.md', 'project-claude.md'];

// A `claude` stand-in. For `-p ... --append-system-prompt-file <file>` it prints
// the JSON a real run prints, with a prompt size that follows the file's size:
// 10 input tokens, ceil(bytes / 4) cache-creation tokens, 3 cache-read tokens.
// It appends one JSON line per run to $STUB_LOG ({ args, cwd }) and, with
// $STUB_SLEEP set, an S line when a run starts and an E line when it ends, so a
// test can read how many ran at once. A chunk holding STUBFAIL makes it exit 1,
// STUBERR makes it report is_error, STUBNEG makes the run come in tiny, and
// $STUB_FAIL_BASELINE fails the baseline run. \`auth status --json\` prints
// $STUB_AUTH (default: a claude.ai login on firstParty) and exits
// $STUB_AUTH_EXIT (default 0), logging its cwd to $STUB_LOG.auth, not as a run.
export const SUBSCRIPTION_LOGIN = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' };

export function installStub(dir) {
  const stubDir = path.join(dir, 'stub-bin');
  mkdirSync(stubDir, { recursive: true });
  const file = path.join(stubDir, 'claude');
  writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === 'auth') {
  fs.appendFileSync(process.env.STUB_LOG + '.auth', JSON.stringify({ args: a, cwd: process.cwd() }) + '\\n');
  console.log(process.env.STUB_AUTH ?? ${JSON.stringify(JSON.stringify(SUBSCRIPTION_LOGIN))});
  process.exit(Number(process.env.STUB_AUTH_EXIT || 0));
}
const f = a[a.indexOf('--append-system-prompt-file') + 1];
const t = fs.readFileSync(f, 'utf8');
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args: a, cwd: process.cwd() }) + '\\n');
const ms = Number(process.env.STUB_SLEEP || 0);
const out = () => {
  if (t.includes('STUBFAIL') || (process.env.STUB_FAIL_BASELINE && f.endsWith('baseline.txt'))) {
    console.error('stub: boom');
    process.exit(1);
  }
  if (t.includes('STUBERR')) return console.log(JSON.stringify({ is_error: true, result: 'stub says no' }));
  const usage = t.includes('STUBNEG')
    ? { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    : { input_tokens: 10, cache_creation_input_tokens: Math.ceil(Buffer.byteLength(t) / 4), cache_read_input_tokens: 3 };
  console.log(JSON.stringify({ is_error: false, result: 'OK', usage }));
};
if (!ms) out();
else {
  fs.appendFileSync(process.env.STUB_LOG + '.conc', 'S\\n');
  setTimeout(() => { fs.appendFileSync(process.env.STUB_LOG + '.conc', 'E\\n'); out(); }, ms);
}
`);
  chmodSync(file, 0o755);
  return stubDir;
}

// The environment for a measure run that may use only the stub, plus `extra`.
export function stubEnv(dir, extra = {}) {
  const stubDir = installStub(dir);
  const env = { PATH: `${stubDir}${path.delimiter}/usr/bin${path.delimiter}/bin`, STUB_LOG: path.join(dir, 'stub.log'), ...extra };
  for (const d of env.PATH.split(path.delimiter)) {
    try {
      accessSync(path.join(d, 'claude'), constants.X_OK);
      if (d !== stubDir) throw new Error(`a real claude is on the test PATH: ${d}`);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return env;
}

// How many stub runs are in flight at the peak, from the S/E lines.
export function peakConcurrency(dir) {
  let now = 0;
  let peak = 0;
  for (const l of readFileSync(path.join(dir, 'stub.log.conc'), 'utf8').trim().split('\n')) {
    now += l === 'S' ? 1 : -1;
    peak = Math.max(peak, now);
  }
  return peak;
}

// One run per line the stub logged.
export function stubRuns(dir) {
  try {
    return readFileSync(path.join(dir, 'stub.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
