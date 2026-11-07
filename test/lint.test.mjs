// node --test suite for skills/claude-config-tune/lint.mjs. Every test runs the
// linter as its users do (a child process) inside a temp HOME, so names read
// ~/<project> and nothing depends on the real home directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.FORCE_COLOR; delete process.env.NO_COLOR;

const LINT = fileURLToPath(new URL('../skills/claude-config-tune/lint.mjs', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// A fresh temp HOME, removed when `fn` finishes.
function withHome(fn) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'cct-test-')));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// A project directory holding .claude/settings.local.json with these permissions.
function project(home, name, permissions) {
  mkdirSync(path.join(home, name, '.claude'), { recursive: true });
  writeFileSync(path.join(home, name, '.claude', 'settings.local.json'), JSON.stringify({ permissions }));
}

// Run the linter (or a copy of it) from `home`, with HOME pointing there.
function run(home, args, { script = LINT } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 15000,
  });
}

const lines = (stdout) => stdout.replace(/\n$/, '').split('\n');

// One project that trips every per-file check.
const EVERY = {
  allow: [
    'Bash(git *)', 'Bash(git status)',
    'mcp__github__*', 'mcp__github__get_issue',
    'mcp__linear__list_issues', 'mcp__linear__get_issue',
    'mcp__slack__*',
    'mcp__gmail__search', 'mcp__gmail__get_message',
    'Bash(sed -n 1,20p /tmp/x.txt)',
  ],
  deny: [],
};
const CLEAN = { allow: ['Bash(ls *)'], deny: ['Bash(git push *)'] };

test('--brief snapshot: one line per finding, then the summary and next lines', () => withHome((home) => {
  project(home, 'every', EVERY);
  const r = run(home, ['--brief', 'every']);
  assert.deepEqual(lines(r.stdout), [
    'fail superseded Bash(git status)  ~/every  (covered by Bash(git *))',
    'fail redundant mcp__github__get_issue  ~/every  (covered by mcp__github__*)',
    'warn consolidate 2 linear tools into mcp__linear__*  ~/every  (2 enumerated tools and no wildcard; linear is not a sensitive server)',
    'warn sensitive-* mcp__slack__*  ~/every  (the wildcard auto-approves send/delete-class tools and any the server adds later; consider enumerating instead)',
    'skip enumerated 2 gmail tools  ~/every  (a sensitive server, so kept as is; consolidation is deliberately not suggested)',
    'warn one-off? Bash(sed -n 1,20p /tmp/x.txt)  ~/every  (looks single-use)',
    'warn push-guard Bash(git *)  ~/every  (no deny on git push: a broad git glob auto-approves pushes; keep pushes behind an explicit prompt)',
    'summary: ok=0 warn=4 skip=1 refuse=0 fail=2',
    'next: ask  (propose edits for the 6 settings findings to the user; change nothing until they approve)',
  ]);
  assert.equal(r.stderr, '');
  assert.equal(r.status, 1);
}));

test('--json snapshot: clean files and a drift entry, with next as the object', () => withHome((home) => {
  project(home, 'a', { allow: ['Bash(ls *)', 'Bash(npm test)'], deny: ['Bash(git push *)'] });
  project(home, 'b', CLEAN);
  const r = run(home, ['--json', 'a', 'b']);
  const settings = (name) => path.join(home, name, '.claude', 'settings.local.json');
  assert.deepEqual(JSON.parse(r.stdout), {
    tool: 'lint',
    version: VERSION,
    contract: 'mjs-tool/3',
    command: 'lint',
    effect: 'read-only',
    exit: 1,
    items: [
      { path: settings('a'), name: '~/a', verdict: 'ok', summary: 'clean (2 allow, 1 deny)', reason: '', changed: false,
        data: { check: 'clean', allow: 2, deny: 1 } },
      { path: settings('b'), name: '~/b', verdict: 'ok', summary: 'clean (1 allow, 1 deny)', reason: '', changed: false,
        data: { check: 'clean', allow: 1, deny: 1 } },
      { path: null, name: 'cross-project', verdict: 'warn', summary: 'allow drift Bash(npm test)', reason: 'missing from ~/b', changed: false,
        data: { check: 'drift', list: 'allow', entry: 'Bash(npm test)', present: [settings('a')], missing: [settings('b')] } },
    ],
    summary: { ok: 2, warn: 1, skip: 0, refuse: 0, fail: 0 },
    next: {
      action: 'ask', who: 'human', argv: null, afterSeconds: null,
      why: 'propose edits for the 1 settings finding to the user; change nothing until they approve', cwd: home,
    },
  });
  assert.equal(r.status, 1);
}));

