// node --test suite for measure.mjs, the chunk pricer. It never runs a real claude:
// each test runs on a PATH of the stub `claude`'s folder (first, when the test has
// one), /usr/bin and /bin, checked first for any other claude (helpers.mjs), so a
// live run cannot happen from here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SUBSCRIPTION_LOGIN, installTool, lines, peakConcurrency, runTool, stubEnv, stubRuns, withTemp } from './helpers.mjs';

// A chunk folder holding these files ({ 'a--01-x.txt': 'text' }).
function chunkDir(dir, files) {
  const chunks = path.join(dir, 'chunks');
  mkdirSync(chunks);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(chunks, name), text);
  return chunks;
}

const FOUR = { 'a--heading.txt': '## A\n', 'a--01-one.txt': '- one\n', 'a--02-two.txt': '- two, a little longer\n', 'title.txt': '# T\n' };

// The baseline file holds 2 bytes: the stub counts 10 + 1 + 3 = 14 tokens for it,
// and 10 + ceil(bytes / 4) + 3 for a chunk, so a chunk's cost is ceil(bytes / 4) - 1.
test('a dry run runs nothing: it lists the baseline, each chunk it would price, and the headings it would skip', () => withTemp((dir) => {
  const chunks = chunkDir(dir, FOUR);
  const r = runTool(installTool(dir, 'measure'), [chunks, '--brief'], { env: stubEnv(dir) });
  assert.deepEqual(lines(r.stdout), [
    'ok would run once with a one-line file, then 2 times with a chunk, on the claude.ai subscription login (firstParty)  baseline',
    'ok would price (6 B)  a--01-one',
    'ok would price (23 B)  a--02-two',
    'skip heading, not priced  a--heading',
    'skip heading, not priced  title',
    'summary: ok=3 warn=0 skip=2 refuse=0 fail=0  (dry run: pass --go to apply)',
    'next: ask  (dry run clean: 3 items would change)',
  ]);
  assert.equal(r.status, 0);
  assert.deepEqual(stubRuns(dir), []);
}));

test('--go subtracts the baseline run from each chunk run, in a fresh folder, on the haiku model', () => withTemp((dir) => {
  const chunks = chunkDir(dir, FOUR);
  const r = runTool(installTool(dir, 'measure'), [chunks, '--go', '--json'], { env: stubEnv(dir) });
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.tool, 'measure');
  assert.equal(json.effect, 'applied');
  const tokens = Object.fromEntries(json.items.map((i) => [i.name, i.data?.tokens]));
  assert.equal(tokens.baseline, 14);
  assert.equal(tokens['a--01-one'], 1); // ceil(6 / 4) - 1
  assert.equal(tokens['a--02-two'], 5); // ceil(23 / 4) - 1
  assert.equal(tokens.total, 6);
  assert.equal(json.items.find((i) => i.name === 'total').data.chunks, 2);
  assert.equal(json.items.find((i) => i.name === 'a--heading').verdict, 'skip');
  const runs = stubRuns(dir);
  assert.equal(runs.length, 3); // the baseline and two chunks, no heading
  for (const { args, cwd } of runs) {
    assert.deepEqual(args.slice(0, 7), ['-p', 'Reply with OK.', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence']);
    assert.notEqual(cwd, dir);
    assert.notEqual(path.dirname(cwd), chunks);
  }
  assert.ok(runs[0].args.at(-1).endsWith('baseline.txt'));
  assert.equal(existsSync(runs[0].cwd), false, 'the scratch folder is removed afterwards');
}));

test('--workers sets how many runs go at once', async () => {
  const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`s--0${i + 1}-x.txt`, `- chunk ${i}\n`]));
  for (const workers of [1, 3]) {
    await withTemp((dir) => {
      const chunks = chunkDir(dir, files);
      const r = runTool(installTool(dir, 'measure'), [chunks, '--go', '--quiet', '--workers', String(workers)], { env: stubEnv(dir, { STUB_SLEEP: '250' }) });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(peakConcurrency(dir), workers);
    });
  }
});

test('refuses to run while an API-key variable is set: exit 3, nothing on stdout, no run made', () => withTemp((dir) => {
  const chunks = chunkDir(dir, FOUR);
  const tool = installTool(dir, 'measure');
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE'];
  for (const name of names) {
    for (const args of [[chunks], [chunks, '--go']]) {
      const r = runTool(tool, args, { env: stubEnv(dir, { [name]: 'sk-test-not-a-real-key' }) });
      assert.equal(r.status, 3, `${name} ${args.at(-1)}`);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, new RegExp(`^error: ${name} is set, so claude would bill an API account`));
    }
  }
  assert.deepEqual(stubRuns(dir), []);
  // An empty value is how a shell clears a variable; claude reads it as unset.
  assert.equal(runTool(tool, [chunks], { env: stubEnv(dir, { ANTHROPIC_API_KEY: '' }) }).status, 0);
}));

