#!/usr/bin/env node
// claude-config-tune lint — a deterministic, report-only hygiene check for the
// permission lists in Claude Code settings: `permissions.allow` (what is
// auto-approved) and `permissions.deny` (what is blocked). It never edits
// anything. It reports findings so a person, or a model pass they approve, can
// prune with confidence. This is the mechanical half of a config tune-up; the
// CLAUDE.md prose review stays a judgment call (SKILL.md, mode 2).
//
// Usage:
//   node lint.mjs [--brief | --json | --quiet] <path>...
//   node lint.mjs --config tune.json <path>...
//   node lint.mjs --help | --version
//
//   Each <path> is a project directory (its .claude/settings.json and
//   .claude/settings.local.json are read, whichever exist) or a settings .json
//   file. Two or more paths add the cross-project drift check.
//
// Checks, per file, with the verdict each one gives:
//   superseded    fail   a narrow Bash entry already covered by a broader `X *` glob,
//                        or a path rule (Read/Edit/Write/NotebookEdit) covered by the
//                        same tool's `dir/**` or bare tool name (`~/` = `//$HOME/`)
//   redundant     fail   an enumerated mcp tool already covered by `mcp__server__*`
//   consolidate   warn   2+ enumerated tools on one server, and no wildcard
//   sensitive-*   warn   a wildcard on a sensitive server (send/delete/payment-shaped
//                        tools); enumerating them is the fix
//   enumerated    skip   2+ enumerated tools on a sensitive server, kept as they
//                        are: consolidation is deliberately not suggested
//   one-off?      warn   a non-glob Bash entry that looks single-use
//   push-guard    warn   a broad glob allowed with no deny on its dangerous subcommand
//   in-global     warn   an allow entry the global settings already grant (the same
//                        entry, or one a global glob, `dir/**` or `mcp__server__*`
//                        covers); a committed copy may be deliberate, for sessions
//                        that run without your global settings
//   clean         ok     a file with none of the above
// Across files (two or more paths):
//   drift         warn   an entry present in some files but not all, excluding
//                        site-specific patterns (`clean` when the lists match);
//                        settings.json and settings.local.json in one directory
//                        are layers of one scope, compared as their union
// From the config:
//   review        ok or skip   the latest prior review's verdict, first in the
//                        run: ok when it reads CLEAN, skip otherwise (shown
//                        with its reason, but never a settings finding)
//   review-missing skip  reviewReport is set but points at nothing readable:
//                        missing, or unreadable (named, never a failure)
// A path with no settings file refuses; an unreadable or invalid one fails, as
// does one whose permissions.allow or .deny is not an array of strings.
//
// Output modes (all rendered from the same item objects, so they can never
// disagree):
//   (default)   human    A block per item: the file, the finding, the reason.
//   --brief              Exactly one line per item: <glyph> <verdict> <summary>
//                        <name>, plus a parenthesised reason whenever the
//                        verdict is not ok. Ends with a summary line.
//   --json               A stable object on stdout, nothing else:
//                        { tool, version, contract, command, effect, exit,
//                          items: [...], summary: { ok, warn, skip, refuse,
//                          fail }, next }   (contract "mjs-tool/2"). Each item's
//                        data carries `check` (the label above) and the
//                        finding's specifics; a drift item's path is null.
//   --quiet              The summary line only.
//   Every text mode then ends with one `next:` line: `done` when every
//   settings item is ok (a non-CLEAN review is named there, to surface), `ask`
//   when there are settings findings (propose the edits; the user approves each
//   one) or a path has no settings file (re-run with the right path), `stop`
//   when a settings file cannot be read. --json cannot be combined with --brief
//   or --quiet.
//
// Flags:
//   --config <file>   extend the defaults with a tune.json (below). Without it,
//                     a tune.json beside this script is loaded if there is one,
//                     so a deployment ships its site patterns as data.
//   --ci              accepted so existing commands keep working; it changes
//                     nothing, because every run now exits 1 on any finding,
//                     advisory ones included. To gate on definite findings
//                     only, test `summary.fail` in --json.
//   --brief, --json, --quiet   the output mode (above).
//   --help, -h        print this header.
//   --version         print `lint <version>`.
//
// Config file (all keys optional, additive to the defaults):
//   {
//     "siteSpecific":     ["regex", ...],   // entries EXPECTED to differ across projects
//     "sensitiveServers": ["regex", ...],   // MCP servers never to wildcard-consolidate
//                                           // (matched case-insensitively)
//     "pushGuards": [{ "glob": "git", "requireDenyPrefix": "git push", "why": "..." }],
//     "reviewReport":     "path or dir"     // a prior review report (or a dir of dated
//                                           // ones); its latest verdict is the first
//                                           // item of the run, so a non-CLEAN review
//                                           // gets addressed alongside the tune
//     "globalSettings":   ["path", ...]     // the in-global baseline; REPLACES the
//                                           // default ~/.claude/settings.json and
//                                           // ~/.claude/settings.local.json ([] = off)
//   }
//
// Read-only: it reads settings files and the config, writes nothing, and never
// prompts. There is nothing to apply, so there is no --go.
//
// Exit codes:
//   0   clean: every item ok (a skip is not a finding).
//   1   findings: at least one item warned, refused, or failed.
//   2   usage error (unknown flag, no path, bad mode combo).
//   3   could not run to completion: the config is missing, unreadable or
//       invalid, or an internal error.

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// --- defaults (extend via --config) -------------------------------------------