test('--json: the summary counts the items, and exit matches the process', () => withHome((home) => {
  project(home, 'every', EVERY);
  const r = run(home, ['--json', 'every']);
  const out = JSON.parse(r.stdout);
  const counted = { ok: 0, warn: 0, skip: 0, refuse: 0, fail: 0 };
  for (const it of out.items) counted[it.verdict] += 1;
  assert.deepEqual(out.summary, counted);
  assert.equal(out.exit, r.status);
  assert.deepEqual(out.items.map((it) => it.data.check),
    ['superseded', 'redundant', 'consolidate', 'sensitive-*', 'enumerated', 'one-off?', 'push-guard']);
}));

test('human mode: a block per item, and next as the last line', () => withHome((home) => {
  project(home, 'every', EVERY);
  const r = run(home, ['every']);
  const out = lines(r.stdout);
  assert.deepEqual(out.slice(1, 4), ['✗ ~/every', '    superseded Bash(git status)', '    fail: covered by Bash(git *)']);
  assert.equal(out.at(-1), 'next: your call  (propose edits for the 6 settings findings to the user; change nothing until they approve)');
  assert.equal(r.status, 1);
}));

test('--quiet: only the summary line and the next line', () => withHome((home) => {
  project(home, 'every', EVERY);
  const r = run(home, ['--quiet', 'every']);
  assert.deepEqual(lines(r.stdout), [
    'summary: ok=0 warn=4 skip=1 refuse=0 fail=2',
    'next: ask  (propose edits for the 6 settings findings to the user; change nothing until they approve)',
  ]);
  assert.equal(r.status, 1);
}));

test('a clean project: one ok item, exit 0, next done', () => withHome((home) => {
  project(home, 'tidy', CLEAN);
  const r = run(home, ['--brief', 'tidy']);
  assert.deepEqual(lines(r.stdout), [
    'ok clean (1 allow, 1 deny)  ~/tidy',
    'summary: ok=1 warn=0 skip=0 refuse=0 fail=0',
    'next: done  (clean: no edits to propose)',
  ]);
  assert.equal(r.status, 0);
}));

test('path rules: a `dir/**` or bare tool supersedes the same tool’s narrower rules; `~/` matches `//$HOME/`', () => withHome((home) => {
  project(home, 'paths', {
    allow: [
      `Read(/${home}/.claude/**)`, // covered by ~/** once ~ is expanded
      `Read(/${home}/.claude/projects/**)`,
      'Read(~/**)',
      'Edit(//srv/app/**)', 'Edit(//srv/app/src/x.js)', 'Edit(//srv/application/y.js)', // the last is a sibling, not under app/
      'Read(//srv/app/src/x.js)', // Edit(//srv/app/**) does not cover Read
      'Write', 'Write(//tmp/out.txt)',
      'Read(~/dup/**)', `Read(/${home}/dup/**)`, // the same place twice: only the later is flagged
    ],
    deny: [],
  });
  const r = run(home, ['--json', 'paths']);
  const found = JSON.parse(r.stdout).items.filter((i) => i.data.check === 'superseded').map((i) => [i.data.entry, i.data.by]);
  assert.deepEqual(found, [
    [`Read(/${home}/.claude/**)`, 'Read(~/**)'],
    [`Read(/${home}/.claude/projects/**)`, `Read(/${home}/.claude/**)`], // the first covering rule in list order
    ['Edit(//srv/app/src/x.js)', 'Edit(//srv/app/**)'],
    ['Write(//tmp/out.txt)', 'Write'],
    ['Read(~/dup/**)', 'Read(~/**)'],
    [`Read(/${home}/dup/**)`, 'Read(~/**)'],
  ]);
  assert.equal(r.status, 1);
}));

