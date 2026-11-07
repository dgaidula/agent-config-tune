#!/usr/bin/env node
// measure - price each chunk of a CLAUDE.md in tokens, split.mjs's chunks
// (claude-config-tune's trim method).
//
// Usage:
//   measure <chunk-dir> [--workers <n>] [--go]
//   measure --help | --version | --cheat
//
// How a chunk is priced:
//   For each <chunk-dir>/*.txt, one `claude -p` run on the haiku model with the
//   chunk appended to the system prompt (--append-system-prompt-file), and one
//   baseline run that appends a one-line file. A chunk's cost is the prompt
//   tokens of its run (input + cache creation + cache read) minus the baseline's.
//
//   Heading files (<section>--heading.txt, title.txt) are not priced. The runs
//   happen in a fresh empty folder, so no project CLAUDE.md adds to either side.
//
// Spend, and what it needs:
//   A dry run (the default) runs nothing: it lists what --go would price. With
//   --go it makes one baseline run plus one run per chunk, on your Claude
//   subscription login only. It needs `claude` on PATH, logged in.
//
//   It refuses to run, dry run included, while a variable that would send
//   claude to an API account is set. Unset it and run again; measure never
//   unsets one for you.
//
//   The variables are ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
//   ANTHROPIC_AWS_API_KEY, ANTHROPIC_FOUNDRY_API_KEY,
//   ANTHROPIC_FOUNDRY_AUTH_TOKEN, AWS_BEARER_TOKEN_BEDROCK,
//   ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_PROFILE, CLAUDE_CODE_USE_BEDROCK,
//   CLAUDE_CODE_USE_VERTEX, CLAUDE_CODE_USE_FOUNDRY,
//   CLAUDE_CODE_USE_ANTHROPIC_AWS, CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD and
//   CLAUDE_CODE_USE_MANTLE.
//
//   Then, dry run included, it asks `claude auth status --json` (which spends
//   nothing) and refuses unless it says loggedIn true, authMethod claude.ai and
//   apiProvider firstParty, so a settings apiKeyHelper or env key is caught too.
//   The dry run names the login it would use.
//
// Assumes:
//   A folder of chunks written by split.mjs, one .txt file per chunk.
//
//   It does not retry a failed run: that chunk is a fail item and the rest go
//   on. A run that comes back below the baseline is a warn.
//
// Known limits:
//   The login check trusts `claude auth status --json` and its field names as
//   claude 2.1.319 prints them; a later claude that renames one is refused,
//   not passed. measure has run only against a stub claude, never live.
//
// Output modes (all rendered from the same item objects):
//   (default)   human    A block per chunk, a blank line between blocks.
//   --brief              Exactly one line per item: <verdict> <summary>  <name>
//                        (no padding, no glyph), plus a parenthesised reason
//                        whenever the verdict is not ok, cut at 160 characters.
//                        Ends with a summary line.
//   --json               A stable object on stdout, nothing else:
//                        { tool, version, contract, command, effect, exit,
//                          items: [...], summary: { ok, warn, skip, refuse,
//                          fail }, next }   (contract "mjs-tool/3"). Each chunk's
//                        data carries its tokens, bytes and file; the `total`
//                        item carries the sum.
//   --quiet             The summary line only.
//   Every text mode then ends with one `next:` line, the tool's advice on the
//   next step. --json cannot be combined with --brief or --quiet.
//
// Flags:
//   --workers <n>  How many runs go at once, 1 to 16 (default 4).
//   --go           Make the runs. Without it the run is a dry run.
//   --brief        one line per item (see above).
//   --json         machine-readable output (see above).
//   --quiet        summary line only.
//   --help, -h     print this header.
//   --version      print "measure <version>".
//   --cheat        print a short card of common invocations in tldr page format
//                  and exit 0, printing nothing else.
//
// Exit codes:
//   0   all items ok (skips are not failures).
//   1   partial: a refusal (no such folder, no chunks), a run that failed, or a
//       chunk that came back below the baseline.
//   2   usage error (unknown flag, no folder, a bad --workers, bad mode combo).
//   3   could not run to completion: an API-key variable is set, `claude` is not
//       on PATH, `claude auth status` reports anything but a claude.ai
//       subscription login, or an internal error.

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// ---- the cheat card (printed by --cheat) ------------------------------------

const CHEAT = `# measure

> Price each chunk of a CLAUDE.md in tokens with claude -p on the subscription login.
> More information: measure --help.

- Show the chunks that would be priced, running nothing (dry run):

\`measure {{path/to/chunks}}\`

- Show them one line per chunk:

\`measure {{path/to/chunks}} --brief\`

- Price the chunks (makes one claude run per chunk, plus a baseline):

\`measure {{path/to/chunks}} --go\`

- Price them with eight runs at once and keep the result as JSON:

\`measure {{path/to/chunks}} --workers 8 --go --json\``;

// ---- what it runs --------------------------------------------------------------

// Environment variables that point claude at an API account instead of the
// subscription login (code.claude.com/docs/en/env-vars, read 2026-11-06).
// The last three are from `claude auth status --json` (claude 2.1.319), which
// reports a third-party provider for each.
const AUTH_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_PROFILE',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE',
];
const AUTH_TIMEOUT_MS = 30000; // auth status reads local state; this only ends a hang
const PROMPT = 'Reply with OK.';
const MODEL = 'haiku';
const BASELINE_TEXT = 'x\n';
const RUN_TIMEOUT_MS = 180000; // a haiku run that says OK is seconds; this only ends a hang

// ---- verdict semantics (the single source of truth) -------------------------

// Facts on an item -> its verdict. Pure: reads item fields, returns a string.
function verdict(item) {
  if (item.error) return 'fail';
  if (item.refused) return 'refuse';
  if (item.skipped) return 'skip';
  if (item.tokens !== undefined && item.tokens < 0) return 'warn';
  return 'ok';
}

// ---- environment check ------------------------------------------------------

// The first of AUTH_ENV that is set to something, or null. An empty value is
// how a shell clears a variable, and claude reads it as unset.
function authEnvSet(env = process.env) {
  return AUTH_ENV.find((name) => typeof env[name] === 'string' && env[name].trim() !== '') ?? null;
}

// The first executable file named claude on PATH, or null.
function findClaude(env = process.env) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, 'claude');
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch { /* not here */ }
  }
  return null;
}

