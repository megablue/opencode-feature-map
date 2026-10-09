# The map tool — read the section you need, not the page it lives in

Status: shipped (0.1.0) · Read when: changing `feature_map`,
`feature_map_check`, `src/map.ts`, the ranking, the tiers or the byte budget

## What it does

- `feature_map` with no arguments returns the index — the table of features and
  the pages it links — plus the list of pages.
- `feature_map` with `topic` returns the **sections** that match, best first:
  the names, the files and the tests, with the prose left out unless the topic
  matched it. Every reply names what it did not return and the call that gets it.
- `feature_map` with `topic` and `skeleton` returns the matching pages' section
  lists and sizes instead of their content.
- `feature_map` with `page` alone returns that page's shape: its sections, their
  sizes, and how to ask for one. With `section` it returns that section, with
  `sub` a `###` inside it, and with `full: true` the whole page.
- A reply that reaches the byte budget says where to resume, and `offset`
  continues it.
- `feature_map_check` reports drift — pages no row links, rows whose link does
  not resolve, pages with no title — and, separately, the sections that have
  outgrown a single read and which of those already divide at `###` level.
  `clean` means the index and the pages agree; size advice never flips it, so a
  caller checking its own edit and a caller auditing the map read the same word
  the same way.
- Each tool also runs as a command (`/feature-map`, `/feature-map-check`), with
  the same reply delivered into the session — see
  [packaging.md](packaging.md) for that half.

## Map

- `src/map.ts` — `splitSections()`, `splitSubsections()`, `findSection()`,
  `findSubsection()`, `selectSections()`, `rankSections()`, `rankPages()`,
  `slugify()`, `headingOf()`, `capText()`, `checkMap()`, `TIER1_SECTIONS`,
  `MAP_DIR`, `MAP_INDEX`.
- `src/index.ts` — `renderMapReply()`, `skeletonText()`, `omittedLines()`,
  `continuationLine()`, `toolDef()`, and the five tool definitions.
- Config: `maxBytes`, `sectionsPerTopic`, `maxSectionBytes`.

## How & why

**The headings were already the retrieval unit; nothing else had to change.**
The doc template fixes the section order for every page, so a page can be cut at
its `##` boundaries with no new syntax, no front matter and no index of its own.
That constraint is what makes this cheap: the map stays markdown a person can
write, and the tool derives the granularity instead of demanding it.

**Four levels, each naming the next.** The index is the entry point (one call,
no arguments). A topic is the common case and returns sections. A page alone is
its shape, which is how a caller decides what to ask for. A section — or the
whole page, or a `###` inside a section — is the explicit ask. Every reply
carries the sentence that reaches the level below it, because a tool that
answers with less than was wanted and does not say how to get the rest has
traded bytes for a second, worse search.

**Ranking is weighted so a name beats a mention, and a cheap section beats an
expensive one.** A topic token in a section's heading scores 4, in the page's
path or title 3, and in the body at most 5 however often it appears. On top of
that, a section named in `TIER1_SECTIONS` (`What it does`, `Map`,
`Tests that pin it`) takes a bonus of 3 — the sections that answer "where is it
and what pins it" without the prose. Equal scores prefer the *smaller* section,
because the whole point is to spend fewer bytes. Measured on the reference map,
a topic reply is 40% smaller in total than the pages it would otherwise have
returned, and 48–57% on the topics whose answer is the payload rather than the
mechanism.

### A summary travels with a guessed section, not with a requested one

When the ranker picks `How & why` for a topic, `What it does` is prepended:
prose about a mechanism is read correctly only next to the sentence that says
what the mechanism is for, and the ranker chose that section on a guess. When
the caller names the section, nothing is prepended — naming a section means the
page is already known, and the preamble above it carries the page title and
status line. That single rule is worth about 900 bytes on a real page.

**The budget continues instead of truncating.** `capText()` takes an `offset`
and returns `nextOffset`, and the offset always advances: a single line larger
than the whole budget is returned whole rather than producing a continuation
that never moves. Without this, the one section in the reference map that is
larger than every page but its own (11,761 B) could only ever be delivered as a
silent truncation.

**A page with no `##` headings degrades to one chunk.** `splitSections()`
returns the whole body as a single section named after the page title, with the
title line removed so a reply never prints it twice. This is not hypothetical:
the first version of this feature made such a page *invisible* to a topic
search, which the contract test caught. A hand-written page is still a page.

**Reading the map is `node:fs`, and the tools run inside the server.** OpenCode
plugins execute in the server process under the installing user's authority, so
there is no client-side filesystem service to call: a `readFile` on the map is
exactly what the host itself does for the `read` tool, and one synchronous
lookup shared by the guard and the tools beats two implementations that can
disagree about where the project root is. The local-filesystem assumption is
unchanged from the DSH original and is still stated rather than hidden.

### Traps

- Index links resolve the way markdown resolves them: relative to the index
  file, not to the project root. `docs/features/README.md` saying
  `(runtime.md)` means `docs/features/runtime.md`. Resolving against the project
  root reports every page as missing from the index, which reads like a broken
  map rather than a broken parser.
- A row whose link leaves `docs/features/` is reported rather than followed: the
  index is the map's table of contents, and following a link out of the map
  turns the check into a link checker for the whole repository.
- `listPages()` excludes the index itself. Counting the index as a page makes
  every map report one unindexed page forever.
- Ranked sections are scored *copies*, so anything matching them back to their
  page must match by path or slug. Object identity lists every section as
  omitted while also returning it — the first version did exactly that with
  pages.
- A `###` split is only as good as the author's headings. `splitSubsections()`
  carries the section's own lead text with every slice, so a subsection never
  arrives without its premise, but it cannot invent structure that is not there
  — which is why `feature_map_check` reports the sections that outgrew a read.
- `checkMap()` never writes. Keeping the map true is the change's job, not the
  checker's; a tool that silently rewrote the index would hide exactly the drift
  it exists to report.

## Config keys / UI

| Key | Default | Range | Set by |
| --- | --- | --- | --- |
| `maxBytes` | `12000` | any positive integer; non-positive disables the cap | plugin options |
| `sectionsPerTopic` | `3` | positive integer | plugin options |
| `maxSectionBytes` | `2048` | positive integer | plugin options |

## Tests that pin it

`test/plugin.test.mjs`: `a page splits on its ## headings, and keeps its
preamble apart`, `a page with no ## headings degrades to one chunk instead of
vanishing`, `a section splits into its ### subsections, each carrying the
section lead`, `a heading beats a mention, and a cheap section beats an equal
prose one`, `a capped reply can be resumed, and the walk always advances`,
`the reference map reports the sections that outgrow a single read`.

`test/contract.test.mjs`: `no arguments returns the index, which is the entry
point`, `a topic returns the cheap sections, not the whole page`, `a page alone
is its shape, and section, sub and full go deeper`, `a topic can be asked for as
shapes, and a capped reply can be resumed`, `the checker reports drift and
sections too big to read on their own`.

## Related

[enforcement.md](enforcement.md) · [templates.md](templates.md) ·
[adoption.md](adoption.md) · [packaging.md](packaging.md)