test('path rules: two rules for the same place flag only the later one', () => withHome((home) => {
  project(home, 'dup', { allow: ['Read(~/dup/**)', `Read(/${home}/dup/**)`], deny: [] });
  const r = run(home, ['--json', 'dup']);
  const found = JSON.parse(r.stdout).items.filter((i) => i.data.check === 'superseded').map((i) => i.data.entry);
  assert.deepEqual(found, [`Read(/${home}/dup/**)`]);
}));

test('a path with no settings file refuses; invalid JSON fails and next is stop', () => withHome((home) => {
  mkdirSync(path.join(home, 'bad', '.claude'), { recursive: true });
  writeFileSync(path.join(home, 'bad', '.claude', 'settings.local.json'), '{"permissions":');
  const missing = run(home, ['--brief', 'nowhere']);
  assert.match(missing.stdout, /^refuse no settings file found {2}~\/nowhere {2}\(nothing at ~\/nowhere\/\.claude\/settings\.local\.json\)$/m);
  assert.match(missing.stdout, /^next: ask /m);
  assert.equal(missing.status, 1);
  const invalid = run(home, ['--brief', 'bad']);
  assert.match(invalid.stdout, /^fail invalid JSON {2}~\/bad {2}\(/m);
  assert.match(invalid.stdout, /^next: stop {2}\(cannot lint ~\/bad: fix the settings file, then run again\)$/m);
  assert.equal(invalid.status, 1);
}));

test('a refuse-only run names the missing file and the remedy, not edits', () => withHome((home) => {
  const r = run(home, ['--json', 'nowhere']);
  const { next } = JSON.parse(r.stdout);
  assert.equal(next.action, 'ask');
  assert.doesNotMatch(next.why, /propose edits/);
  assert.equal(next.why, 'no settings file at ~/nowhere/.claude/settings.local.json: re-run with a project dir or a settings .json file');
  project(home, 'every', EVERY);
  const mixed = run(home, ['--brief', 'every', 'nowhere']);
  assert.match(mixed.stdout, /^next: ask {2}\(propose edits for the 6 settings findings; no settings file at ~\/nowhere\/\.claude\/settings\.local\.json: re-run with/m);
}));

test('valid JSON of the wrong shape fails, naming the key, and next is stop', () => withHome((home) => {
  for (const [name, permissions, reason] of [
    ['str', { allow: 'Bash(ls *)' }, 'permissions.allow is not an array'],
    ['num', { allow: ['Bash(ls *)'], deny: [42] }, 'permissions.deny[0] is not a string'],
  ]) {
    project(home, name, permissions);
    const r = run(home, ['--json', name]);
    const out = JSON.parse(r.stdout);
    assert.equal(r.status, 1, name);
    assert.deepEqual(out.items.map((it) => [it.verdict, it.data.check, it.reason]), [['fail', 'invalid', reason]]);
    assert.equal(out.next.action, 'stop');
  }
}));

test('the global local settings file is shown whole, never as a bare ~', () => withHome((home) => {
  mkdirSync(path.join(home, '.claude'));
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls *)', 'Bash(npm test)'], deny: [] } }));
  writeFileSync(path.join(home, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls *)'], deny: [] } }));
  project(home, 'other', { allow: ['Bash(ls *)', 'Bash(npm test)'], deny: [] });
  const r = run(home, ['--brief', '.claude/settings.json', '.claude/settings.local.json']);
  assert.match(r.stdout, /^ok clean \(1 allow, 0 deny\) {2}~\/\.claude\/settings\.local\.json$/m);
  const alone = run(home, ['--brief', '.claude/settings.local.json', 'other']);
  assert.match(alone.stdout, /\(missing from ~\/\.claude\/settings\.local\.json\)$/m);
}));

test('--ci is still accepted, and changes nothing', () => withHome((home) => {
  project(home, 'every', EVERY);
  const plain = run(home, ['--brief', 'every']);
  const ci = run(home, ['--ci', '--brief', 'every']);
  assert.equal(ci.stdout, plain.stdout);
  assert.equal(ci.status, plain.status);
}));

test('usage errors exit 2 with nothing on stdout', () => withHome((home) => {
  project(home, 'tidy', CLEAN);
  for (const args of [[], ['--brief', '--json', 'tidy'], ['--quiet', '--json', 'tidy'], ['--go', 'tidy'], ['--config']]) {
    const r = run(home, args);
    assert.equal(r.status, 2, `args: ${args.join(' ')}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^error: /);
  }
}));

test('a --config that cannot be read exits 3 with nothing on stdout', () => withHome((home) => {
  project(home, 'tidy', CLEAN);
  const r = run(home, ['--config', 'no-such-tune.json', 'tidy']);
  assert.equal(r.status, 3);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^error: --config no-such-tune\.json: /);
}));

// A copy of the linter with a tune.json beside it, as the fleet deploys it.
function deployWithTune(home, tune) {
  mkdirSync(path.join(home, 'skill'));
  const script = path.join(home, 'skill', 'lint.mjs');
  copyFileSync(LINT, script);
  writeFileSync(path.join(home, 'skill', 'tune.json'), JSON.stringify(tune));
  return script;
}

test('a tune.json beside the script is auto-loaded with no --config', () => withHome((home) => {
  project(home, 'site-a', { allow: ['Bash(ls *)', 'Bash(deploy-a *)'], deny: [] });
  project(home, 'site-b', { allow: ['Bash(ls *)', 'Bash(deploy-b *)'], deny: [] });
  project(home, 'tools', { allow: ['mcp__linear__list_issues', 'mcp__linear__get_issue'], deny: [] });
  const bare = run(home, ['--brief', 'site-a', 'site-b']);
  assert.match(bare.stdout, /allow drift Bash\(deploy-a \*\)/);
  assert.equal(bare.status, 1);
  const bareTools = run(home, ['--brief', 'tools']);
  assert.match(bareTools.stdout, /^warn consolidate 2 linear tools/m);

  const script = deployWithTune(home, { siteSpecific: ['^Bash\\(deploy-'], sensitiveServers: ['^linear$'] });
  const tuned = run(home, ['--brief', 'site-a', 'site-b'], { script });
  assert.doesNotMatch(tuned.stdout, /drift/);
  assert.match(tuned.stdout, /^ok allow\/deny lists match {2}cross-project$/m);
  assert.equal(tuned.status, 0);
  const tunedTools = run(home, ['--brief', 'tools'], { script });
  assert.match(tunedTools.stdout, /^skip enumerated 2 linear tools/m);
  assert.equal(tunedTools.status, 0);
}));

test('sensitive servers match case-insensitively, defaults and tune.json alike', () => withHome((home) => {
  project(home, 'hosted', { allow: ['mcp__claude_ai_Composio__COMPOSIO_SEARCH_TOOLS', 'mcp__claude_ai_Composio__COMPOSIO_GET_TOOL_SCHEMAS'], deny: [] });
  const r = run(home, ['--brief', 'hosted']);
  assert.match(r.stdout, /^skip enumerated 2 claude_ai_Composio tools/m);
  assert.doesNotMatch(r.stdout, /consolidate/);
  assert.equal(r.status, 0);

  project(home, 'tools', { allow: ['mcp__Linear__list_issues', 'mcp__Linear__get_issue'], deny: [] });
  const script = deployWithTune(home, { sensitiveServers: ['^linear$'] });
  assert.match(run(home, ['--brief', 'tools'], { script }).stdout, /^skip enumerated 2 Linear tools/m);
}));

test('drift: settings.json and settings.local.json in one dir are one layered scope, compared as their union', () => withHome((home) => {
  // Global pair: each layer lacks what the other holds, which is how layering is meant to work.
  mkdirSync(path.join(home, '.claude'));
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls *)'], deny: ['Bash(git push *)'] } }));
  writeFileSync(path.join(home, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ddev *)'] } }));
  const pair = run(home, ['--brief', '.claude/settings.json', '.claude/settings.local.json']);
  assert.doesNotMatch(pair.stdout, /drift|cross-project/);
  assert.equal(pair.status, 0);

  // The merged scope against a real second project: only the union's differences drift.
  project(home, 'other', { allow: ['Bash(ls *)', 'Bash(ddev *)'], deny: [] });
  const r = run(home, ['--json', '.claude/settings.json', '.claude/settings.local.json', 'other']);
  const drift = JSON.parse(r.stdout).items.filter((i) => i.data.check === 'drift');
  assert.deepEqual(drift.map((i) => [i.summary, i.reason]), [
    ['deny drift Bash(git push *)', 'missing from ~/other'],
  ]);
  assert.match(run(home, ['.claude/settings.json', '.claude/settings.local.json', 'other']).stdout, /present in ~\/\.claude\/\{settings\.json,settings\.local\.json\}/);
  assert.deepEqual(drift[0].data.present, [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.local.json')]);
}));

test('an explicit --config wins over the tune.json beside the script',() => withHome((home) => {
  project(home, 'site-a', { allow: ['Bash(deploy-a *)'], deny: [] });
  project(home, 'site-b', { allow: ['Bash(deploy-b *)'], deny: [] });
  const script = deployWithTune(home, { siteSpecific: ['^Bash\\(deploy-'] });
  writeFileSync(path.join(home, 'other.json'), '{}');
  const r = run(home, ['--brief', '--config', 'other.json', 'site-a', 'site-b'], { script });
  assert.match(r.stdout, /allow drift Bash\(deploy-a \*\)/);
  assert.equal(r.status, 1);
}));

// A directory of dated review reports; `newest` gets the later mtime.
function reviews(home, { older, newest }) {
  const dir = path.join(home, 'reviews');
  mkdirSync(dir);
  writeFileSync(path.join(dir, '2026-09-01.md'), `# Review\n\nVerdict: ${older}\n`);
  writeFileSync(path.join(dir, '2026-09-29.md'), `# Review\n\nVerdict: ${newest}\n`);
  utimesSync(path.join(dir, '2026-09-01.md'), new Date('2026-09-01'), new Date('2026-09-01'));
  utimesSync(path.join(dir, '2026-09-29.md'), new Date('2026-09-29'), new Date('2026-09-29'));
  writeFileSync(path.join(home, 'tune.json'), JSON.stringify({ reviewReport: '~/reviews' }));
}

test('reviewReport: the newest report’s verdict is the first item, a skip unless CLEAN; clean settings stay exit 0, done', () => withHome((home) => {
  project(home, 'tidy', CLEAN);
  reviews(home, { older: 'CLEAN', newest: 'CHANGES RECOMMENDED' });
  const r = run(home, ['--brief', '--config', 'tune.json', 'tidy']);
  assert.deepEqual(lines(r.stdout), [
    'skip latest review: CHANGES RECOMMENDED  ~/reviews/2026-09-29.md  (address its recommendations alongside this tune)',
    'ok clean (1 allow, 1 deny)  ~/tidy',
    'summary: ok=1 warn=0 skip=1 refuse=0 fail=0',
    'next: done  (settings clean; latest harness review is CHANGES RECOMMENDED: surface its recommendations to the user)',
  ]);
  assert.equal(r.status, 0);
}));

test('reviewReport: a CLEAN latest review is ok and leaves a clean run at exit 0', () => withHome((home) => {
  project(home, 'tidy', CLEAN);
  reviews(home, { older: 'BLOCKING', newest: 'CLEAN' });
  const r = run(home, ['--brief', '--config', 'tune.json', 'tidy']);
  assert.equal(lines(r.stdout)[0], 'ok latest review: CLEAN  ~/reviews/2026-09-29.md');
  assert.equal(lines(r.stdout).at(-1), 'next: done  (clean: no edits to propose)');
  assert.equal(r.status, 0);
}));

test('reviewReport: settings findings with a non-CLEAN review exit 1, ask about the settings findings', () => withHome((home) => {
  project(home, 'every', EVERY);
  reviews(home, { older: 'CLEAN', newest: 'BLOCKING' });
  const r = run(home, ['--brief', '--config', 'tune.json', 'every']);
  assert.match(lines(r.stdout)[0], /^skip latest review: BLOCKING /);
  assert.equal(lines(r.stdout).at(-1), 'next: ask  (propose edits for the 6 settings findings to the user; change nothing until they approve)');
  assert.equal(r.status, 1);
}));

test('an unknown check label is an internal error, never reported clean', () => withHome((home) => {
  project(home, 'tidy', CLEAN);
  // A copy of the linter whose clean item carries a label verdict() does not know.
  const source = readFileSync(LINT, 'utf8');
  const bogus = source.replace("items.push(makeItem({ ...at, check: 'clean',", "items.push(makeItem({ ...at, check: 'bogus',");
  assert.notEqual(bogus, source);
  const script = path.join(home, 'lint.mjs');
  writeFileSync(script, bogus);
  const r = run(home, ['--brief', 'tidy'], { script });
  assert.equal(r.status, 3);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /unknown check label "bogus"/);
}));

test('reviewReport: nothing readable there is one skip item naming the path and why; exit unchanged', () => withHome((home) => {
  project(home, 'tidy', CLEAN);
  writeFileSync(path.join(home, 'tune.json'), JSON.stringify({ reviewReport: '~/no-reviews-here' }));
  const r = run(home, ['--brief', '--config', 'tune.json', 'tidy']);
  assert.deepEqual(lines(r.stdout).slice(0, 3), [
    'skip review report missing  ~/no-reviews-here  (nothing at ~/no-reviews-here)',
    'ok clean (1 allow, 1 deny)  ~/tidy',
    'summary: ok=1 warn=0 skip=1 refuse=0 fail=0',
  ]);
  assert.equal(r.status, 0);
  // A report that exists but cannot be read says so instead.
  writeFileSync(path.join(home, 'locked.md'), 'Verdict: CLEAN\n');
  chmodSync(path.join(home, 'locked.md'), 0o000);
  writeFileSync(path.join(home, 'tune.json'), JSON.stringify({ reviewReport: '~/locked.md' }));
  const u = run(home, ['--brief', '--config', 'tune.json', 'tidy']);
  assert.match(lines(u.stdout)[0], /^skip review report unreadable {2}~\/locked\.md {2}\(cannot read ~\/locked\.md: EACCES\)$/);
  assert.equal(u.status, 0);
}));

test('--help prints the header, not code; --version prints the package version', () => withHome((home) => {
  const help = run(home, ['--help']);
  assert.match(help.stdout, /^\nclaude-config-tune lint — /);
  assert.match(help.stdout, /^Exit codes:$/m);
  assert.doesNotMatch(help.stdout, /^import /m);
  assert.equal(help.status, 0);
  const version = run(home, ['--version']);
  assert.equal(version.stdout, `lint ${VERSION}\n`);
}));

test('one-off?: a trailing glob with a `/` in it is a glob, not a one-off', () => withHome((home) => {
  project(home, 'globs', { allow: ['Bash(./scripts/build.sh *)'], deny: [] });
  const r = run(home, ['--brief', 'globs']);
  assert.deepEqual(lines(r.stdout).filter((l) => l.includes('one-off?')), []);
  assert.equal(r.status, 0);
}));

test('one-off?: rm/cp/mv with a flag are flagged like the plain forms', () => withHome((home) => {
  project(home, 'flags', { allow: ['Bash(rm -rf build)', 'Bash(cp -r a b)', 'Bash(mv -f a b)', 'Bash(rm foo)'], deny: [] });
  const r = run(home, ['--brief', 'flags']);
  assert.deepEqual(lines(r.stdout).filter((l) => l.includes('one-off?')).map((l) => l.match(/one-off\? (\S+\([^)]*\))/)[1]),
    ['Bash(rm -rf build)', 'Bash(cp -r a b)', 'Bash(mv -f a b)', 'Bash(rm foo)']);
}));

test('a project dir reads both layers: settings.json alone is linted, and a pair is two files', () => withHome((home) => {
  mkdirSync(path.join(home, 'shared', '.claude'), { recursive: true });
  writeFileSync(path.join(home, 'shared', '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git *)', 'Bash(git status)'], deny: [] } }));
  const alone = run(home, ['--brief', 'shared']);
  assert.match(alone.stdout, /^fail superseded Bash\(git status\) {2}~\/shared\/\.claude\/settings\.json {2}\(covered by Bash\(git \*\)\)$/m);
  assert.doesNotMatch(alone.stdout, /^refuse /m);
  writeFileSync(path.join(home, 'shared', '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls *)'] } }));
  const pair = JSON.parse(run(home, ['--json', 'shared']).stdout);
  assert.deepEqual([...new Set(pair.items.map((i) => i.path))], [
    path.join(home, 'shared', '.claude', 'settings.json'),
    path.join(home, 'shared', '.claude', 'settings.local.json'),
  ]);
  assert.equal(pair.items.filter((i) => i.data.check === 'drift').length, 0);
}));

