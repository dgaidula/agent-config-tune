// node --test suite for split.mjs, the CLAUDE.md chunker. Every test runs the tool
// as its users do (a child process) from a copy in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES, fixture, installTool, lines, runTool, withTemp } from './helpers.mjs';

// Cuts `markdown` into `<dir>/out` and returns { names, texts, json }.
async function cut(markdown, { extra = [] } = {}) {
  return withTemp((dir) => {
    const tool = installTool(dir, 'split');
    const file = path.join(dir, 'CLAUDE.md');
    writeFileSync(file, markdown);
    const r = runTool(tool, [file, '--out', path.join(dir, 'out'), '--go', '--json', ...extra]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const names = readdirSync(path.join(dir, 'out')).sort();
    const texts = Object.fromEntries(names.map((n) => [n, readFileSync(path.join(dir, 'out', n), 'utf8')]));
    return { names, texts, json: JSON.parse(r.stdout) };
  });
}

const SAMPLE = `# Title line

Intro paragraph that wraps
onto a second line.

## Tooling & Setup

- **Tabs over spaces**: in Makefiles only.
- Plain bullet with no bold lead, long enough to be cut at thirty characters.
- **Wrapped bullet**: first line
  and its continuation, then
  - a nested bullet that stays with its parent

1. First ordered item
2. Second ordered item

## Notes

\`\`\`sh
# not a heading, inside a fence
- not a bullet either

echo done
\`\`\`

## Notes

- Same heading twice.
`;

test('chunks are named section--number-label, with headings as their own files', async () => {
  const { names } = await cut(SAMPLE);
  assert.deepEqual(names, [
    'head--01-intro-paragraph-that-wraps.txt',
    'notes--07-sh.txt',
    'notes--heading.txt',
    'notes-2--08-same-heading-twice.txt',
    'notes-2--heading.txt',
    'title.txt',
    'tooling-setup--02-tabs-over-spaces.txt',
    'tooling-setup--03-plain-bullet-with-no-bold-lead.txt',
    'tooling-setup--04-wrapped-bullet.txt',
    'tooling-setup--05-first-ordered-item.txt',
    'tooling-setup--06-second-ordered-item.txt',
    'tooling-setup--heading.txt',
  ]);
});

test('a bullet takes its wrapped lines and nested bullets; the label is the bold lead or the first 30 characters', async () => {
  const { names, texts } = await cut(SAMPLE);
  const wrapped = names.find((n) => n.includes('wrapped-bullet'));
  assert.equal(wrapped, 'tooling-setup--04-wrapped-bullet.txt');
  assert.equal(texts[wrapped], '- **Wrapped bullet**: first line\n  and its continuation, then\n  - a nested bullet that stays with its parent\n');
  assert.ok(names.includes('tooling-setup--02-tabs-over-spaces.txt'));
  assert.ok(names.includes('tooling-setup--03-plain-bullet-with-no-bold-lead.txt'), names.join('\n'));
});

test('a heading line inside a fenced code block is not a heading, and the fence stays whole', async () => {
  const { names, texts } = await cut(SAMPLE);
  const code = names.find((n) => n.startsWith('notes--') && texts[n].startsWith('```sh'));
  assert.ok(code, names.join('\n'));
  assert.match(texts[code], /echo done\n```\n$/);
  assert.ok(texts[code].includes('\n\necho done'), 'the blank line inside the fence is kept');
});

test('a heading used twice gets a numbered section, so no file is overwritten', async () => {
  const { names } = await cut(SAMPLE);
  assert.ok(names.includes('notes--heading.txt'));
  assert.ok(names.includes('notes-2--heading.txt'));
  assert.ok(names.includes('notes-2--08-same-heading-twice.txt'));
});

test('a **bold** paragraph is a paragraph, not a bullet; * and + bullets each start a chunk', async () => {
  const { json } = await cut('## A\n\n**Bold lead** then plain words.\n\n* star bullet\n+ plus bullet\n');
  const body = json.items.filter((i) => i.data.kind !== 'heading');
  assert.deepEqual(body.map((i) => [i.name, i.data.kind]), [
    ['a--01-bold-lead', 'paragraph'],
    ['a--02-star-bullet', 'bullet'],
    ['a--03-plus-bullet', 'bullet'],
  ]);
});

test('HTML comment blocks are left out and counted in a skip item', async () => {
  const { names, json } = await cut('## A\n\n<!-- one line -->\n- keep\n<!--\nmulti\nline\n-->\n- keep too\n');
  assert.equal(names.filter((n) => !n.includes('heading')).length, 2);
  const comments = json.items.find((i) => i.name === 'comments');
  assert.equal(comments.verdict, 'skip');
  assert.equal(comments.data.comments, 2);
});

test('a BOM and CRLF line ends do not change the chunks', async () => {
  const lf = await cut('## A\n\n- one\n- two\n');
  const crlf = await cut(`${String.fromCharCode(0xfeff)}## A\r\n\r\n- one\r\n- two\r\n`);
  assert.deepEqual(crlf.names, lf.names);
  assert.deepEqual(Object.values(crlf.texts), Object.values(lf.texts));
});

for (const name of FIXTURES) {
  test(`round trip on a sample CLAUDE.md (${name}): every line comes back in source order, in uniquely named files`, async () => {
    const source = fixture(name);
    const { names, texts } = await cut(source);
    assert.equal(new Set(names).size, names.length);
    const body = (s) => s.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('<!--'));
    const isHeading = (l) => /^#{1,6} /.test(l);
    const chunks = names.filter((n) => /--\d+-/.test(n)).sort((a, b) => Number(/--(\d+)-/.exec(a)[1]) - Number(/--(\d+)-/.exec(b)[1]));
    assert.deepEqual(chunks.flatMap((n) => body(texts[n])), body(source).filter((l) => !isHeading(l)));
    const headings = names.filter((n) => n === 'title.txt' || n.endsWith('--heading.txt')).flatMap((n) => body(texts[n]));
    assert.deepEqual(headings.sort(), body(source).filter(isHeading).sort());
  });
}

test('a dry run writes nothing, and says what it would write', () => withTemp((dir) => {
  const tool = installTool(dir, 'split');
  const file = path.join(dir, 'CLAUDE.md');
  writeFileSync(file, '## A\n\n- one\n');
  const r = runTool(tool, [file, '--out', path.join(dir, 'out'), '--brief']);
  assert.equal(existsSync(path.join(dir, 'out')), false);
  assert.deepEqual(lines(r.stdout), [
    'ok would write 5 B  a--heading',
    'ok would write 6 B  a--01-one',
    'summary: ok=2 warn=0 skip=0 refuse=0 fail=0  (dry run: pass --go to apply)',
    'next: ask  (dry run clean: 2 items would change)',
  ]);
  assert.equal(r.status, 0);
}));

test('--go writes each chunk file; --json, --brief and --quiet render the same items', () => withTemp((dir) => {
  const tool = installTool(dir, 'split');
  const file = path.join(dir, 'CLAUDE.md');
  writeFileSync(file, '## A\n\n- one\n- two\n');
  const out = path.join(dir, 'out');
  const json = JSON.parse(runTool(tool, [file, '--out', out, '--go', '--json']).stdout);
  assert.equal(json.tool, 'split');
  assert.equal(json.contract, 'mjs-tool/3');
  assert.equal(json.effect, 'applied');
  assert.deepEqual(readdirSync(out).sort(), ['a--01-one.txt', 'a--02-two.txt', 'a--heading.txt']);
  assert.equal(readFileSync(path.join(out, 'a--02-two.txt'), 'utf8'), '- two\n');
  assert.deepEqual(json.items.map((i) => i.name), ['a--heading', 'a--01-one', 'a--02-two']);
  assert.equal(json.items[1].data.bytes, 6);
  const brief = runTool(tool, [file, '--out', path.join(dir, 'out2'), '--go', '--brief']);
  assert.equal(lines(brief.stdout).filter((l) => l.startsWith('ok wrote')).length, json.items.length);
  const quiet = runTool(tool, [file, '--out', path.join(dir, 'out3'), '--go', '--quiet']);
  assert.deepEqual(lines(quiet.stdout), ['summary: ok=3 warn=0 skip=0 refuse=0 fail=0', 'next: done  (applied: 3 changed)']);
}));

test('refuses an output folder that already holds anything, and writes nothing into it', () => withTemp((dir) => {
  const tool = installTool(dir, 'split');
  const file = path.join(dir, 'CLAUDE.md');
  writeFileSync(file, '- one\n');
  const out = path.join(dir, 'out');
  mkdirSync(out);
  writeFileSync(path.join(out, 'stale.txt'), 'old\n');
  for (const args of [[], ['--go']]) {
    const r = runTool(tool, [file, '--out', out, '--brief', ...args]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^refuse folder is not empty {2}out /);
  }
  assert.deepEqual(readdirSync(out), ['stale.txt']);
}));

test('refuses a file that is not there (exit 1) and bad usage (exit 2, stdout empty)', () => withTemp((dir) => {
  const tool = installTool(dir, 'split');
  const file = path.join(dir, 'CLAUDE.md');
  writeFileSync(file, '- one\n');
  const missing = runTool(tool, [path.join(dir, 'nope.md'), '--out', path.join(dir, 'out'), '--brief']);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /^refuse no such file {2}nope\.md/);
  for (const args of [[file], [file, '--out', ' '], [file, '--out'], ['--out', path.join(dir, 'o')], [file, file, '--out', path.join(dir, 'o')], [file, '--out', path.join(dir, 'o'), '--json', '--brief'], [file, '--out', path.join(dir, 'o'), '--nope']]) {
    const r = runTool(tool, args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.match(r.stderr, /^error: /);
  }
}));

test('--help and --cheat print and exit 0', () => withTemp((dir) => {
  const tool = installTool(dir, 'split');
  assert.match(runTool(tool, ['--help']).stdout, /split <file> --out <dir> \[--go\]/);
  const cheat = runTool(tool, ['--cheat']);
  assert.equal(cheat.status, 0);
  assert.match(cheat.stdout, /^# split\n\n> Cut a CLAUDE\.md/);
}));
