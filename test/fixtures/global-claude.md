# Personal preferences

## About me

A short paragraph describing the person these notes are for, written the
way people write them: a few sentences that wrap across several lines and
carry the context every session should start with.

<!-- Reminder to self: review this file every quarter. -->

## Tooling

- **Editor**: tabs in Makefiles and Go, two spaces everywhere else.
- **Formatting**: one formatter per project, never two that disagree.
- **Dependencies**: exact versions in applications, ranges in libraries;
  a pin older than a year carries a comment saying why.
- Ask before adding a database migration, and describe how to roll it
  back in the same message.
- **Logs**: structured, one event per line, with no tokens in them.

## Writing

Commit subjects stay under seventy characters, and the body says why the
change was made rather than restating the diff.

- Lead with the outcome.
- Readable beats concise.

## Environment

- **Machines**: a desktop at home and a rented build box; say which one a
  command ran on.
- **Backups**: nightly, to a second disk; check the log before assuming.
