# Regeneration — rewriting a map into a shape the plugin can read

Status: shipped (0.1.0) · Read when: changing `feature_map_regen`,
`src/regen.ts`, the chunking, the placeholder headings, or the index reconcile

## What it does

- Reads the map that already exists — every page under `docs/features/` and the
  index — and rewrites it so the plugin can hand out one section at a time.
- Adds what is missing: a `# ` title, a `Status: … Read when:` line (its trigger
  taken from the page's own index row), and any of the six template `##` headings,
  each with a visible fill-in comment.
- Divides every section larger than `maxSectionBytes` at boundaries the author
  already wrote, into `###` chunks that each fit one read.
- Names a chunk from the author's own bold lead-in when it is paragraph-initial
  and short enough; otherwise it inserts a visible
  `### <!-- chunk 1/2: name this -->` and lists it in the reply.
- Reconciles the index with the pages: a row that resolves is left byte-identical,
  a broken link is re-pointed, a page with no row gets one, a row no page claims is
  dropped and printed.
- Plans by default. `apply: true` writes the files; `show: true` returns the
  rewritten text. Nothing outside `docs/features/` is ever touched.

## Map

- `src/regen.ts` — `findIndexTable()`, `rewriteIndexTable()`,
  `regeneratePage()`, `planRegen()`, `applyRegen()`, and the internals
  `chunkSection()`, `SECTION_HINTS`, `MAX_LEAD_IN`, `HEADING_RESERVE`.
- `src/index.ts` — the `feature_map_regen` tool, `renderRegenText()`, and
  `writeThrough()`, the write seam it shares with the scaffold.
- `src/map.ts` — `renderIndexRow()` and `TRIGGER_PLACEHOLDER`, shared so a
  regenerated row and a generated table can never disagree about a row's shape.
- `scripts/smoke.mjs` — prints what a regeneration would change, without writing.

## How & why

### Structure only, never prose

Every edit is a line range over the original line array, applied highest position
first, so the file's EOL style, a BOM and a missing final newline all survive. The
single text edit is dropping the `**` markers around a lead-in that becomes a
heading — no sentence is added, removed, reordered or reworded, and content never
moves between sections.

That is measurable rather than aspirational: across both real maps on the DSH
machine, **12 of 12** placeholder splits keep the non-blank lines identical to
what was there, and the two named splits differ only by the promoted line's
`**`. The whole-file version of the claim is a test:
`a placeholder split only inserts heading lines and keeps the body byte-for-byte`.

### The chunker and its budget

A section is cut into the units the author already separated: a paragraph, or one
top-level bullet with its continuation lines. A unit is never cut, so a bullet
never loses the line that continues it; blank lines separate units and are
re-emitted as they were, so a list stays one list inside a chunk.

**Every chunk pays for its own heading** — the first chunk for the section's `##`
line, each later one for the `###` this tool adds. Budgeting the body alone was
wrong in a way worth naming: a section measured 175 B against a 160 B budget while
its body fitted in 160, so the tool reported "no boundary to cut at" for a section
that simply had two paragraphs. Packing is greedy, then a fix-up loop moves the
last unit of any chunk that still overflows into the next one; a chunk of a single
unit is left alone and reported.

### Naming a chunk, or refusing to

A chunk's first paragraph is promoted to its heading when it opens with `**…**`
of at most 60 characters: the markers go, a trailing full stop goes, and the words
are the author's own. Anything else gets `### <!-- chunk 1/2: name this -->`, and
the reply lists every one under `Placeholders to name`.

The two real maps are written in different styles, and the rule treats them
differently on purpose: this repository's pages are bold-led paragraphs, so some
headings come out named; the reference map's oversized sections are bullet lists
whose bold sits *inside* each bullet, so they get placeholders. Promoting a
bullet's bold would carve that bullet out of its list, which is an edit to
structure the author did not ask for.

### The index is reconciled, not regenerated

Measured against the reference map: regenerating every cell from the pages rewrote
**13 of 13 rows of a healthy index** — short editorial labels replaced by full page
titles, every hand-written trigger replaced by the page's `Status:` line, and the
project's grouping replaced by path order. So a row is matched to a page in four
tiers, strongest first: the link's exact path, then its file name, then the row's
label, then a label that is the first part of a page's title — the last one is what
a map written with short labels (`Tray`) against long titles
(`Tray — the resident process…`) needs to keep its hand-written trigger when a link
breaks. A matched row whose link resolves is emitted byte-identical in its original
position, and the trigger is only supplied for a row that is being added. Result on
a conformant map: `unchanged`, `kept: 13`.

A tier that matches more than one page matches none, and the row is dropped with
the reason printed: guessing between two owners would rewrite a link that was
already right. Every dropped row's whole line goes into the reply, because that is
the one operation here that destroys wording a person wrote.

### Deciding which table is the map's

Qualification is stricter than matching. A table is *the map's* when its header
names a feature or when a row that actually links something matches a page — a
table of names whose first cell merely reads like a page title is somebody else's
and is refused, which is a case a fixture caught.

### Traps

- A page with **no `##` heading at all** is refused for that page: inserting six
  empty sections would leave its body in the preamble, where no section-level
  search returns it. It is reported as needing an author instead.
- A section that **already divides** but whose largest `###` chunk is still over
  the limit needs an author: the plugin has no level below `###`, and inventing one
  is not this tool's job.
- A map with **no pages** has its index refused — a rewrite could only delete rows.
- A rewritten section's trailing blank lines are normalized to one. The body is
  byte-identical; the whitespace at the section's end is not.
- A **refused** index is returned byte-for-byte and reported; the pages are still
  rewritten, because one unreadable table is no reason to leave the pages alone.
- A row that two pages could own is dropped rather than assigned, and the reply
  says which ambiguity it hit.
- A write goes through the scaffold's seam; see [templates.md](templates.md) for
  why the reason is named per file. A file that could not be written is named under
  `Could not be written`, never only counted.
- A second run is a no-op by construction: every transformation is idempotent, and
  a placeholder is already a valid `###` heading.
- A session that regenerated or checked the map has read it, so the guard's one
  ask is already satisfied: both tools mark the session consulted. Otherwise the
  tool that fixes the map would be followed by a denial for the write it made.

## Config keys / UI

| Argument | Default | Meaning |
| --- | --- | --- |
| `root` | plugin location directory | the project whose map to rewrite |
| `apply` | `false` | write the changed files; without it, plan only |
| `show` | `false` | include the rewritten text, capped at `maxBytes` and resumable with `offset` |
| `offset` | `0` | byte offset to resume a capped `show` reply |

The chunk target is the plugin's `maxSectionBytes` (2048), the same knob
`feature_map_check` uses, so "split it" and "it needs splitting" cannot disagree.

## Tests that pin it

`test/plugin.test.mjs`: `an oversized section is split at paragraph and bullet
boundaries and every chunk fits`, `a paragraph-initial bold lead-in becomes the
heading and the bold markers go away`, `a chunk with no paragraph-initial lead-in
gets a visible placeholder heading`, `a placeholder split only inserts heading
lines and keeps the body byte-for-byte`, `a page missing mandated headings gets
them with fill-in comments and nothing else moves`, `a missing Status line is
filled from the index row that links the page`, `an unnameable oversized chunk is
reported and never split mid-sentence`, `regenerating twice changes nothing the
second time`, `the index is reconciled: rows appended, broken links re-pointed,
orphans dropped, matched rows untouched`, `a broken link whose label heads the page
title is re-pointed, and an ambiguous one is dropped`, `a foreign table is refused,
and the pages are rewritten anyway`.

`test/contract.test.mjs`: `regen plans without writing and writes only with apply`,
`regen leaves every file outside the map byte-for-byte alone`, `a table that cannot
be identified is refused, and nothing is written for it`, `a regenerated map then
satisfies the checker`, `the guard stands down once the map is read or regenerated,
and in a project without one`.

## Related

[map-tool.md](map-tool.md) · [adoption.md](adoption.md) ·
[templates.md](templates.md) · [packaging.md](packaging.md)
