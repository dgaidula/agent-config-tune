# claude-config-tune

A Claude Code skill for configuration hygiene: a deterministic, report-only
**linter for permission allow-lists**, and a measured, verified **method for
trimming CLAUDE.md** context cost.

## Two problems, two different economics

Claude Code configuration bloats in two places, and they cost you differently:

- **`CLAUDE.md` is injected into context every session.** Every stale rule,
  duplicated warning, and war-story paragraph is a tax on *every session
  forever*. Trimming it is recurring savings.
- **The permission allow-list is config, not context.** Bloat there costs
  *friction* — approval prompts for things a glob already covers, drift
  between projects that should match — not tokens. Different problem, still
  worth fixing.

Most token-optimization advice conflates these. This skill treats them as
what they are: a mechanical lint problem and a judgment-heavy editing
problem, handled by different modes with different trust models.

## Mode 1 — the linter (deterministic, report-only)

```bash
node skills/claude-config-tune/lint.mjs <project-dir>...           # a report for a person
node skills/claude-config-tune/lint.mjs --brief <project-dir>...   # one line per item, for an agent
node skills/claude-config-tune/lint.mjs --json <project-dir>...    # one stable object, for a script
```

Zero dependencies, never edits. It follows the
[`mjs-tool/2`](https://github.com/dgaidula/mjs-tool-skeleton) contract:
human, `--brief`, `--json` and `--quiet` output rendered from one list of
items, a closing `next:` line that says what to do next, and exit codes
that mean the same thing every time: `0` clean, `1` any finding, `2` a usage
error, `3` a config it could not read. Definite findings are `fail`,
advisory ones `warn`. To fail CI on definite findings only, test
`summary.fail` in the `--json` output. (`--ci`, from before the contract,
is still accepted and changes nothing.) What it flags:

| Finding | Verdict | Meaning |
|---|---|---|
| `superseded` | `fail` | A narrow `Bash(...)` entry already covered by a broader `Bash(X *)` glob, or a path rule (`Read`, `Edit`, `Write`, `NotebookEdit`) covered by the same tool’s `dir/**` rule or bare tool name (`~/` and `//$HOME/` compare as one) |
| `redundant` | `fail` | An enumerated `mcp__server__tool` already covered by that server’s `*` wildcard |
| `consolidate` | `warn` | 2+ enumerated tools on one server: suggest the wildcard |
| `sensitive-*` | `warn` | A wildcard on a **sensitive server** (gmail, slack, stripe, composio, …): enumerate instead |
| `enumerated` | `skip` | 2+ enumerated tools on a sensitive server, deliberately left as they are |
| `one-off?` | `warn` | A Bash entry that looks single-use (confirm before removing) |
| `push-guard` | `warn` | A broad dangerous glob (default `git *`) with no deny on its dangerous subcommand (`git push`) |
| `in-global` | `warn` | A project allow entry your global `~/.claude` settings already grant, word for word or through a covering glob (a committed copy may be deliberate; confirm before removing) |
| `drift` | `warn` | Entries present in some of your projects but not all (a `settings.json` + `settings.local.json` pair in one directory counts as one merged scope) |

**The sensitive-server guard is the part you won't find elsewhere.**
Consolidating `mcp__gmail__search` + `mcp__gmail__get_message` into
`mcp__gmail__*` looks like cleanup — but the wildcard silently auto-approves
`send_message`, and every tool that server adds later. Sensitive servers are
never consolidation candidates here, and an existing wildcard on one is
flagged with enumeration as the fix. Widening permissions is a security
decision, not a hygiene win; the linter knows the difference.

Extend the defaults (site-specific drift exclusions, your own sensitive
servers, additional dangerous-glob guards) via `--config tune.json`, or put
a `tune.json` beside `lint.mjs`. The schema is in `lint.mjs --help`.
A config’s `reviewReport` (a prior review report, or a directory of dated
ones) puts that review’s verdict first in the run: `ok` when CLEAN,
otherwise `skip`, shown with its reason but never failing the run. You are
done when every settings item is `ok`; the review item stays until the next
CLEAN review. A `reviewReport` that points at nothing readable (no file, an
empty directory, or a file it cannot read) is a `skip` item too, naming the
path and why, so a mistyped path never passes silently.

For your global settings, pass both files:
`lint.mjs ~/.claude/settings.json ~/.claude/settings.local.json` (a bare
`~/.claude` is read as a project dir and refuses).

**Skill size** (opt in with `--skills <dir>`, repeatable; no project path is
needed): Claude Code re-injects an invoked skill after a compaction, capped at
5,000 tokens per skill and 25,000 in total, and keeps only the start of the
file ([context-window docs](https://code.claude.com/docs/en/context-window.md),
“What survives compaction”). So a long `SKILL.md` loses its tail, which is often
the closing rules. The linter lists every `<dir>/*/SKILL.md` with its bytes and
estimated tokens (the estimate is UTF-8 bytes / 4, rounded up; no tokenizer),
biggest first:

| Finding | Verdict | Meaning |
|---|---|---|
| `skill-ok` | `ok` | The skill fits; its size is listed |
| `skill-size` | `warn` | Over 4,000 estimated tokens, which leaves headroom under the 5,000 cap |
| `skill-cut` | `warn` | The skill’s last `##` section starts past the 5,000-token cap, so that section is what gets cut (headings inside code fences do not count) |

A skills directory that is not there refuses. The fix is to keep the always-needed
procedure and the closing rules in `SKILL.md` and move rarely needed parts into
`references/<topic>.md`, with a one-line pointer saying when to read each.

Tests: `npm test` (Node 20+, `node --test`, no dependencies).

## Mode 2 — the CLAUDE.md review (advisory, measured, verified)

Not automated, on purpose: CLAUDE.md verbosity is often hard-won lessons
that only *look* trimmable. Instead, the skill gives the model a trim
method: six heuristics in descending order of yield (the big one:
**relocate history to an on-demand archive file, don't delete it**), a
measurement step (report "N → M tokens per session," not a percentage
feeling), and a verification protocol (date the trim, watch the following
sessions, restore any trimmed rule the model violates — once).

### Case study

Run against a production Claude project (the author's career-ops pipeline,
Claude + Google Drive): the always-loaded `CLAUDE.md` went from **~60KB to
~36KB** (~10.8k → ~6.5k tokens estimated) — a ~40% recurring cut — by
relocating session history to an on-demand `changelog-archive.md` with a
one-line pointer, keeping the main file current-state-only. Executed by
Claude Sonnet 5 at high effort using this skill; no rule violations
observed in the sessions since (trim dated 2026-07-19, watch ongoing).

## Token footprint

~175 tokens always-on (only the description loads until the skill fires) —
measured with `claude plugin details claude-config-tune`; re-run it yourself,
the numbers drift as the skill evolves. A config-hygiene skill that bloated
your config would be refuting itself.

## Install

As a plugin:

```
/plugin marketplace add dgaidula/claude-config-tune
/plugin install claude-config-tune
```

Or manually, as a personal skill:

```sh
git clone https://github.com/dgaidula/claude-config-tune
cp -r claude-config-tune/skills/claude-config-tune ~/.claude/skills/
```

The linter also works standalone — it's a single zero-dependency `.mjs` you
can run or wire into CI without installing the skill at all.

## Use

```
/claude-config-tune
```

…or describe the problem ("my allow-list is bloated", "trim this CLAUDE.md")
and let Claude load it. Lint is the default mode; ask for "review" for the
CLAUDE.md pass.

Pairs with [orchestrator-discipline](https://github.com/dgaidula/orchestrator-discipline)
— same philosophy applied to a different layer: run your AI tooling like
production infrastructure, with measured footprints, linted configs, and
disciplined delegation.

## License

MIT © Danniel T. Gaidula