// Patterns EXPECTED to differ between harmonized projects; drift check ignores them.
const DEFAULT_SITE_SPECIFIC = [];

// Broad Bash globs whose power warrants a matching deny on a dangerous subcommand.
const DEFAULT_PUSH_GUARDS = [
  { glob: 'git', requireDenyPrefix: 'git push', why: 'a broad git glob auto-approves pushes; keep pushes behind an explicit prompt' },
];

// MCP servers with send/delete/payment-shaped tools. Consolidating these to a
// `mcp__server__*` wildcard would silently auto-approve outward or destructive
// actions (and any tool the server adds later). Matched case-insensitively:
// hosted connectors carry capitalised names such as `claude_ai_Composio`.
const DEFAULT_SENSITIVE_SERVERS = [/gmail/i, /google-workspace/i, /composio/i, /slack/i, /stripe/i, /twilio/i, /sendgrid/i, /mail/i];

// ---- verdict semantics (the single source of truth) -------------------------
//
// Each item carries the label of the check that produced it (`check`, also its
// data.check). verdict() is the ONLY place a label maps to a verdict: definite
// findings fail, advisory ones warn, a clean check is ok.

const DEFINITE_CHECKS = new Set(['superseded', 'redundant']);
const ADVISORY_CHECKS = new Set(['consolidate', 'sensitive-*', 'one-off?', 'push-guard', 'in-global', 'drift']);

// Facts on an item -> its verdict. Pure: reads item fields, returns a string.
// An unknown label throws (exit 3) rather than passing as clean.
function verdict(item) {
  if (item.check === 'invalid-json' || item.check === 'unreadable' || item.check === 'invalid') return 'fail';
  if (item.check === 'missing') return 'refuse';
  if (DEFINITE_CHECKS.has(item.check)) return 'fail';
  if (ADVISORY_CHECKS.has(item.check)) return 'warn';
  // A non-CLEAN review is advisory context for the tune, not a settings finding.
  if (item.check === 'review') return /^CLEAN\b/.test(item.reviewVerdict) ? 'ok' : 'skip';
  if (item.check === 'enumerated' || item.check === 'review-missing') return 'skip';
  if (item.check === 'clean') return 'ok';
  throw new Error(`verdict(): unknown check label ${JSON.stringify(item.check)}`);
}

// One item: the label, where it is, what it says. `data` gets the label too,
// so a --json reader can select findings by check.
function makeItem({ check, path, name, summary, reason = '', lines = [], data = {}, ...facts }) {
  const item = { ...facts, check, path, name, summary, reason, lines, changed: false, data: { check, ...data } };
  item.verdict = verdict(item);
  return item;
}