test('in-global: a project entry the global settings already allow is a warn naming the global entry', () => withHome((home) => {
  mkdirSync(path.join(home, '.claude'));
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm view *)', 'Bash(sw_vers)', 'Read(~/docs/**)', 'mcp__github__*'] } }));
  writeFileSync(path.join(home, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Skill(claude-api)'] } }));
  project(home, 'dup', { allow: ['Bash(npm view lodash)', 'Bash(sw_vers)', 'Read(//' + home.replace(/^\//, '') + '/docs/a.md)', 'mcp__github__get_issue', 'Skill(claude-api)', 'Bash(make *)'], deny: [] });
  const r = run(home, ['--json', 'dup']);
  const found = JSON.parse(r.stdout).items.filter((i) => i.data.check === 'in-global');
  assert.deepEqual(found.map((i) => [i.verdict, i.data.entry, i.data.by]), [
    ['warn', 'Bash(npm view lodash)', 'Bash(npm view *)'],
    ['warn', 'Bash(sw_vers)', 'Bash(sw_vers)'],
    ['warn', `Read(//${home.replace(/^\//, '')}/docs/a.md)`, 'Read(~/docs/**)'],
    ['warn', 'mcp__github__get_issue', 'mcp__github__*'],
    ['warn', 'Skill(claude-api)', 'Skill(claude-api)'],
  ]);
  assert.match(found[1].reason, /^already allowed by ~\/\.claude\/settings\.json/);
  assert.equal(r.status, 1);
  // The global files themselves are the baseline, never checked against it.
  const self = run(home, ['--json', '.claude/settings.json', '.claude/settings.local.json']);
  assert.equal(JSON.parse(self.stdout).items.filter((i) => i.data.check === 'in-global').length, 0);
  // A config's globalSettings replaces the default pair; [] turns the check off.
  writeFileSync(path.join(home, 'off.json'), JSON.stringify({ globalSettings: [] }));
  const off = run(home, ['--json', '--config', 'off.json', 'dup']);
  assert.equal(JSON.parse(off.stdout).items.filter((i) => i.data.check === 'in-global').length, 0);
}));

// A skills directory with these SKILL.md bodies, one folder each.
function skills(home, bodies) {
  for (const [name, body] of Object.entries(bodies)) {
    mkdirSync(path.join(home, 'skills', name), { recursive: true });
    writeFileSync(path.join(home, 'skills', name, 'SKILL.md'), body);
  }
}

test('--skills lists every SKILL.md with bytes and estimated tokens; at the 4000-token line it is ok, one byte-quad over it warns', () => withHome((home) => {
  skills(home, { small: '# small\n\nOne line.\n', edge: 'a'.repeat(16000), over: 'a'.repeat(16001) });
  const r = run(home, ['--json', '--skills', 'skills']);
  const items = JSON.parse(r.stdout).items;
  assert.deepEqual(items.map((i) => [i.data.skill, i.verdict, i.data.bytes, i.data.estimatedTokens]), [
    ['over', 'warn', 16001, 4001],
    ['edge', 'ok', 16000, 4000],
    ['small', 'ok', 19, 5],
  ]);
  assert.equal(r.status, 1);
  const over = items[0];
  assert.equal(over.data.check, 'skill-size');
  assert.equal(over.data.capTokens, 5000);
  assert.equal(over.data.source, 'code.claude.com/docs/en/context-window.md');
  assert.match(over.reason, /first 5000 .*re-injects the skill after compaction \(code\.claude\.com\/docs\/en\/context-window\.md\); tokens are bytes \/ 4, an estimate/);
  assert.equal(run(home, ['--json', '--skills', 'skills']).stderr, '');
}));

test('--skills: a last ## section that starts past the 5000-token cap is a skill-cut warn; a ## inside a code fence is not a section', () => withHome((home) => {
  const filler = 'x'.repeat(79) + '\n'; // 80 bytes a line
  skills(home, {
    // 20,400 bytes of body, then the last section: starts past 20,000 bytes
    cut: `## Steps\n${filler.repeat(255)}## Done means\nDone.\n`,
    // the same size, but its only late ## is inside a fence; the last real section is early
    fenced: `## Steps\n${filler.repeat(255)}\`\`\`md\n## Done means\n\`\`\`\n`,
    // a short skill with a late-looking heading never trips
    tiny: '## A\n## B\n',
  });
  const items = JSON.parse(run(home, ['--json', '--skills', 'skills']).stdout).items;
  const cutItems = items.filter((i) => i.data.check === 'skill-cut');
  assert.deepEqual(cutItems.map((i) => [i.data.skill, i.verdict, i.data.lastSectionEstimatedTokens]), [['cut', 'warn', 5103]]);
  assert.match(cutItems[0].reason, /^its last `##` section starts past the 5000-token re-injection cap, so after compaction it is cut/);
  assert.deepEqual(items.filter((i) => i.data.skill === 'fenced').map((i) => i.data.check), ['skill-size']);
  assert.deepEqual(items.filter((i) => i.data.skill === 'tiny').map((i) => i.verdict), ['ok']);
}));

test('--skills --brief: one line per skill, the summary, and a next line that names skill-size findings; clean skills exit 0 and are done', () => withHome((home) => {
  skills(home, { big: 'a'.repeat(17000), fine: 'ok\n' });
  const r = run(home, ['--brief', '--skills', 'skills']);
  const out = lines(r.stdout);
  assert.match(out[0], /^warn big: 17000 bytes, ~4250 tokens {2}~\/skills\/big\/SKILL\.md {2}\(over 4000 estimated tokens/);
  assert.match(out[1], /^ok fine: 3 bytes, ~1 tokens {2}~\/skills\/fine\/SKILL\.md$/);
  assert.equal(out[2], 'summary: ok=1 warn=1 skip=0 refuse=0 fail=0');
  assert.equal(out[3], 'next: ask  (propose edits for the 1 skill-size finding to the user; change nothing until they approve)');
  rmSync(path.join(home, 'skills', 'big'), { recursive: true });
  const clean = run(home, ['--quiet', '--skills', 'skills']);
  assert.equal(clean.stdout, 'summary: ok=1 warn=0 skip=0 refuse=0 fail=0\nnext: done  (clean: no edits to propose)\n');
  assert.equal(clean.status, 0);
}));

test('--skills refusal: a skills directory that is not there refuses and exit 1; no path and no --skills is still a usage error', () => withHome((home) => {
  const r = run(home, ['--brief', '--skills', 'nowhere']);
  assert.match(r.stdout, /^refuse no skills directory found {2}~\/nowhere {2}\(nothing at ~\/nowhere\)$/m);
  assert.match(r.stdout, /^next: ask {2}\(no skills directory at ~\/nowhere: re-run with the right --skills path\)$/m);
  assert.equal(r.status, 1);
  const usage = run(home, ['--brief']);
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, '');
  assert.match(usage.stderr, /--skills <dir>/);
}));

test('--skills together with a project path: settings and skills findings are both reported, the run exits 1 once', () => withHome((home) => {
  project(home, 'ok', CLEAN);
  skills(home, { big: 'a'.repeat(17000) });
  const r = run(home, ['--json', 'ok', '--skills', 'skills']);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.items.map((i) => i.data.check), ['clean', 'skill-size']);
  assert.equal(out.exit, 1);
  assert.equal(r.status, 1);
}));
