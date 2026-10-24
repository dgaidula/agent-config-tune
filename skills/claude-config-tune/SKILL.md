---
name: claude-config-tune
description: Lint and tune Claude Code configuration — deterministic hygiene checks for .claude permission allow-lists (superseded globs, redundant MCP enumerations, sensitive-server wildcards, missing dangerous-command denies, cross-project drift) plus an advisory, measured method for trimming CLAUDE.md context cost. Use when allow-lists feel bloated, approval prompts feel repetitive, or CLAUDE.md has grown past its usefulness.
---

# claude-config-tune

Keep `.claude/settings.local.json` permission lists and `CLAUDE.md` lean. Two
modes — run whichever the user asks for; default to **lint** if unspecified.

The token framing matters and is worth stating to the user:

- **CLAUDE.md is injected into context every session** — trimming it is
  *recurring* token savings. Real, but judgment-heavy.
- **The allow-list is config, NOT in the context window** — cleaning it saves
  *interaction friction* (fewer approval prompts, less re-explaining), not
  context tokens. Still worth it, just for a different reason.

## Mode 1 — lint (deterministic)

Run the linter against one or more project dirs (or settings files). A
project dir is linted through both its layers — `.claude/settings.json` and
`.claude/settings.local.json`, whichever exist — each reported under its own
path. It only REPORTS — it never edits.

```bash
node <skill-dir>/lint.mjs --brief <project-dir-or-settings.json>...
```

For the global settings, pass the two files by name:
`node <skill-dir>/lint.mjs --brief ~/.claude/settings.json ~/.claude/settings.local.json`.
A bare `~/.claude` is read as a project dir, so it looks for
`~/.claude/.claude/settings.local.json` and refuses.

Pass 2+ projects to also run the cross-project drift check. `--brief` prints
one line per item — verdict, finding, the project it is in, and a
parenthesised reason for anything not `ok` — then a `summary:` line and a
`next:` line. When you need the detail, run the same command with `--json`
instead: each item’s `data` carries its check label (`data.check`) and the
finding’s specifics, such as the entries a consolidation would replace, or
the files a drift entry is in and missing from.

- **Verdicts.** `fail` is a definite finding (superseded, redundant) or a
  settings file that cannot be read (or whose permission lists are not
  arrays of strings); `warn` is advisory; `skip` is a sensitive server
  deliberately left enumerated, or a review that is not CLEAN; `refuse` is a
  path with no settings file; `ok` is a clean file (or a CLEAN review).
- **Exit code.** `0` every settings item `ok` (a `skip` is not a
  finding), `1` findings, `2` usage error, `3` the config
  could not be read. On `2` or `3` stdout is empty: report stderr and stop.
- **`next:`** `done` means every settings item is `ok`, so there is nothing
  to propose (if it names a review that is not CLEAN, surface that review’s
  recommendations to the user); `ask` means propose the edits (below) and
  wait for the user, or, when a path had no settings file, re-run with the
  right path; `stop` means a settings file is unreadable, so report it.
  Quote the summary line and every non-`ok` line back as printed.

Add `--config tune.json` to extend the defaults with your own site-specific
patterns, sensitive servers, and dangerous-command guards (schema:
`node <skill-dir>/lint.mjs --help`). A `tune.json` beside `lint.mjs` is
loaded without the flag. `--ci` is still accepted, and changes nothing.

If the config sets **`reviewReport`** (a path to a prior review report, or a
directory of dated ones), the run’s first item is that report’s latest
**verdict** (`latest review: …`, `skip` unless CLEAN) — so a
`CHANGES RECOMMENDED` / `BLOCKING` review from an upstream check (e.g. a
toolchain-update routine) gets addressed alongside the tune instead of
sitting unread. Note config-tune’s own scope is the allow-list + CLAUDE.md; a
report may recommend things beyond that (auto-mode, hooks, settings) —
surface those to the user, don’t silently skip them. The review never makes
the run fail: you are done when every settings item is `ok`, and the review
item stays in the output until the next CLEAN review.

What it flags:

- **superseded** — a narrow `Bash(...)` already covered by a broader
  `Bash(X *)` glob, or a narrow `Read(...)` / `Edit(...)` path rule
  covered by the same tool’s `dir/**` (or the bare tool name) → delete
  the narrow one.
- **redundant** — an enumerated `mcp__server__tool` already covered by a
  `mcp__server__*` wildcard → delete it.
- **consolidate** — 2+ enumerated tools on one server with no wildcard →
  replace with `mcp__server__*`. **Exception:** servers matching the
  sensitive list (send/delete/payment-shaped tools — gmail, slack, stripe,
  composio, …) are never consolidation candidates; a wildcard there
  auto-approves outward actions and any tool the server adds later.
- **sensitive-\*** — an *existing* wildcard on a sensitive server, flagged
  advisory with enumeration as the suggested fix.
- **enumerated** — that exception at work: a sensitive server’s tools left
  enumerated (`skip`). Nothing to do.
- **one-off?** — a non-glob Bash entry that looks single-use (a path,
  `sed -n`, a long quoted literal). **Advisory** — confirm with the user it
  won't recur before removing.