// ---- config -----------------------------------------------------------------

// The config in force: the defaults, plus a tune.json — the one named with
// --config, else one sitting beside this script, so a deployment can ship its
// site patterns as data without changing the invocation. A config that is
// there but cannot be read or parsed stops the run (exit 3).
function loadConfig(configPath) {
  const config = {
    siteSpecific: [...DEFAULT_SITE_SPECIFIC],
    pushGuards: [...DEFAULT_PUSH_GUARDS],
    sensitiveServers: [...DEFAULT_SENSITIVE_SERVERS],
    reviewReport: null,
    globalSettings: ['~/.claude/settings.json', '~/.claude/settings.local.json'],
  };
  if (!configPath) {
    const adjacent = join(dirname(fileURLToPath(import.meta.url)), 'tune.json');
    if (existsSync(adjacent)) configPath = adjacent;
  }
  if (!configPath) return config;
  try {
    const cfg = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
    for (const s of cfg.siteSpecific ?? []) config.siteSpecific.push(new RegExp(s));
    for (const s of cfg.sensitiveServers ?? []) config.sensitiveServers.push(new RegExp(s, 'i'));
    for (const g of cfg.pushGuards ?? []) config.pushGuards.push(g);
    config.reviewReport = cfg.reviewReport ?? null;
    if (cfg.globalSettings) config.globalSettings = cfg.globalSettings;
  } catch (e) {
    environmentError(`--config ${configPath}: ${e.message}`);
  }
  return config;
}

// ---- the checks -------------------------------------------------------------

/**
 * Resolve a CLI path to the settings files it names: a .json file is itself; a
 * project dir is whichever of its two layers exist, else its settings.local.json
 * (which then refuses as missing).
 */
function resolveSettings(p) {
  const abs = resolve(p);
  if (abs.endsWith('.json')) return [abs];
  const layers = ['settings.json', 'settings.local.json'].map((f) => join(abs, '.claude', f)).filter((f) => existsSync(f));
  return layers.length ? layers : [join(abs, '.claude', 'settings.local.json')];
}

/** The global settings' allow entries, the in-global baseline: [{ entry, file }]. Unreadable files are skipped. */
function loadGlobalAllow(config) {
  const files = config.globalSettings.map((f) => resolve(expandHome(f)));
  const entries = [];
  for (const file of files) {
    try {
      const allow = JSON.parse(readFileSync(file, 'utf8'))?.permissions?.allow;
      if (Array.isArray(allow)) for (const entry of allow) if (typeof entry === 'string') entries.push({ entry, file });
    } catch {}
  }
  return { files, entries };
}

/** The global entry that grants `entry` (the same entry, or a covering glob, path rule or mcp wildcard), else undefined. */
function grantedBy(entry, globalEntries) {
  const inner = bashInner(entry);
  const path = pathRule(entry);
  const mcp = mcpParts(entry);
  return globalEntries.find(({ entry: g }) => {
    if (g === entry) return true;
    if (inner !== null && bashInner(g) !== null) {
      const prefix = globPrefix(bashInner(g));
      return prefix !== null && covers(prefix, inner);
    }
    if (path && pathRule(g)) return pathCovers(pathRule(g), path);
    if (mcp && mcp.tool !== '*') return g === `mcp__${mcp.server}__*`;
    return false;
  });
}

/** `Bash(<inner>)` -> inner, else null. */
function bashInner(entry) {
  const m = entry.match(/^Bash\((.*)\)$/s);
  return m ? m[1] : null;
}

/** If `inner` is a trailing-glob (`foo bar *`), return its literal prefix (`foo bar`), else null. */
function globPrefix(inner) {
  const m = inner.match(/^(.*?)\s*\*+$/s);
  if (!m) return null;
  return m[1].replace(/\s+$/, '');
}

/** Does glob prefix cover another command string? */
function covers(prefix, other) {
  return other === prefix || other.startsWith(prefix + ' ');
}