// Which account claude would use, from `claude auth status --json`, asked in a
// fresh empty folder as the runs are (a settings apiKeyHelper or env key shows
// up here, which the variable list cannot see). { ok, message, login }: ok only
// for a logged-in claude.ai login on Anthropic's own API (firstParty).
function checkLogin(claude) {
  const work = mkdtempSync(join(tmpdir(), 'measure-auth-'));
  let r;
  try {
    r = spawnSync(claude, ['auth', 'status', '--json'], { cwd: work, encoding: 'utf8', timeout: AUTH_TIMEOUT_MS });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : `exit ${r.status}: ${(r.stderr ?? '').trim().split('\n')[0] || 'no message'}`;
    return { ok: false, message: `\`claude auth status --json\` did not finish cleanly (${why}), so measure can't tell which account claude would bill` };
  }
  let s;
  try { s = JSON.parse(r.stdout); } catch { /* not JSON */ }
  if (!s || typeof s !== 'object') {
    const why = r.error ? r.error.message : `exit ${r.status}: ${(r.stderr ?? '').trim().split('\n')[0] || 'no message'}`;
    return { ok: false, message: `\`claude auth status --json\` gave no JSON (${why}), so measure can't tell which account claude would bill` };
  }
  const login = `loggedIn ${s.loggedIn}, authMethod ${s.authMethod}, apiProvider ${s.apiProvider}`;
  if (s.loggedIn !== true || s.authMethod !== 'claude.ai' || s.apiProvider !== 'firstParty') {
    return { ok: false, message: `claude auth status says ${login}; measure runs only on a claude.ai subscription login (authMethod claude.ai, apiProvider firstParty)` };
  }
  return { ok: true, login: 'the claude.ai subscription login (firstParty)' };
}

// Runs before any item is processed; { ok: false } exits 3 with the message.
function checkEnvironment() {
  const name = authEnvSet();
  if (name) {
    return { ok: false, message: `${name} is set, so claude would bill an API account instead of your subscription; unset it and run again (measure never unsets it for you)` };
  }
  const claude = findClaude();
  if (!claude) return { ok: false, message: '`claude` is not on PATH; measure runs claude -p on your subscription login' };
  const auth = checkLogin(claude);
  if (!auth.ok) return auth;
  return { ok: true, claude, login: auth.login };
}

// ---- the runs -------------------------------------------------------------------

const children = new Set();
let interrupted = false;

// Ends every claude run still going, each with its helpers (they share a group).
function killChildren() {
  for (const pid of children) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// One claude -p run with `file` appended to the system prompt. Resolves to
// { tokens } (prompt tokens: input + cache creation + cache read) or { error }.
function runClaude(claude, file, cwd) {
  return new Promise((done) => {
    const args = ['-p', PROMPT, '--model', MODEL, '--output-format', 'json', '--no-session-persistence', '--append-system-prompt-file', file];
    const child = spawn(claude, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child.pid);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const finish = (result) => { clearTimeout(timer); children.delete(child.pid); done(result); };
    child.on('error', (e) => finish({ error: `could not start claude: ${e.message}` }));
    child.on('close', (code) => {
      if (timedOut) return finish({ error: `no answer within ${RUN_TIMEOUT_MS / 1000} s` });
      if (code !== 0) return finish({ error: `claude exited ${code}: ${stderr.trim().split('\n')[0] || stdout.trim().slice(0, 120) || 'no message'}` });
      let out;
      try { out = JSON.parse(stdout); } catch { return finish({ error: 'claude printed something that is not JSON' }); }
      if (out?.is_error) return finish({ error: `claude reported an error: ${String(out.result ?? 'no message').slice(0, 120)}` });
      const usage = out?.usage;
      for (const field of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
        if (!Number.isInteger(usage?.[field]) || usage[field] < 0) return finish({ error: `claude's usage has no usable ${field}` });
      }
      finish({ tokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens });
    });
  });
}

// ---- the work -----------------------------------------------------------------

const tokens = (n) => `${n} token${Math.abs(n) === 1 ? '' : 's'}`;
const isHeading = (file) => file.endsWith('--heading.txt') || file === 'title.txt';

function stopped(path, summary, reason) {
  const item = { command: 'measure', path, name: basename(path) || path, reason, summary, changed: false, data: null, refused: true };
  item.verdict = verdict(item);
  return item;
}

async function measureDir(dir, { go, workers, claude, login }) {
  if (!existsSync(dir)) return [stopped(dir, 'no such folder', 'the chunk folder does not exist; cut one with split.mjs --go')];
  if (!statSync(dir).isDirectory()) return [stopped(dir, 'not a folder', 'measure reads a folder of chunk files')];
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  if (!files.length) return [stopped(dir, 'no chunk files', 'the folder holds no .txt files; cut a CLAUDE.md with split.mjs --go')];

  const priced = files.filter((f) => !isHeading(f));
  const items = files.map((f) => {
    const path = join(dir, f);
    const bytes = statSync(path).size;
    const item = { command: 'measure', path, name: f.replace(/\.txt$/, ''), reason: '', changed: false, data: { file: path, bytes } };
    if (isHeading(f)) {
      item.skipped = true;
      item.summary = 'heading, not priced';
    } else if (!go) {
      item.summary = `would price (${bytes} B)`;
    }
    return item;
  });
  const baseline = { command: 'measure', path: dir, name: 'baseline', reason: '', changed: false, data: null };
  if (!go) {
    baseline.summary = `would run once with a one-line file, then ${priced.length} time${priced.length === 1 ? '' : 's'} with a chunk, on ${login}`;
    for (const item of [baseline, ...items]) item.verdict = verdict(item);
    return [baseline, ...items];
  }

  const work = mkdtempSync(join(tmpdir(), 'measure-'));
  try {
    const baseFile = join(work, 'baseline.txt');
    writeFileSync(baseFile, BASELINE_TEXT);
    const base = await runClaude(claude, baseFile, work);
    if (base.error) {
      baseline.error = base.error;
      baseline.summary = 'baseline run failed';
      baseline.reason = `${base.error}; no chunk was priced`;
      baseline.verdict = verdict(baseline);
      return [baseline];
    }
    baseline.summary = tokens(base.tokens);
    baseline.data = { tokens: base.tokens };
    baseline.verdict = verdict(baseline);

    let next = 0;
    const worker = async () => {
      while (!interrupted && next < priced.length) {
        const f = priced[next];
        next += 1;
        const item = items[files.indexOf(f)];
        const r = await runClaude(claude, join(dir, f), work);
        if (r.error) {
          item.error = r.error;
          item.summary = 'run failed';
          item.reason = r.error;
        } else {
          item.tokens = r.tokens - base.tokens;
          item.data.tokens = item.tokens;
          item.summary = tokens(item.tokens);
          if (item.tokens < 0) item.reason = `the run came in ${tokens(-item.tokens)} under the baseline, so the cost is noise; run it again`;
        }
        item.verdict = verdict(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, priced.length) }, worker));
    for (const item of items) item.verdict ??= verdict(item);

    const sum = items.reduce((s, it) => s + (it.tokens ?? 0), 0);
    const total = { command: 'measure', path: dir, name: 'total', reason: '', changed: false, summary: `${tokens(sum)} across ${priced.length} chunk${priced.length === 1 ? '' : 's'}`, data: { tokens: sum, chunks: priced.length, baseline: base.tokens } };
    total.verdict = verdict(total);
    return [baseline, ...items, total];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- contract hooks (the fenced runtime below relies on these) --------------

// measure spends subscription usage, so it sits behind --go like a write.
const MUTATING_COMMANDS = new Set(['measure']);
const AUTO_RUN_COMMANDS = new Set();
const EXTRA_OVERRIDE_FLAGS = [];
const GO_ALIASES = [];

// The generic policy is all this tool needs: a clean dry run is a person's call.
function nextAction(run) {
  return defaultNextAction(run);
}

// ---- argument values --------------------------------------------------------

// Fail fast on a flag's value: missing, blank after trim, or holding a line
// break is a usage error (exit 2) naming the flag, before any work.
function requireValue(flag, value) {
  if (typeof value !== 'string') usageError(`${flag} needs a value`);
  if (!value.trim()) usageError(`${flag} must not be blank`);
  if (/[\r\n\p{Zl}\p{Zp}\x85]/u.test(value)) usageError(`${flag} must be one line, with no line break`);
  return value.trim();
}

// ---- CLI --------------------------------------------------------------------

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
        cheat: { type: 'boolean' },
        brief: { type: 'boolean' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean' },
        go: { type: 'boolean' },
        workers: { type: 'string' },
      },
    });
  } catch (e) {
    usageError(e.message);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    console.log(helpText());
    return;
  }
  if (values.version) {
    console.log(`${TOOL_NAME} ${readVersion()}`);
    return;
  }
  if (values.cheat) {
    for (const mode of ['brief', 'json', 'quiet']) {
      if (values[mode]) usageError(`--cheat and --${mode} cannot be combined`);
    }
    console.log(CHEAT);
    return;
  }

  const mode = outputMode(values);
  if (positionals.length !== 1) usageError('measure needs exactly one <chunk-dir>, the folder split.mjs wrote');
  let workers = 4;
  if (values.workers !== undefined) {
    const text = requireValue('--workers', values.workers);
    if (!/^\d{1,2}$/.test(text) || Number(text) < 1 || Number(text) > 16) usageError('--workers must be a whole number from 1 to 16');
    workers = Number(text);
  }

  const env = checkEnvironment();
  if (!env.ok) environmentError(env.message);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      interrupted = true;
      killChildren();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }

  const items = await measureDir(resolve(positionals[0]), { go: !!values.go, workers, claude: env.claude, login: env.login });
  const command = 'measure';
  const effect = effectFor(command, !!values.go);
  const argv = process.argv.slice(2);
  const next = nextAction({ command, items, effect, state: null, argv });
  report({ command, effect, items, next, mode, argv });
}