test('refuses unless claude auth status says a claude.ai login on firstParty: exit 3, one line, no run made', () => withTemp((dir) => {
  const chunks = chunkDir(dir, FOUR);
  const tool = installTool(dir, 'measure');
  const shapes = [
    [{ ...SUBSCRIPTION_LOGIN, loggedIn: false }, /loggedIn false, authMethod claude\.ai, apiProvider firstParty/],
    [{ ...SUBSCRIPTION_LOGIN, authMethod: 'api_key' }, /authMethod api_key,/],
    [{ ...SUBSCRIPTION_LOGIN, authMethod: 'api_key_helper' }, /authMethod api_key_helper,/],
    [{ ...SUBSCRIPTION_LOGIN, authMethod: 'third_party', apiProvider: 'anthropicAws' }, /authMethod third_party, apiProvider anthropicAws;/],
    [{ ...SUBSCRIPTION_LOGIN, apiProvider: 'mantle' }, /apiProvider mantle;/],
    [{ authMethod: 'claude.ai' }, /loggedIn undefined/],
  ];
  for (const [shape, said] of shapes) {
    for (const args of [[chunks], [chunks, '--go']]) {
      const r = runTool(tool, args, { env: stubEnv(dir, { STUB_AUTH: JSON.stringify(shape) }) });
      assert.equal(r.status, 3, `${JSON.stringify(shape)} ${args.at(-1)}`);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr.trimEnd().split('\n').length, 1, r.stderr);
      assert.match(r.stderr, /^error: claude auth status says /);
      assert.match(r.stderr, said);
    }
  }
  const garbled = runTool(tool, [chunks, '--go'], { env: stubEnv(dir, { STUB_AUTH: 'not json' }) });
  assert.equal(garbled.status, 3);
  assert.equal(garbled.stdout, '');
  assert.match(garbled.stderr, /^error: `claude auth status --json` gave no JSON \(exit 0: no message\)/);
  // A subscription-shaped answer from a status call that failed is not trusted.
  const failed = runTool(tool, [chunks, '--go'], { env: stubEnv(dir, { STUB_AUTH_EXIT: '1' }) });
  assert.equal(failed.status, 3);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /^error: `claude auth status --json` did not finish cleanly \(exit 1: no message\)/);
  assert.deepEqual(stubRuns(dir), []);
  // Asked in a fresh folder, as the runs are, and that folder is removed.
  const asked = readFileSync(path.join(dir, 'stub.log.auth'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(asked[0].args, ['auth', 'status', '--json']);
  assert.notEqual(asked[0].cwd, dir);
  assert.equal(existsSync(asked[0].cwd), false);
}));

test('exits 3 when claude is not on PATH', () => withTemp((dir) => {
  const chunks = chunkDir(dir, FOUR);
  const env = { PATH: `/usr/bin${path.delimiter}/bin` };
  for (const d of env.PATH.split(path.delimiter)) {
    if (existsSync(path.join(d, 'claude'))) throw new Error(`a real claude is on the test PATH: ${d}`);
  }
  const r = runTool(installTool(dir, 'measure'), [chunks, '--go'], { env });
  assert.equal(r.status, 3);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^error: `claude` is not on PATH/);
}));

test('a run that fails is a fail item and the other chunks are still priced', () => withTemp((dir) => {
  const chunks = chunkDir(dir, { 'a--01-ok.txt': '- fine\n', 'a--02-bad.txt': '- STUBFAIL\n', 'a--03-err.txt': '- STUBERR\n' });
  const r = runTool(installTool(dir, 'measure'), [chunks, '--go', '--brief'], { env: stubEnv(dir) });
  assert.equal(r.status, 1);
  assert.deepEqual(lines(r.stdout).slice(1, 4), [
    'ok 1 token  a--01-ok',
    'fail run failed  a--02-bad  (claude exited 1: stub: boom)',
    'fail run failed  a--03-err  (claude reported an error: stub says no)',
  ]);
  assert.match(r.stdout, /summary: ok=3 warn=0 skip=0 refuse=0 fail=2/);
  assert.match(r.stdout, /next: stop /);
}));

test('a failed baseline stops before any chunk is priced', () => withTemp((dir) => {
  const chunks = chunkDir(dir, FOUR);
  const r = runTool(installTool(dir, 'measure'), [chunks, '--go', '--brief'], { env: stubEnv(dir, { STUB_FAIL_BASELINE: '1' }) });
  assert.equal(r.status, 1);
  assert.match(lines(r.stdout)[0], /^fail baseline run failed {2}baseline {2}\(claude exited 1: stub: boom; no chunk was priced\)/);
  assert.equal(stubRuns(dir).length, 1);
}));

test('a chunk that comes in under the baseline is a warn, not a negative cost', () => withTemp((dir) => {
  const chunks = chunkDir(dir, { 'a--01-low.txt': '- STUBNEG\n' });
  const r = runTool(installTool(dir, 'measure'), [chunks, '--go', '--brief'], { env: stubEnv(dir) });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^ok 14 tokens {2}baseline\nwarn -13 tokens {2}a--01-low {2}\(the run came in 13 tokens under the baseline/m);
}));

test('refuses a folder that is not there or holds no chunks (exit 1), and bad usage exits 2 with stdout empty', () => withTemp((dir) => {
  const tool = installTool(dir, 'measure');
  const env = stubEnv(dir);
  const empty = path.join(dir, 'empty');
  mkdirSync(empty);
  assert.match(runTool(tool, [path.join(dir, 'nope'), '--brief'], { env }).stdout, /^refuse no such folder {2}nope/);
  const none = runTool(tool, [empty, '--brief'], { env });
  assert.equal(none.status, 1);
  assert.match(none.stdout, /^refuse no chunk files {2}empty/);
  for (const args of [[], [empty, empty], [empty, '--workers', '0'], [empty, '--workers', '17'], [empty, '--workers', 'x'], [empty, '--workers', ' '], [empty, '--json', '--quiet'], [empty, '--nope']]) {
    const r = runTool(tool, args, { env });
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.match(r.stderr, /^error: /);
  }
}));

test('--help and --cheat print and exit 0', () => withTemp((dir) => {
  const tool = installTool(dir, 'measure');
  const help = runTool(tool, ['--help']);
  assert.match(help.stdout, /measure <chunk-dir> \[--workers <n>\] \[--go\]/);
  assert.match(help.stdout, /ANTHROPIC_API_KEY/);
  const cheat = runTool(tool, ['--cheat']);
  assert.equal(cheat.status, 0);
  assert.match(cheat.stdout, /^# measure\n\n> Price each chunk/);
}));