// Tools whose rule specifier is a gitignore-style path (`Read(//abs/**)`).
const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);

/** `Read(<path>)` -> { tool, path }; a bare `Read` -> { tool, path: null } (every path). Else null. */
function pathRule(entry) {
  if (PATH_TOOLS.has(entry)) return { tool: entry, path: null };
  const m = entry.match(/^(\w+)\((.*)\)$/s);
  if (!m || !PATH_TOOLS.has(m[1])) return null;
  // `~/x` and `//$HOME/x` name the same place; compare them in the `//` form.
  const home = (process.env.HOME ?? '').replace(/^\/+|\/+$/g, '');
  const path = home && m[2].startsWith('~/') ? `//${home}/${m[2].slice(2)}` : m[2];
  return { tool: m[1], path };
}

/** Does path rule `g` cover `other` (same tool)? A bare tool covers every path; `X/**` covers anything under X. */
function pathCovers(g, other) {
  if (g.tool !== other.tool) return false;
  if (g.path === null) return other.path !== null;
  if (other.path === null || !g.path.endsWith('/**')) return false;
  return other.path.startsWith(g.path.slice(0, -2));
}

function looksOneOff(inner) {
  return (
    /\//.test(inner) || // a path
    /\b(sed -n|perl -pi|-pi -e)\b|\b(cp|mv|rm) /.test(inner) ||
    /"[^"]{15,}"/.test(inner) // a long quoted literal
  );
}

/** Parse an `mcp__server__tool` entry -> { server, tool } (tool may be '*'). */
function mcpParts(entry) {
  if (!entry.startsWith('mcp__')) return null;
  const parts = entry.split('__');
  if (parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join('__') };
}

/** Expand a leading ~ to $HOME. */
function expandHome(p) {
  return p.startsWith('~') ? join(process.env.HOME ?? '', p.slice(1)) : p;
}

/**
 * A path for display: $HOME as ~, and a project's settings.local.json as the
 * project dir, except where that dir would be ~ itself: ~/.claude/settings.local.json
 * is the global local file, so it is shown whole.
 */
const tilde = (f) => f.replace(process.env.HOME ?? '~', '~');
const short = (f) => {
  const dir = tilde(f).replace(/\/.claude\/settings\.local\.json$/, '');
  return dir === '~' || dir === '' ? tilde(f) : dir;
};

/**
 * Resolve `reviewReport` (a report file, or a directory of dated reports) to the
 * newest report and its verdict, for surfacing at the top of a run. When nothing
 * readable is found, returns { file, why }: why is 'missing' or 'unreadable'.
 */
function latestReview(spec) {
  const p = resolve(expandHome(spec));
  let file = p;
  try {
    if (statSync(p).isDirectory()) {
      const md = readdirSync(p).filter((f) => f.endsWith('.md')).map((f) => join(p, f));
      if (md.length === 0) return { file, why: 'missing', detail: `no .md reports in ${tilde(p)}` };
      file = md.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    }
    const text = readFileSync(file, 'utf8');
    const m = text.match(/Verdict:\s*([A-Z][A-Z ]*[A-Z])/);
    return { file, verdict: m ? m[1].trim() : 'UNKNOWN' };
  } catch (e) {
    return e.code === 'ENOENT'
      ? { file, why: 'missing', detail: `nothing at ${tilde(file)}` }
      : { file, why: 'unreadable', detail: `cannot read ${tilde(file)}: ${e.code || e.message}` };
  }
}

