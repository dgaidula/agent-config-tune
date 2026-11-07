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
[`mjs-tool/3`](https://github.com/dgaidula/mjs-tool-skeleton) contract:
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

Tests: `npm test` (Node 20+, `node --test`, no dependencies). The `split.mjs` and
`measure.mjs` tests run each tool from a temporary copy; `measure.mjs`’s tests run
on a `PATH` of the stub `claude`’s folder (first), `/usr/bin` and `/bin`, and check
those for any other `claude` before running, so no test can reach a real `claude`, and `test/fixtures/` holds two made-up CLAUDE.md files for the split round
trip.

## Mode 2 — the CLAUDE.md review (advisory, measured, verified)

Not automated, on purpose: CLAUDE.md verbosity is often hard-won lessons
that only *look* trimmable. Instead, the skill gives the model a trim
method: six heuristics in descending order of yield (the big one:
**relocate history to an on-demand archive file, don't delete it**), a
measurement step (report "N → M tokens per session," not a percentage
feeling), and a verification protocol (date the trim, watch the following
sessions, restore any trimmed rule the model violates — once).

### Measuring each bullet: `split.mjs` and `measure.mjs`

The method needs a price for each bullet, not only a total. Two more tools carry
that out. They follow the same `mjs-tool/3` contract as the linter: human,
`--brief`, `--json` and `--quiet` output from one item list, a dry run unless
`--go`, exit codes 0/1/2/3, and no prompting. `--help` has the full flag list and
`--cheat` the common command lines.

1. `split.mjs` cuts the file into chunks, one per bullet.
2. `measure.mjs` prices every chunk, so each bullet’s cost per session is a number
   and not a feeling.
3. Trim the expensive chunks that carry the least (the heuristics are in
   `SKILL.md`), then run both again on the trimmed file to report “N → M tokens per
   session”.

```sh
node skills/claude-config-tune/split.mjs ~/.claude/CLAUDE.md --out /tmp/chunks        # dry run: lists the chunks
node skills/claude-config-tune/split.mjs ~/.claude/CLAUDE.md --out /tmp/chunks --go   # writes them
node skills/claude-config-tune/measure.mjs /tmp/chunks                                # dry run: lists what it would price
node skills/claude-config-tune/measure.mjs /tmp/chunks --go --brief                   # prices them (spends subscription usage)
```

#### `split.mjs`

Writes `<dir>/<section>--<nn>-<label>.txt` for each chunk of one Markdown file:

- a **bullet** (with its wrapped lines and nested bullets) or a **paragraph**;
- the **section** is the slug of the nearest heading above it (`head` before the
  first), and a heading used twice gets `-2`, `-3`;
- the **number** counts chunks through the whole file, so sorting by it restores
  source order;
- the **label** is the bullet’s bold lead-in (`- **Secrets**: …` gives
  `secrets`), else its first 30 characters;
- each heading is written too, as `<section>--heading.txt`, and the first `# `
  heading as `title.txt`.

HTML comment blocks are not chunked (a comment is not something to trim); they are
counted in a `comments` item so the omission is visible.

`--out` must name a folder that does not exist or is empty. A folder with anything
in it is refused, so a stale chunk from an earlier cut can never be priced.

It assumes a CLAUDE.md in ordinary Markdown: ATX headings (`## Name`), `-`, `*`,
`+` or numbered bullets, blank-line paragraphs and fenced code blocks. It does not
handle setext headings (underlined with `===` or `---`), a table as anything but a
paragraph, a bullet inside a blockquote, or front matter (a YAML block is one
chunk). A Markdown parser would read these; none is used, so the skill folder
stays a copy-and-run install with no `node_modules`.

#### `measure.mjs`

For each `<chunk-dir>/*.txt`, one `claude -p` run on the haiku model with the chunk
appended to the system prompt (`--append-system-prompt-file`), and one baseline run
appending a one-line file. A chunk’s cost is the prompt tokens of its run (input,
cache creation and cache read) minus the baseline’s. Heading files
(`*--heading.txt`, `title.txt`) are listed as skipped and not priced.

The runs happen in a fresh empty folder, so no project CLAUDE.md adds to either
side, and with `--no-session-persistence`, so they leave no transcripts. `--workers
<n>` (1 to 16, default 4) sets how many go at once. Each run has a 180-second bound
that ends a hang.

- **A dry run is the default and runs nothing.** It lists the baseline run and every
  chunk it would price.
- **`--go` makes one baseline run plus one run per chunk,** so a 40-chunk file is 41
  `claude -p` calls on your subscription. Check that you have the headroom first.
- **Subscription login only.** It refuses to run, dry run included, with exit 3 and
  nothing on stdout, while any of these environment variables is set to a value,
  because a run would then bill an API account: `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_AWS_API_KEY`, `ANTHROPIC_FOUNDRY_API_KEY`,
  `ANTHROPIC_FOUNDRY_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`,
  `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_PROFILE`, `CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` (from
  [`code.claude.com/docs/en/env-vars`](https://code.claude.com/docs/en/env-vars),
  read 2026-11-06), `CLAUDE_CODE_USE_ANTHROPIC_AWS`,
  `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` and `CLAUDE_CODE_USE_MANTLE` (each makes
  `claude auth status` report a third-party provider, claude 2.1.319). It never
  unsets one for you; unset it yourself and run again. An empty value counts as
  unset.
- **Then it asks claude which account it would use.** Dry run included, it runs
  `claude auth status --json` (which spends nothing) in a fresh empty folder, as the
  runs are, and refuses with exit 3 and one line unless that says `loggedIn` true,
  `authMethod` `claude.ai` and `apiProvider` `firstParty`. That catches what the
  variable list cannot see: a settings-file `apiKeyHelper` or an
  `env.ANTHROPIC_API_KEY`. A clean dry run names the login on its baseline line.
- It needs `claude` on `PATH`; without one it exits 3.

Each chunk’s item says `N tokens`; the last item, `total`, sums them. A run that
fails is a `fail` item (the rest still run). A chunk that comes back under the
baseline is a `warn`: the cost is noise, so run it again. A failed baseline stops the
run before any chunk is priced. It does not retry a failed run.

Known limits:

- The login check trusts `claude auth status --json` and its field names as claude
  2.1.319 prints them. A later claude that renames one is refused, not passed, until
  this is updated.
- `measure.mjs` has run only against the tests’ stub `claude`, never live, so no
  real chunk has been priced with it yet.

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
measured with `claude plugin details agent-config-tune`; re-run it yourself,
the numbers drift as the skill evolves. A config-hygiene skill that bloated
your config would be refuting itself.

## Install

As a plugin:

```
/plugin marketplace add dgaidula/agent-config-tune
/plugin install agent-config-tune
```

Or manually, as a personal skill:

```sh
git clone https://github.com/dgaidula/agent-config-tune
cp -r agent-config-tune/skills/claude-config-tune ~/.claude/skills/
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