// ---- mjs-tool runtime v3 (do not edit; replace wholesale) ----
// The shared machinery of contract mjs-tool/3, byte-identical in every tool
// built from mjs-tool-skeleton. It carries its own imports (namespaced, so they
// never collide with the tool's); its other top-level names are unprefixed, so
// a tool keeps no copies of them, except the human layout's, which carry a
// runtime prefix for the same reason. The tool supplies, outside this block:
// MUTATING_COMMANDS, AUTO_RUN_COMMANDS, EXTRA_OVERRIDE_FLAGS, GO_ALIASES,
// main(), and a nextAction() policy whose result it hands to report(); the
// block checks their shapes as it loads. To move a tool to a later contract,
// swap this whole block.

import * as runtimeFs from 'node:fs';
import * as runtimePath from 'node:path';
import * as runtimeUrl from 'node:url';

const CONTRACT = 'mjs-tool/3';

// The realpath of this script, so a symlinked (npm-linked) invocation still
// reports the right name/version and finds its own header for --help.
const SCRIPT_PATH = (() => {
  const self = runtimeUrl.fileURLToPath(import.meta.url);
  try { return runtimeFs.realpathSync(self); } catch { return self; }
})();
const TOOL_NAME = runtimePath.basename(SCRIPT_PATH).replace(/\.mjs$/, '');

// The directory the run started in (next.cwd), read once as the module loads,
// so a run that removes its own working directory still reports. If it was
// gone before the start, the shell's $PWD stands in (or / without one).
const START_CWD = (() => {
  try { return process.cwd(); } catch {
    const pwd = process.env.PWD;
    return pwd && runtimePath.isAbsolute(pwd) ? pwd : '/';
  }
})();

// -- verdicts: symbols, counts, exit code

const GLYPH = { ok: '✓', warn: '⚠', skip: '•', refuse: '⊘', fail: '✗' };
function glyph(v) { return GLYPH[v] || '?'; }

function summarize(items) {
  const s = { ok: 0, warn: 0, skip: 0, refuse: 0, fail: 0 };
  for (const it of items) if (it.verdict in s) s[it.verdict] += 1;
  return s;
}

// 0 all ok (skips are not failures), 1 partial. The other two codes exit
// through usageError() (2), environmentError() and the entry guard (3).
function exitCodeFor(items) {
  const s = summarize(items);
  return s.warn || s.refuse || s.fail ? 1 : 0;
}

// -- effect: what this run was allowed to do to the world. An applied run may
// still change nothing (every item refused); the items' `changed` says what did.