/** Lint one settings file: its items, plus its lists for the drift check (null when unreadable). */
function lintFile(file, config, globalAllow) {
  const at = { path: file, name: short(file) };

  if (!existsSync(file)) {
    return { file, items: [makeItem({ ...at, check: 'missing', summary: 'no settings file found', reason: `nothing at ${tilde(file)}` })] };
  }

  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    const check = e instanceof SyntaxError ? 'invalid-json' : 'unreadable';
    return { file, items: [makeItem({ ...at, check, summary: check === 'invalid-json' ? 'invalid JSON' : 'cannot read', reason: e.message })] };
  }

  // Valid JSON of the wrong shape fails like invalid JSON, naming the key.
  for (const key of ['allow', 'deny']) {
    const list = json?.permissions?.[key];
    if (list == null) continue;
    const i = Array.isArray(list) ? list.findIndex((e) => typeof e !== 'string') : -1;
    const bad = !Array.isArray(list) ? `permissions.${key} is not an array`
      : i >= 0 ? `permissions.${key}[${i}] is not a string` : null;
    if (bad) return { file, items: [makeItem({ ...at, check: 'invalid', summary: 'invalid permissions', reason: bad })] };
  }

  const allow = json?.permissions?.allow ?? [];
  const deny = json?.permissions?.deny ?? [];
  const findings = { superseded: [], mcpRedundant: [], mcpConsolidate: [], sensitiveWildcard: [], sensitiveKeep: [], deadOneOff: [], pushGuard: [], inGlobal: [] };

  // --- 1. superseded Bash entries -------------------------------------------
  const bashEntries = allow.map((e) => ({ entry: e, inner: bashInner(e) })).filter((x) => x.inner !== null);
  const globs = bashEntries.map((x) => ({ ...x, prefix: globPrefix(x.inner) })).filter((x) => x.prefix !== null);

  for (const a of bashEntries) {
    const covering = globs.find((g) => g.entry !== a.entry && covers(g.prefix, a.inner));
    if (covering) {
      findings.superseded.push({ entry: a.entry, by: covering.entry });
    }
  }

  // --- 1b. superseded path rules (Read/Edit/...) ----------------------------
  const pathRules = allow.map((e) => ({ entry: e, ...pathRule(e) })).filter((x) => x.tool);
  // Two rules for the same place (`~/x/**`, `//$HOME/x/**`) cover each other;
  // only the later one is flagged, so the fix never deletes both.
  for (const [i, a] of pathRules.entries()) {
    const covering = pathRules.find((g, j) => g.entry !== a.entry && pathCovers(g, a) && !(pathCovers(a, g) && i < j));
    if (covering) findings.superseded.push({ entry: a.entry, by: covering.entry });
  }

  // --- 2 + 3. mcp wildcard opportunities, sensitive-server guard ------------
  const byServer = new Map();
  for (const e of allow) {
    const m = mcpParts(e);
    if (!m) continue;
    if (!byServer.has(m.server)) byServer.set(m.server, []);
    byServer.get(m.server).push({ entry: e, tool: m.tool });
  }
  for (const [server, tools] of byServer) {
    const hasWildcard = tools.some((t) => t.tool === '*');
    const specifics = tools.filter((t) => t.tool !== '*');
    const sensitive = config.sensitiveServers.some((re) => re.test(server));
    if (sensitive) {
      // Never suggest widening a sensitive server. An existing wildcard is
      // itself the finding (advisory) — enumerated entries are the fix, not
      // redundant, so skip the redundant check for this server.
      if (hasWildcard) findings.sensitiveWildcard.push({ server, entry: `mcp__${server}__*` });
      if (!hasWildcard && specifics.length >= 2) findings.sensitiveKeep.push({ server, count: specifics.length, entries: specifics.map((s) => s.entry) });
      continue;
    }
    if (hasWildcard && specifics.length) {
      for (const s of specifics) findings.mcpRedundant.push({ entry: s.entry, by: `mcp__${server}__*` });
    } else if (!hasWildcard && specifics.length >= 2) {
      findings.mcpConsolidate.push({ server, count: specifics.length, suggest: `mcp__${server}__*`, entries: specifics.map((s) => s.entry) });
    }
  }

  // --- 4. dead one-off candidates (advisory) --------------------------------
  for (const a of bashEntries) {
    if (globPrefix(a.inner) !== null) continue; // skip globs
    const covered = globs.some((g) => g.entry !== a.entry && covers(g.prefix, a.inner));
    const supersededAlready = findings.superseded.some((s) => s.entry === a.entry);
    if (!covered && !supersededAlready && looksOneOff(a.inner)) {
      findings.deadOneOff.push({ entry: a.entry });
    }
  }

  // --- 5. push-guard --------------------------------------------------------
  for (const guard of config.pushGuards) {
    const broad = globs.find((g) => g.prefix === guard.glob);
    if (!broad) continue;
    const denied = deny.map(bashInner).filter(Boolean).some((d) => d.startsWith(guard.requireDenyPrefix));
    if (!denied) findings.pushGuard.push(guard);
  }

  // --- 5b. in-global: entries the global settings already grant -------------
  // The global files are the baseline, so they are never checked against it.
  if (!globalAllow.files.includes(file)) {
    for (const entry of allow) {
      const g = grantedBy(entry, globalAllow.entries);
      if (g) findings.inGlobal.push({ entry, by: g.entry, file: g.file });
    }
  }

  // --- the findings as items, in report order -------------------------------
  const items = [
    ...findings.superseded.map((s) => makeItem({ ...at, check: 'superseded', summary: `superseded ${s.entry}`, reason: `covered by ${s.by}`, data: { entry: s.entry, by: s.by } })),
    ...findings.mcpRedundant.map((m) => makeItem({ ...at, check: 'redundant', summary: `redundant ${m.entry}`, reason: `covered by ${m.by}`, data: { entry: m.entry, by: m.by } })),
    ...findings.mcpConsolidate.map((m) => makeItem({
      ...at, check: 'consolidate', summary: `consolidate ${m.count} ${m.server} tools into ${m.suggest}`,
      reason: `${m.count} enumerated tools and no wildcard; ${m.server} is not a sensitive server`,
      lines: m.entries, data: { server: m.server, count: m.count, suggest: m.suggest, entries: m.entries },
    })),
    ...findings.sensitiveWildcard.map((s) => makeItem({
      ...at, check: 'sensitive-*', summary: `sensitive-* ${s.entry}`,
      reason: 'the wildcard auto-approves send/delete-class tools and any the server adds later; consider enumerating instead',
      data: { server: s.server, entry: s.entry },
    })),
    ...findings.sensitiveKeep.map((s) => makeItem({
      ...at, check: 'enumerated', summary: `enumerated ${s.count} ${s.server} tools`,
      reason: 'a sensitive server, so kept as is; consolidation is deliberately not suggested',
      data: { server: s.server, count: s.count, entries: s.entries },
    })),
    ...findings.deadOneOff.map((d) => makeItem({ ...at, check: 'one-off?', summary: `one-off? ${d.entry}`, reason: 'looks single-use', data: { entry: d.entry } })),
    ...findings.pushGuard.map((g) => makeItem({
      ...at, check: 'push-guard', summary: `push-guard Bash(${g.glob} *)`,
      reason: `no deny on ${g.requireDenyPrefix}: ${g.why}`,
      data: { glob: g.glob, requireDenyPrefix: g.requireDenyPrefix },
    })),
    ...findings.inGlobal.map((g) => makeItem({
      ...at, check: 'in-global', summary: `in-global ${g.entry}`,
      reason: `already allowed by ${tilde(g.file)}${g.by === g.entry ? '' : ` (${g.by})`}`,
      data: { entry: g.entry, by: g.by, file: g.file },
    })),
  ];
  if (items.length === 0) {
    items.push(makeItem({ ...at, check: 'clean', summary: `clean (${allow.length} allow, ${deny.length} deny)`, data: { allow: allow.length, deny: deny.length } }));
  }
  return { file, items, allow, deny };
}