- **push-guard** — a broad dangerous glob (default: `Bash(git *)`) with no
  deny shadowing its dangerous subcommand (`git push`).
- **in-global** — a project allow entry your global settings
  (`~/.claude/settings.json` + `settings.local.json`) already grant, word for
  word or through a covering glob, `dir/**` or `mcp__server__*`.
  **Advisory** — a copy in a committed `settings.json` may be deliberate,
  for cloud sessions or teammates that run without your global settings;
  ask before deleting. `globalSettings` in the config replaces the baseline
  (`[]` turns the check off).
- **drift** — allow/deny entries present in some projects but not all,
  excluding configured site-specific patterns. A `settings.json` and a
  `settings.local.json` in one directory are layers Claude Code merges, so
  they count as one scope (their union); the global pair alone has no drift.

**Skill size.** `--skills <dir>` (repeatable) adds one item per `<dir>/*/SKILL.md`
with its bytes and estimated tokens (UTF-8 bytes / 4, rounded up — an estimate,
not a tokenizer), biggest first. Claude Code re-injects an invoked skill after
compaction capped at 5,000 tokens per skill and 25,000 in total, keeping only
the start of the file (`code.claude.com/docs/en/context-window.md`, “What
survives compaction”). For the global skills:
`node <skill-dir>/lint.mjs --brief --skills ~/.claude/skills` (no project path is
needed; with one, both are checked in the same run).

- **skill-size** — a SKILL.md over 4,000 estimated tokens (headroom under the
  cap). **Advisory** — propose the split: keep the always-needed procedure and
  the closing rules in `SKILL.md`, move rarely needed parts to
  `references/<topic>.md`, and leave a one-line pointer where each part was
  (“read `references/build-mode.md` before an `--build-mode=api` run”). Every
  instruction must survive, either in `SKILL.md` or behind a pointer that says
  when to read it.
- **skill-cut** — the skill’s last `##` section starts past the 5,000-token cap,
  so after compaction that section is cut (often a closing “Done means”).
  Headings inside code fences are not sections.
- **skill-ok** — fits; listed with its size.

After reporting, **propose** the concrete edits and let the user approve
before touching any file. Apply the removals/wildcards/denies, then re-run
the linter to confirm clean.

## Mode 2 — review (advisory, judgment-heavy)

CLAUDE.md prose tune-up. **Not automated** — verbosity in these files is
often hard-won lessons that only *look* trimmable. Surface candidate cuts as
a report; the user approves each one; never auto-edit.

**Trim heuristics**, in descending order of yield:

- **Relocate, don't delete** — the highest-yield move: relocate history and
  backstory to an on-demand sibling file (e.g. `changelog-archive.md`) and
  leave a one-line pointer ("read that for the story; read this every
  session for the rules"). Content survives; the every-session cost doesn't.
  Keep the main file current-state-only, with new history appending to the
  archive.
- **Backstory vs. rule** — keep the actionable rule, cut the narrative of
  how it was learned. If the *why* is load-bearing (prevents the model
  re-trying a bad path), compress it to one clause with an archive pointer.
- **Duplicated warnings** — the same caution in two sections; keep the one
  nearest where it applies.
- **War-story parentheticals** — "(this happened when…)" asides that don't
  change model behavior.
- **Derivable content** — anything the model can read from the repo itself
  (file structure, command output) shouldn't be prose.
- **Dead references** — rules about files, tools, or workflows that no
  longer exist.

**Measure the win:** count tokens before and after — exact via the
`count_tokens` API, or words × 1.33 labeled as an estimate. Report it as
"N → M tokens per session" (recurring savings), not a percentage feeling.

**Verify the trim:** record the trim date in the tuned file. Over the
following sessions, watch for the model violating a trimmed rule — one
violation means the rule was load-bearing; restore it immediately rather
than debating. "No degradation" is a claim that needs this watch period
behind it.

**Multi-project harmonization:** where several projects share a config
template, their CLAUDE.md files should differ only on intended deltas.
Report any other divergence; apply approved trims to all of them in
lockstep.

## Managed dotfiles (chezmoi & friends)

Some targets are not real files but rendered copies a dotfile manager owns —
editing them in place gets clobbered on the next sync and never reaches other
machines. Before applying ANY edit to a global `CLAUDE.md` or `settings.json`,
check whether it is managed:

```bash
command -v chezmoi >/dev/null && chezmoi source-path "<file>"
```

- **Resolves** → the file is chezmoi-managed. Edit the **source path it
  prints**, not the live file; then run `chezmoi apply`, and tell the user to
  commit + push in their dotfiles repo (you apply locally; they push).
- **Non-zero / no chezmoi** → not managed; edit in place as usual.

Two guards on the resolved source:

- **Template** (path ends `.tmpl`): a Go template with `{{ … }}` directives.
  Prose trims are fine, but never edit through a template directive — if a cut
  lands near one, surface it and let the user make it.
- **Private template** (`private_*.tmpl`, e.g. an encrypted settings file): do
  NOT auto-edit — warn and defer to `chezmoi edit "<file>"`, which handles
  decryption and re-encryption.

`settings.local.json` (Mode 1's target) is normally machine-local and NOT
managed — edit it in place. Per the git rule above, do not push; apply locally
and hand the commit/push to the user.