function effectFor(command, go) {
  if (!MUTATING_COMMANDS.has(command)) return 'read-only';
  return go ? 'applied' : 'dry-run';
}

// -- next: the advice on the next step

// Who takes each action, derived and never chosen: run, wait and done are the
// agent's; ask and stop hand the run to a person.
const NEXT_WHO = { done: 'agent', run: 'agent', wait: 'agent', ask: 'human', stop: 'human' };
const NEXT_ACTIONS = Object.keys(NEXT_WHO);
const NEXT_KEYS = ['action', 'who', 'argv', 'afterSeconds', 'why', 'cwd'];
// Rule 4: the advice never contradicts the exit code, which stays authoritative.
// Exit 0 allows ask: a clean run can still end at a person's decision.
const ACTIONS_FOR_EXIT = { 0: ['done', 'run', 'wait', 'ask'], 1: NEXT_ACTIONS, 2: ['stop'], 3: ['stop'] };
// Rule 2: a flag that confirms or overrides a gate never appears in next.argv.
// Long flags match case-insensitively: the built-in classes by prefix (so
// --yes-really and --forced), --allow and the tool's EXTRA_OVERRIDE_FLAGS
// exactly, with or without =value. An EXTRA_OVERRIDE_FLAGS entry may also be a
// bare word, which blocks that verb. --no-yes and --iamdan are not listed:
// parseArgs rejects them as unknown options, so no run could carry them.
const OVERRIDE_FLAGS = ['--allow'];
const OVERRIDE_PREFIXES = ['--yes', '--force', '--assume-yes', '--allow-', '--i-am-'];