/** --- 6. cross-file drift: one item per entry not in every file, or one clean item. */
// settings.json and settings.local.json in one directory are layers of one
// scope that Claude Code merges, not two projects, so drift compares their union.
const LAYERED = new Set(['settings.json', 'settings.local.json']);

function driftItems(linted, config) {
  const scopes = new Map();
  for (const r of linted.filter((x) => x.allow)) {
    const key = LAYERED.has(basename(r.file)) ? dirname(r.file) : r.file;
    const s = scopes.get(key) ?? { key, files: [], allow: new Set(), deny: new Set() };
    if (s.files.includes(r.file)) continue;
    s.files.push(r.file);
    r.allow.forEach((e) => s.allow.add(e));
    r.deny.forEach((e) => s.deny.add(e));
    scopes.set(key, s);
  }
  if (scopes.size < 2) return [];
  const sets = [...scopes.values()].map((s) => ({
    ...s,
    name: s.files.length === 1 ? short(s.files[0]) : `${tilde(s.key)}/{${s.files.map((f) => basename(f)).join(',')}}`,
  }));
  const union = (key) => new Set(sets.flatMap((s) => [...s[key]]));
  const mismatch = (key) => {
    const out = [];
    for (const entry of union(key)) {
      if (config.siteSpecific.some((re) => re.test(entry))) continue;
      const present = sets.filter((s) => s[key].has(entry));
      if (present.length !== sets.length) out.push({ list: key, entry, present, missing: sets.filter((s) => !s[key].has(entry)) });
    }
    return out;
  };
  const drift = [...mismatch('allow'), ...mismatch('deny')];
  const at = { path: null, name: 'cross-project' };
  if (drift.length === 0) {
    return [makeItem({ ...at, check: 'clean', summary: 'allow/deny lists match', reason: 'site-specific entries ignored', data: { files: sets.flatMap((s) => s.files) } })];
  }
  return drift.map((d) => makeItem({
    ...at, check: 'drift', summary: `${d.list} drift ${d.entry}`,
    reason: `missing from ${d.missing.map((s) => s.name).join(', ')}`,
    lines: [`present in ${d.present.map((s) => s.name).join(', ')}`],
    data: { list: d.list, entry: d.entry, present: d.present.flatMap((s) => s.files), missing: d.missing.flatMap((s) => s.files) },
  }));
}

