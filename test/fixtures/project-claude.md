# Sample project

A volunteer-run catalogue of the seeds a neighbourhood library lends out.
*Nothing here is code*: it is Markdown, a few CSV files and a word list.

**Ask before renaming a variety.** Gardeners search by the old names, so a
rename gets a redirect line in `ALIASES.md`.

## Layout

- `catalogue.csv` lists every variety with its germination rate; the
  printed shelf cards are made from it.
- `growers/` keeps a page for each volunteer grower, linked from
  `growers/INDEX.md`.
- `harvests/` keeps the yearly counts:
  - a closed year stays as it was;
  - a recount goes in a new file (`2025-recount.csv`) beside the old one.
- `posters/` keeps the printable signs and their source files.

## Lending rules

1. A packet goes out with a return card. Borrowers bring back seed from
   their own crop at the end of the season.
2. Squash and pumpkin cross easily. Their packets carry a warning label
   and go only to growers who can keep them apart.
3. Write the lot code on every packet before it leaves the shelf.
4. Test germination in spring and again in autumn.

## Commands

```sh
npm test
node scripts/cards.mjs --shelf B

- not a bullet, inside a fence
```

* Star bullets are bullets too.
+ So are plus bullets.

## Before a swap day

- **Shelf check**: count the packets on each shelf against the catalogue;
  **a missing packet** goes on the lost list, not back in stock.
- Print fresh cards for any variety whose rate changed.

<!-- A comment is not something to trim. -->

## Before a swap day

- A heading may repeat; its chunks must not overwrite each other.