function isOverrideFlag(token) {
  const t = String(token);
  const lower = t.toLowerCase();
  const isFlag = (f) => lower === f || lower.startsWith(`${f}=`);
  if (OVERRIDE_FLAGS.some(isFlag) || OVERRIDE_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (/^-[A-Za-z]*[yY][A-Za-z]*$/.test(t)) return true; // -y or -Y (the short --yes), alone or grouped
  return EXTRA_OVERRIDE_FLAGS.some((f) => (/^-[A-Za-z]$/.test(f)
    ? new RegExp(`^-[A-Za-z]*${f[1]}[A-Za-z]*$`).test(t) // a declared short flag, alone or grouped
    : isFlag(String(f).toLowerCase())));
}

// A --go alias the tool declares in GO_ALIASES, matched as a declared override
// flag is: a long one in any case, with or without =value; a short one alone or
// grouped. Aliases are input only: advice spells --go, which the checks read.
function isGoAlias(token) {
  const t = String(token);
  const low = t.toLowerCase();
  return GO_ALIASES.some((f) => (/^-[A-Za-z]$/.test(f)
    ? new RegExp(`^-[A-Za-z]*${f[1]}[A-Za-z]*$`).test(t)
    : low === f.toLowerCase() || low.startsWith(`${f.toLowerCase()}=`)));
}

// A next object with the fixed field set. `who` follows from the action and
// `cwd` is START_CWD, so neither is an option. `why` is escaped (a filename in
// it cannot break the line) and clipped, here rather than refused by the
// guard, which runs after the work is done.
function nextStep(action, why, options = {}) {
  const { argv = null, afterSeconds = null, ...rest } = options;
  if (Object.keys(rest).length) {
    throw new Error(`nextStep() takes argv and afterSeconds only, not ${Object.keys(rest).join(', ')}: who and cwd are derived`);
  }
  const line = typeof why === 'string' ? clipText(printable(why), 200) : why;
  return { action, who: NEXT_WHO[action] ?? null, argv, afterSeconds, why: line, cwd: START_CWD };
}

// The head of every re-run argv: this node, then this script as invoked, made
// absolute but not realpath'd (an npm-linked bin stays its bin path). Running
// the script through node needs no executable bit and no PATH lookup.
function selfArgv() {
  return [process.execPath, __entry === SCRIPT_PATH ? runtimePath.resolve(process.argv[1]) : SCRIPT_PATH];
}

// This tool's own command line again, as an argv array, with flags inserted
// before any `--` (after it they would be positionals).
function rerunArgv(argv, ...extra) {
  const end = argv.indexOf('--');
  return end < 0 ? [...selfArgv(), ...argv, ...extra] : [...selfArgv(), ...argv.slice(0, end), ...extra, ...argv.slice(end)];
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// At most `max` characters of text, then … if any were cut.
function clipText(text, max) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

// Names for `why` (which nextStep() escapes): each clipped to 80 characters,
// at most `max` of them within about 120, then a count of the rest, so the
// count survives the clip on the whole.
function listNames(items, max = 3) {
  const names = [];
  let length = 0;
  for (const it of items) {
    const name = clipText(String(it.name), 80);
    if (names.length === max || (names.length && length + name.length > 120)) break;
    names.push(name);
    length += name.length + 2;
  }
  const rest = items.length - names.length;
  return rest ? `${names.join(', ')} and ${rest} more` : names.join(', ');
}

// The generic policy (rule 3). A tool's nextAction() starts here and adds what
// only it knows. Pure: reads the command, the items, the effect and the argv.
function defaultNextAction({ command, items, effect, argv }) {
  const s = summarize(items);
  const findings = s.warn + s.refuse + s.fail;
  if (s.fail) {
    return nextStep('stop', `failed: ${listNames(items.filter((it) => it.verdict === 'fail'))}`);
  }
  if (effect === 'read-only') {
    return nextStep('done', findings ? `read-only: report the ${count(findings, 'finding')}` : 'read-only: nothing to apply');
  }
  if (effect === 'dry-run') {
    if (argv.some(isOverrideFlag)) {
      return nextStep('ask', 'the command carried an override flag, which next never repeats; a person decides');
    }
    if (s.warn || s.refuse) {
      return nextStep('ask', `dry run: review the ${count(s.warn + s.refuse, 'finding')} before --go`, { argv: rerunArgv(argv, '--go') });
    }
    if (!s.ok) return nextStep('done', 'dry run: nothing would change');
    // A clean dry run goes on to --go unattended only for a command the tool
    // has pre-approved in AUTO_RUN_COMMANDS; for any other it is a person's call.
    const action = AUTO_RUN_COMMANDS.has(command) ? 'run' : 'ask';
    return nextStep(action, `dry run clean: ${count(s.ok, 'item')} would change`, { argv: rerunArgv(argv, '--go') });
  }
  const changed = items.filter((it) => it.changed).length;
  return nextStep('done', findings
    ? `applied: ${changed} changed; report the ${count(findings, 'finding')}`
    : `applied: ${changed} changed`);
}

// Rules 2 and 4 (and the fixed shape), enforced on every `next` before it is
// rendered. A violation throws, and the run exits 3: a tool cannot ship advice
// that walks an agent past a gate, and its tests meet the violation first.
// `current` is the run the advice follows: its effect, and the argv it handed
// nextAction(). report() passes it, so a run goes to --go only on what that
// run just previewed; without it, no run may carry --go.
function assertSafeNext(next, exit, current = {}) {
  const unsafe = (why) => { throw new Error(`unsafe next: ${why}`); };
  if (next === null) return;
  if (!next || typeof next !== 'object' || Array.isArray(next)) unsafe('nextAction() must return a next object or null');
  const keys = Object.keys(next);
  if (keys.length !== NEXT_KEYS.length || !NEXT_KEYS.every((k) => keys.includes(k))) {
    unsafe(`the fields are exactly ${NEXT_KEYS.join(', ')}`);
  }
  const { action, who, argv, afterSeconds, why, cwd } = next;
  if (!NEXT_ACTIONS.includes(action)) unsafe(`unknown action ${printable(JSON.stringify(action))}`);
  if (who !== NEXT_WHO[action]) unsafe(`who is ${NEXT_WHO[action]} for ${action}, never chosen`);
  if (argv !== null && !(Array.isArray(argv) && argv.length && argv.every((a) => typeof a === 'string'))) {
    unsafe('argv is a non-empty array of strings, or null');
  }
  if ((action === 'run' || action === 'wait') && argv === null) unsafe(`${action} needs an argv`);
  if ((action === 'done' || action === 'stop') && argv !== null) unsafe(`${action} carries no argv`);
  // run, wait and any ask argv re-enter this tool and its own gates; a handoff
  // to another tool is done, with the next step in the runbook.
  const head = selfArgv();
  if (argv !== null && (argv[0] !== head[0] || argv[1] !== head[1])) {
    unsafe(`${action} re-invokes this tool: argv starts with ${printable(head.join(' '))}`);
  }
  const flag = (argv || []).find(isOverrideFlag);
  if (flag !== undefined) unsafe(`argv carries the override flag ${printable(flag)}; a step that needs one is ask`);
  const alias = (argv || []).find(isGoAlias);
  if (alias !== undefined) unsafe(`argv carries ${printable(alias)}, a --go alias in GO_ALIASES; advice spells --go`);
  if (action === 'run' && argv.slice(2).some((a) => a === '--go' || a.startsWith('--go='))) {
    // Advice goes straight to --go only on what this run just previewed: the
    // dry run's own argv with --go added, as rerunArgv(argv, '--go') builds it.
    // A step into another command, or after a run that was no dry run, is a
    // read-only or dry-run step, with no --go.
    if (current.effect !== 'dry-run') {
      unsafe(`run carries --go only straight after a dry run of the same command; this run was ${printable(current.effect ?? 'not given')}`);
    }
    const expected = Array.isArray(current.argv) ? rerunArgv(current.argv, '--go') : [];
    if (argv.length !== expected.length || argv.some((a, i) => a !== expected[i])) {
      unsafe("run carries --go only on the command just previewed: that dry run's argv with --go added, as rerunArgv(argv, '--go') builds it; a step into another command carries no --go");
    }
  }
  if (action === 'wait') {
    // wait re-polls, so it never mutates: no --go, and no mutating command,
    // matched as the same words in a row (command names may be phrases).
    const rest = argv.slice(2);
    if (rest.some((a) => a === '--go' || a.startsWith('--go='))) unsafe('wait never carries --go');
    const has = (words) => rest.some((_, i) => words.every((w, j) => rest[i + j] === w));
    const mutating = [...MUTATING_COMMANDS].find((c) => has(String(c).split(' ')));
    if (mutating !== undefined) unsafe(`wait never runs the mutating command ${printable(mutating)}`);
  }
  if (action === 'wait' ? !(Number.isInteger(afterSeconds) && afterSeconds > 0) : afterSeconds !== null) {
    unsafe('afterSeconds is a positive integer for wait, and null otherwise');
  }
  if (typeof why !== 'string' || !why.trim() || CONTROL_CHARS.test(why)) {
    unsafe('why is one non-empty line, with no control characters');
  }
  if (cwd !== START_CWD) unsafe('cwd is the working directory the run started in');
  if (!(ACTIONS_FOR_EXIT[exit] || []).includes(action)) unsafe(`action ${action} contradicts exit ${exit}`);
}

// Characters that could break, rewrite, reorder or hide part of a line of text
// output: C0 controls but TAB, DEL, C1 controls, the Unicode line and paragraph
// separators, and the bidi embedding, override and isolate controls. Item text
// is data, and styling is the renderer's: a tool puts no ANSI colour in it.
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function escapeControl(c) {
  const code = c.charCodeAt(0);
  return { '\n': '\\n', '\r': '\\r' }[c]
    ?? (code < 0x80 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`);
}

// A control character inside $'...': one past ASCII as its UTF-8 bytes (\xHH
// each), not \uXXXX, which bash 3.2 (macOS's /bin/sh and /bin/bash) does not
// decode; bash 4+ and zsh read \xHH too.
function escapeShell(c) {
  return c.charCodeAt(0) < 0x80 ? escapeControl(c)
    : [...Buffer.from(c, 'utf8')].map((b) => `\\x${b.toString(16)}`).join('');
}

// Text for a text-mode line: control characters shown as escapes, so an item
// is always one line and nothing in it can pose as another line. TAB passes.
function printable(text) {
  return String(text).replace(new RegExp(CONTROL_CHARS, 'g'), escapeControl);
}

// -- bold: the default human mode and --help only

// Bold is SGR 1 on, 22 off, written only where it will be read as bold: to a
// terminal, with no NO_COLOR, so a pipe or a file never gets an escape byte.
// NO_COLOR (https://no-color.org): present and not empty, no colour.
// FORCE_COLOR (https://force-color.org): present and not empty, colour even
// when piped, and it outranks NO_COLOR, as Node reads it (nodejs.org/api/cli.html,
// "Environment variables"). Node also takes '0' as off and any value but
// 1, 2, 3, true or empty as off; this takes '0' and 'false' as off and every
// other non-empty value as on, as force-color.org does, and an empty one as unset.
// TERM=dumb (a terminal that shows an escape as text) gets no bold either,
// unless FORCE_COLOR forces it: Node's getColorDepth() and hasColors() read it
// the same way (2 colours for TERM=dumb, 16 once FORCE_COLOR=1 is set too).
function runtimeBoldEnabled(env = process.env, isTTY = process.stdout.isTTY) {
  const force = env.FORCE_COLOR;
  if (force) return force !== '0' && force !== 'false';
  return !env.NO_COLOR && env.TERM !== 'dumb' && !!isTTY;
}

function runtimeBoldWith(on) {
  return (text) => (on ? `\x1b[1m${text}\x1b[22m` : text);
}

// A label: one to three lowercase words (letters, digits after the first, dots
// and hyphens) and a colon that ends the line or is followed by a space. It
// opens the text, or follows three or more spaces (`file mode: 600   directory
// mode: 700`), so a URL (`https://`), a time (`12:30`), a Windows path (`C:\`),
// a capital, a comma or four words before the colon are never bolded; a phrase
// of one to three lowercase words is, sentence or not (`the file was: gone`).
// Run it on text already escaped by printable(): the escaped text holds no
// ESC, so nothing in an item can open or close the bold.
const RUNTIME_LABEL_WORD = '[a-z][a-z0-9.-]*';
const RUNTIME_LABEL = new RegExp(`(?:^|(?<= {3}))(${RUNTIME_LABEL_WORD}(?: ${RUNTIME_LABEL_WORD}){0,2}):(?= |$)`, 'g');

function runtimeBoldLabels(text, bold) {
  return text.replace(RUNTIME_LABEL, (_, label) => bold(`${label}:`));
}

// An item's optional `mark`: a short decoration (one emoji) the tool sets and
// only the human renderer prints, first on the summary line. Dropped whole when
// it is not a string, holds a control character (TAB included) or a bidi mark
// (U+200E, U+200F, U+061C) anywhere, ends included, or is blank once trimmed,
// so it never reaches a line; then cut to RUNTIME_MARK_MAX characters, counted
// as a reader sees them (grapheme clusters), so a joined emoji is never split.
const RUNTIME_MARK_MAX = 8;
function runtimeMarkOf(item) {
  if (typeof item.mark !== 'string' || CONTROL_CHARS.test(item.mark) || /[\t\u200e\u200f\u061c]/.test(item.mark)) return '';
  const mark = item.mark.trim();
  if (!mark) return '';
  const shown = Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(mark), (s) => s.segment);
  return printable(shown.slice(0, RUNTIME_MARK_MAX).join(''));
}

// POSIX single-quoting, only where a token needs it; a token holding a control
// character is ANSI-C quoted ($'...') instead, so the line stays one line.
function shellQuote(token) {
  if (CONTROL_CHARS.test(token)) {
    return `$'${token.replace(/[\\']/g, (c) => `\\${c}`).replace(new RegExp(CONTROL_CHARS, 'g'), escapeShell)}'`;
  }
  return /^[A-Za-z0-9_\/.,:@%+-][A-Za-z0-9_\/.,:=@%+-]*$/.test(token) ? token : `'${token.split("'").join("'\\''")}'`;
}

// The text form of `next`, the last line of every text mode, and always exactly
// one line. A command is printed only where its reader may take it: run and
// wait always, led by `cd <cwd> &&` so the line runs as pasted from any
// directory; ask only for a person, in the default human mode, which says
// "your call" (--brief and --quiet print a bare ask, so an agent is never
// handed a command at a halt); done and stop never. argv is quoted for
// reading; --json carries the exact array, with cwd beside it.
function nextLine(next, mode) {
  const command = next.argv ? ` ${next.argv.map(shellQuote).join(' ')}` : '';
  const why = `  (${printable(next.why)})`;
  const here = `cd ${shellQuote(next.cwd)} &&`;
  if (next.action === 'run') return `next: run ${here}${command}${why}`;
  if (next.action === 'wait') return `next: wait ${next.afterSeconds}s ${here}${command}${why}`;
  if (next.action === 'ask' && mode === 'human') return `next: your call${command && `:${command}`}${why}`;
  return `next: ${next.action}${why}`;
}

// -- rendering (one item shape -> every mode)

const REASON_CUT = 160; // --brief cuts a reason after this many of its own characters (before escaping)

function summaryLine(s, effect) {
  const base = `summary: ok=${s.ok} warn=${s.warn} skip=${s.skip} refuse=${s.refuse} fail=${s.fail}`;
  return effect === 'dry-run' ? `${base}  (dry run: pass --go to apply)` : base;
}

// A reason for --brief: the whole of it, or its first REASON_CUT characters
// and a count of the rest, which --json carries in full. Characters are the
// reason's own code points, counted before escaping: a surrogate pair is never
// split, the cut never falls inside an escape (a control character is cut
// whole, then shown as its escape), and N is the code points --json holds past
// the cut. The cut applies only where it shortens the reason (a reason a few
// characters over the limit is shorter whole than with the note), so --brief
// is never longer than the human output.
function briefReason(reason) {
  const shown = printable(reason);
  const chars = Array.from(String(reason));
  if (chars.length <= REASON_CUT) return shown;
  const cut = `${printable(chars.slice(0, REASON_CUT).join(''))}… (+${chars.length - REASON_CUT} chars; --json for all)`;
  return Buffer.byteLength(cut) < Buffer.byteLength(shown) ? cut : shown;
}

// One line per item: the verdict word, the summary, then the name, with no
// padding and no glyph. The parenthesised reason appears only for a non-ok
// verdict.
function briefLine(item) {
  const showReason = item.verdict !== 'ok' && item.reason;
  return `${item.verdict} ${printable(item.summary)}  ${printable(item.name)}`
    + (showReason ? `  (${briefReason(item.reason)})` : '');
}

// The stable per-item JSON shape (top-level keys fixed; tool-specific facts go
// under `data`).
function jsonItem(item) {
  return {
    path: item.path,
    name: item.name,
    verdict: item.verdict,
    summary: item.summary,
    reason: item.reason || '',
    changed: !!item.changed,
    data: item.data || null,
  };
}

// The exit code of the report once written: a late error keeps it.
let reportedExit = null;

// The only writer of stdout, and the end of the run. Renders one run in the
// chosen mode from the one item list; when the tool runs as a command, the
// process then exits with exactly the code the report carries, once stdout has
// flushed (a bare process.exit() cuts a large report off mid-pipe; a pipe
// takes 64 KiB at a time on macOS), so an open handle cannot hold the run
// open. Returns the exit code. `next` passes assertSafeNext() before a byte is
// written; `state` (a status snapshot) is optional and appears in --json only.
// `argv` is the argv the tool handed nextAction(), normalised as it normalised
// it; left out, it is this process's own.
function report({ command, effect, items, next, state = null, mode, argv = process.argv.slice(2) }) {
  const summary = summarize(items);
  const exit = exitCodeFor(items);
  assertSafeNext(next, exit, { effect, argv });

  const emit = (text) => {
    reportedExit = exit;
    process.stdout.write(text, () => { if (__isMain) process.exit(exit); });
    return exit;
  };

  if (mode === 'json') {
    const out = { tool: TOOL_NAME, version: readVersion(), contract: CONTRACT, command, effect, exit };
    if (state !== null) out.state = state;
    Object.assign(out, { items: items.map(jsonItem), summary, next });
    return emit(`${JSON.stringify(out, null, 2)}\n`);
  }

  const lines = [];
  const bold = runtimeBoldWith(mode === 'human' && runtimeBoldEnabled());
  if (mode === 'brief') {
    for (const it of items) lines.push(briefLine(it));
  } else if (mode === 'human') {
    // One blank line opens the list, so it does not hug the command that ran it.
    if (items.length) lines.push('');
    items.forEach((it, i) => {
      if (i) lines.push('');
      const mark = runtimeMarkOf(it);
      lines.push(`${glyph(it.verdict)} ${bold(printable(it.name))}`,
        `    ${mark ? `${mark} ` : ''}${runtimeBoldLabels(printable(it.summary), bold)}`);
      for (const line of it.lines || []) lines.push(`    ${runtimeBoldLabels(printable(line), bold)}`);
      if (it.reason) lines.push(`    ${runtimeBoldLabels(`${it.verdict === 'ok' ? 'note' : it.verdict}: ${printable(it.reason)}`, bold)}`);
    });
    lines.push('');
  }
  lines.push(mode === 'human' ? runtimeBoldLabels(summaryLine(summary, effect), bold) : summaryLine(summary, effect));
  // The `next:` label is bold as `summary:` is (bold() is plain outside human);
  // the command after it is never touched, so a $'...' token stays as quoted.
  if (next) lines.push(`${bold('next:')}${nextLine(next, mode).slice('next:'.length)}`);
  return emit(`${lines.join('\n')}\n`);
}

// -- modes, errors, help, version

// The output mode from the parsed flags. --json combines with neither --brief
// nor --quiet (a usage error); --brief wins over --quiet.
function outputMode(values) {
  for (const other of ['brief', 'quiet']) {
    if (values.json && values[other]) usageError(`--${other} and --json cannot be combined`);
  }
  return values.json ? 'json' : values.brief ? 'brief' : values.quiet ? 'quiet' : 'human';
}

// Diagnostics go to stderr; stdout stays empty on both. These two may exit at
// once: they run before report(), so there is no stdout left to flush.
function usageError(message) {
  console.error(`error: ${message}`);
  console.error(`run \`${TOOL_NAME} --help\` for usage`);
  process.exit(2);
}

function environmentError(message) {
  console.error(`error: ${message}`);
  process.exit(3);
}

// Read the leading comment block of THIS file as help text (contact-sheet-cli
// pattern): skip the shebang, take the contiguous `//` lines, strip the `// `.
// The text is then set out for reading. It opens with one blank line, so the
// command that asked for it and the text do not run together, and the tool's
// name where it opens the first line (`name - what it does`, or `name: ...`) is
// bold. A heading is a line at the left margin that starts with a capital and
// ends in a colon, with no other colon in it (`Usage:`, `Output modes (all
// rendered from one list):`, or a lead-in written as one: `Creating a new key
// is the person's job:`). It is bold, two blank lines come before it (when
// something comes before it) and one blank line follows it. It opens a section,
// which ends at the next heading or a line back at the left margin. An entry,
// in a section or under a line of prose, is a line of two spaces, a first
// token, two or more spaces and its text; the token is bold, the text is not.
// The token is a flag or a comma-separated list of them (`--brief`, `-y,
// --yes`), each with any `<value>` or `[value]` after it, or one word (a mode,
// an exit code, a name), and a lowercase word after it when two or more spaces
// set that word off on both sides (`(default)   human    Rich ...`: both are
// keys in the left column, so both are bold). One flag may also stand alone,
// its text on the lines below (`--note <text>`). In the `Commands:` section
// the token is a lowercase command name (up to three words). A blank line
// comes before every entry, the first one under a line of margin prose
// included, and follows each entry's block (the lines up to the next entry or
// the end of the section). A line of two spaces that is not an entry (prose
// at an entry's indent, a flag with one space after it) is a block of its own,
// with a blank line before it. In
// `Usage:` the lowercase words after the tool name (the first token of the first
// usage line) are bold, the name and the arguments are not, on each line that
// begins with that name; no blank lines come between usage lines. The blank
// lines are always added, the bold only where runtimeBoldEnabled() allows it. A
// header shaped otherwise prints as written.
const RUNTIME_HELP_TITLE = /^([^\s:]+)(?=: | [-–—] )/;
const RUNTIME_HELP_HEADING = /^[A-Z][^:]*:$/;
const RUNTIME_HELP_COMMAND = /^ {2}([a-z][a-z0-9._:-]*(?: [a-z][a-z0-9._:-]*){0,2})( {2,}\S.*)$/;
const RUNTIME_HELP_FLAG = '-[^\\s,]+(?: <[^<>]+>| \\[[^[\\]]+\\])*';
const RUNTIME_HELP_ENTRY = new RegExp(`^ {2}(${RUNTIME_HELP_FLAG}$|${RUNTIME_HELP_FLAG}(?:, ${RUNTIME_HELP_FLAG})*(?= {2,}\\S)|[^\\s-]\\S*(?: {2,}[a-z][a-z0-9-]*)?(?= {2,}\\S))(.*)$`);
const RUNTIME_HELP_USAGE = /^ {2}(\S+)((?: [a-z][a-z0-9_-]*){0,3})(?= |$)/;

function helpText() {
  const lines = runtimeFs.readFileSync(SCRIPT_PATH, 'utf8').split('\n');
  const raw = [];
  for (const l of lines.slice(1)) {
    if (!l.startsWith('//')) break;
    raw.push(l.slice(3));
  }
  const bold = runtimeBoldWith(runtimeBoldEnabled());
  const out = [''];
  let section = null; // the heading of the section this line is in, null outside one
  let block = null; // 'entry' or 'prose' once a line of two spaces has begun a block in the section
  let tool = null; // in Usage:, the first token of the first usage line
  let afterHeading = false; // the line after a heading gets a blank line before it
  const blank = (count = 1) => {
    let have = 0;
    while (out.at(-1 - have) === '') have += 1;
    for (; have < count; have += 1) out.push('');
  };
  for (const [i, l] of raw.entries()) {
    if (afterHeading && l !== '') blank();
    afterHeading = false;
    const heading = RUNTIME_HELP_HEADING.test(l);
    if (heading || (l !== '' && !l.startsWith(' '))) {
      if (block !== null) blank();
      block = null;
      tool = null;
      section = heading ? l : null;
    }
    if (heading) {
      if (out.some((o) => o !== '')) blank(2);
      out.push(bold(l));
      afterHeading = true;
      continue;
    }
    const title = i === 0 ? RUNTIME_HELP_TITLE.exec(l) : null;
    if (title) {
      out.push(`${bold(title[1])}${l.slice(title[1].length)}`);
      continue;
    }
    if (section === 'Usage:') {
      const usage = RUNTIME_HELP_USAGE.exec(l);
      if (usage && (tool === null || usage[1] === tool)) {
        tool = usage[1];
        const verbs = usage[2].slice(1);
        out.push(`  ${usage[1]}${verbs ? ` ${bold(verbs)}` : ''}${l.slice(2 + usage[1].length + usage[2].length)}`);
      } else {
        out.push(l);
      }
      continue;
    }
    const entry = (section === 'Commands:' ? RUNTIME_HELP_COMMAND : RUNTIME_HELP_ENTRY).exec(l);
    if (entry) {
      blank(); // the first entry under margin prose too, as every other entry
      out.push(`  ${bold(entry[1])}${entry[2]}`);
      block = 'entry';
    } else {
      if (/^ {2}\S/.test(l)) {
        if (block === 'entry') blank();
        block = 'prose';
      }
      out.push(l);
    }
  }
  return out.join('\n');
}

function readVersion() {
  let dir = runtimePath.dirname(SCRIPT_PATH);
  for (let i = 0; i < 20; i += 1) {
    const p = runtimePath.join(dir, 'package.json');
    if (runtimeFs.existsSync(p)) {
      try { return JSON.parse(runtimeFs.readFileSync(p, 'utf8')).version || '0.0.0'; }
      catch { return '0.0.0'; }
    }
    const parent = runtimePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

// Exit with `code` once stdout has flushed: process.exit() alone drops what a
// pipe has not yet taken, and waiting for the event loop to empty lets any
// open handle hold the run open.
function exitAfterFlush(code) {
  process.stdout.write('', () => process.exit(code));
}

// The hooks a tool declares above this block, checked as the module loads, so
// a missing or misshapen one fails by name (exit 3) instead of mid-run.
const HOOK_ERROR = (() => {
  const hooks = [
    ['MUTATING_COMMANDS', 'a Set of command names', () => MUTATING_COMMANDS instanceof Set],
    ['AUTO_RUN_COMMANDS', 'a Set of command names (empty for none)', () => AUTO_RUN_COMMANDS instanceof Set],
    ['EXTRA_OVERRIDE_FLAGS', 'an array of strings (empty for none)',
      () => Array.isArray(EXTRA_OVERRIDE_FLAGS) && EXTRA_OVERRIDE_FLAGS.every((f) => typeof f === 'string')],
    ['GO_ALIASES', 'an array of strings (empty for none)',
      () => Array.isArray(GO_ALIASES) && GO_ALIASES.every((f) => typeof f === 'string')],
    ['nextAction', 'a function', () => typeof nextAction === 'function'],
    ['main', 'a function', () => typeof main === 'function'],
  ];
  const wrong = hooks.filter(([, , ok]) => { try { return !ok(); } catch { return true; } });
  return wrong.length
    ? `contract ${CONTRACT}: declare ${wrong.map(([name, shape]) => `${name} as ${shape}`).join('; ')}, above the runtime block`
    : null;
})();

// Entry-point guard, the last statement of the file. Resolve symlinks first: an
// npm-linked bin is a symlink, so process.argv[1] is the link path while
// import.meta.url is the real path, and the naive guard silently skips main()
// (exit 0, no output). realpath both sides to compare. An exception escaping
// main(), or thrown from a timer, a floating promise or a stream with no
// 'error' handler before the report is written, exits 3: the run could not
// complete, which is not a partial result (1). One thrown after the report is
// still printed, but the run exits with the code the report gave, which nothing
// may contradict. A main() that returns without a report exits once stdout has
// flushed. An error while the module loads (a syntax error, a top-level use of
// a fence name above the fence) happens before this runs, and Node exits 1.
const __entry = process.argv[1]
  ? (() => { try { return runtimeFs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })()
  : null;
const __isMain = !!__entry && import.meta.url === runtimeUrl.pathToFileURL(__entry).href;
if (__isMain) {
  const fatal = (e) => {
    console.error(`error: ${e?.message ?? e}`);
    if (reportedExit === null) process.exit(3);
    exitAfterFlush(reportedExit);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  if (HOOK_ERROR) fatal(new Error(HOOK_ERROR));
  else Promise.resolve().then(main).then(() => { if (reportedExit === null) exitAfterFlush(process.exitCode ?? 0); }, fatal);
} else if (HOOK_ERROR) {
  throw new Error(HOOK_ERROR);
}
// ---- end mjs-tool runtime v3 ----