/** The latest prior review's verdict as the run's first item, when the config names one. */
function reviewItems(config) {
  if (!config.reviewReport) return [];
  const rv = latestReview(config.reviewReport);
  if (rv.why) {
    return [makeItem({
      path: rv.file, name: tilde(rv.file), check: 'review-missing',
      summary: `review report ${rv.why}`, reason: rv.detail, data: { why: rv.why },
    })];
  }
  return [makeItem({
    path: rv.file, name: tilde(rv.file), check: 'review', reviewVerdict: rv.verdict,
    summary: `latest review: ${rv.verdict}`,
    reason: /^CLEAN\b/.test(rv.verdict) ? '' : 'address its recommendations alongside this tune',
    data: { verdict: rv.verdict },
  })];
}

// ---- contract hooks (the fenced runtime below relies on these) --------------

// Read-only: nothing mutates, so nothing is gated behind --go.
const MUTATING_COMMANDS = new Set();
const AUTO_RUN_COMMANDS = new Set();
const EXTRA_OVERRIDE_FLAGS = [];
const GO_ALIASES = [];

// The next-action policy, the single source of `next`. Pure: it reads the
// finished items. The skill's runbook decides what follows a finding: propose
// the edits and let the user approve each one, so findings are `ask`, never
// `run`. A settings file that cannot be read is beyond this tool's remedy:
// `stop`. That is why a definite finding, though it fails, does not take the
// runtime's default `stop`: a superseded entry is a finding to propose, not a
// broken run. A path with no settings file has nothing to edit: its remedy is
// a different path. A non-CLEAN review (skip) never holds the run open.
function nextAction({ items }) {
  const unreadable = items.filter((it) => it.check === 'invalid-json' || it.check === 'unreadable' || it.check === 'invalid');
  if (unreadable.length) return nextStep('stop', `cannot lint ${listNames(unreadable)}: fix the settings file, then run again`);
  const findings = items.filter((it) => it.verdict === 'warn' || it.verdict === 'fail').length;
  const missing = items.filter((it) => it.check === 'missing');
  const where = missing.length && `no settings file at ${listNames(missing.map((it) => ({ name: tilde(it.path) })))}: re-run with a project dir or a settings .json file`;
  if (findings && missing.length) return nextStep('ask', `propose edits for the ${count(findings, 'settings finding')}; ${where}`);
  if (missing.length) return nextStep('ask', where);
  if (findings) return nextStep('ask', `propose edits for the ${count(findings, 'settings finding')} to the user; change nothing until they approve`);
  const review = items.find((it) => it.check === 'review' && it.verdict !== 'ok');
  if (review) return nextStep('done', `settings clean; latest harness review is ${review.reviewVerdict}: surface its recommendations to the user`);
  return nextStep('done', 'clean: no edits to propose');
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
        brief: { type: 'boolean' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean' },
        config: { type: 'string' },
        ci: { type: 'boolean' }, // the older exit switch, kept so existing commands still run; a no-op now
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

  const mode = outputMode(values);
  if (positionals.length === 0) usageError('no path (expected a project directory or a settings .json file)');

  const config = loadConfig(values.config ?? null);
  const globalAllow = loadGlobalAllow(config);
  const linted = positionals.flatMap(resolveSettings).map((file) => lintFile(file, config, globalAllow));
  const items = [...reviewItems(config), ...linted.flatMap((r) => r.items), ...driftItems(linted, config)];

  const command = 'lint';
  const effect = effectFor(command, false);
  const argv = process.argv.slice(2);
  const next = nextAction({ command, items, effect, state: null, argv });
  report({ command, effect, items, next, mode, argv });
}

// ---- mjs-tool runtime v2 (do not edit; replace wholesale) ----
// The shared machinery of contract mjs-tool/2, byte-identical in every tool
// built from mjs-tool-skeleton. It carries its own imports (namespaced, so they
// never collide with the tool's); its other top-level names are unprefixed, so
// a tool keeps no copies of them. The tool supplies, outside this block:
// MUTATING_COMMANDS, AUTO_RUN_COMMANDS, EXTRA_OVERRIDE_FLAGS, GO_ALIASES,
// main(), and a nextAction() policy whose result it hands to report(); the
// block checks their shapes as it loads. To move a tool to a later contract,
// swap this whole block.

import * as runtimeFs from 'node:fs';
import * as runtimePath from 'node:path';
import * as runtimeUrl from 'node:url';

const CONTRACT = 'mjs-tool/2';

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

const VERDICT_WIDTH = 6; // longest verdict word ("refuse")
const SUMMARY_WIDTH = 38; // brief-mode column alignment (fits the longest shipped summary)

function summaryLine(s, effect) {
  const base = `summary: ok=${s.ok} warn=${s.warn} skip=${s.skip} refuse=${s.refuse} fail=${s.fail}`;
  return effect === 'dry-run' ? `${base}  (dry run: pass --go to apply)` : base;
}

// One line per item. The parenthesised reason appears only for a non-ok verdict.
function briefLine(item) {
  const showReason = item.verdict !== 'ok' && item.reason;
  return `${glyph(item.verdict)} ${item.verdict.padEnd(VERDICT_WIDTH)} ${printable(item.summary).padEnd(SUMMARY_WIDTH)} ${printable(item.name)}`
    + (showReason ? `  (${printable(item.reason)})` : '');
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
  if (mode === 'brief') {
    for (const it of items) lines.push(briefLine(it));
  } else if (mode === 'human') {
    for (const it of items) {
      lines.push(`${glyph(it.verdict)} ${printable(it.name)}`, `    ${printable(it.summary)}`);
      for (const line of it.lines || []) lines.push(`    ${printable(line)}`);
      if (it.reason) lines.push(`    ${it.verdict === 'ok' ? 'note' : it.verdict}: ${printable(it.reason)}`);
    }
    lines.push('');
  }
  lines.push(summaryLine(summary, effect));
  if (next) lines.push(nextLine(next, mode));
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
function helpText() {
  const lines = runtimeFs.readFileSync(SCRIPT_PATH, 'utf8').split('\n');
  const out = [];
  for (const l of lines.slice(1)) {
    if (!l.startsWith('//')) break;
    out.push(l.slice(3));
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
// ---- end mjs-tool runtime v2 ----
