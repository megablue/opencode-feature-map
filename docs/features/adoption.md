# Adoption — bringing an existing project to the workflow

Status: shipped (0.1.0) · Read when: changing `feature_map_adopt`,
`checkMap`'s findings, `generateIndexRows()`, `divisibility()`, the docs
candidates, or anything that writes into a project that already exists

## What it does

- Reports what an existing project is missing: pages without the six mandated
  headings, pages with no `Status: … Read when:` trigger, index rows that do
  not resolve, pages no row links, sections too big to read in one piece, `AGENTS.md`
  blocks that are absent, and documents under `docs/` that are not in the map.
- Says which oversized sections are *already* retrievable at `###` level, so it
  never asks for work that has been done.
- Returns a plan whose items are labelled `deterministic` (derived from what is
  already in the files) or `judgment` (a trigger, a heading's content, a split
  point — the author's).
- `apply: true` writes **only files that do not exist**. It has no `force` and
  cannot overwrite; its `[deterministic]` plan item for an existing index names
  [feature_map_regen](regen.md) as the tool that can carry it out.
- A project with no docs and no `AGENTS.md` is redirected to
  `feature_map_init` rather than reported on.

## Map

- `src/index.ts` — the `feature_map_adopt` tool, `withGeneratedIndex()`.
- `src/map.ts` — `checkMap()` (the one conformance computation),
  `generateIndexRows()`, `renderIndexRow()`, `renderIndexTable()`,
  `TRIGGER_PLACEHOLDER`, `divisibility()`, `parseStatusLine()`,
  `docsCandidates()`, `walkMarkdown()`, `PAGE_HEADINGS`.
- `src/regen.ts` — `rewriteIndexTable()`, which is what actually writes the
  generated rows into an index that already exists.
- `src/templates.ts` — `missingBlocks()`, `readTemplate()`.
- Arguments: `root`, `focus`, `apply`.
- Config that shapes it: `maxSectionBytes`.

## How & why

**Three tiers, and only two of them are this page.** Measured across the 13
projects on the DSH machine this port was made from: 11 have no `docs/` at all
(nothing to adopt — `feature_map_init`), one has an `AGENTS.md` and no docs (the
map and the missing instruction blocks), and two have conformant maps that have
outgrown the size rule. A migration feature that ignored the first tier would
spend a report telling a code-only project about its missing prose.

**One computation, two renderers.** `checkMap()` answers "is this page
conformant and is this index true" once; `feature_map_check` renders the drift
subset and `feature_map_adopt` renders the migration plan. Two implementations
of "is this page conformant" would be two answers that can disagree, and the
premise of the whole plugin is that the map is the cheap, true answer.

**Drift and size are separate verdicts.** `clean` means the index and the pages
agree — what a caller wants after editing the map. Size advice is appended under
`On size:` and does not flip `clean`. Folding them together made a perfectly
consistent map report `clean: false`, which the acceptance run caught: the
reference map was called "drifted" while its index was perfect and only its
prose was long.

**Deterministic means derived, and nothing else.** An index row's trigger comes
from the page's own `Status:` line; a row for a page without one carries an
empty trigger and a flag. The link is relative to the index, the way markdown
resolves it. A duplicate title is flagged rather than picked between. What
cannot be derived is not guessed — a plausible-sounding trigger this tool
invented would be a wrong answer that reads like a right one, and the trigger is
the phrase a later session searches for.

### `apply` writes only what is absent

The scaffold's four files, with the
generated table spliced into the index template's placeholder row — string
surgery on this plugin's own template, never on a document the project wrote. A
project's `AGENTS.md` is reported block by block and never edited: a project
that has rewritten its `Workflow` block keeps its version, and gets told which
of the template's blocks it lacks. The condition for the redirect to
`feature_map_init` is "no map, no docs **and** no `AGENTS.md`" — a project with
an instruction file has something to adopt even when its map does not exist yet,
which is exactly the case the first version got wrong.

**The one thing this tool cannot do is the reason the next one exists.** An
index that already exists is reported on and never written, so the plan item
that says "write the generated index rows into the map index" is unexecutable
here by construction. Rather than growing a `force` that would put a second
writer on the map, that item points at `feature_map_regen`, whose
`rewriteIndexTable()` does exactly this and nothing else to the file.

### Acceptance, run against the real projects

| Project | Report |
| --- | --- |
| `reference/PingLatencyOverlay` | 13 pages, 0 drift, 11 oversized (10 need splitting, 1 already divides), 2 documents outside the map, `check` clean |
| `quickstart-chat` | `AGENTS.md` present with 5 of 6 template blocks missing; no pages, so the index points at `feature_map_init` |
| `test-server` | no docs and no `AGENTS.md` — redirected to `feature_map_init` |

### Traps

- `chunks` counts `###` subsections, not the section's own lead text. Counting
  the lead made an 11 KB section with six subsections read as seven chunks; the
  number a caller acts on is "how many pieces can I ask for".
- A page with no `##` headings is one chunk, and `divisibility()` says so — the
  degrade-to-one-chunk rule in [map-tool.md](map-tool.md) is what keeps such a
  page out of the "needs splitting" list with a misleading `chunks: 0`.
- `docsCandidates()` walks all of `docs/`, so it is opt-in (`candidates: true`)
  and off the routine check path.
- Candidates are never moved or converted. `docs/SPEC.md` is not a feature page,
  and deciding that `docs/GAME.md` should become one is a judgement about the
  project rather than a fact about its files.
- The plan is capped: the page detail shows ten findings and names the rest, and
  `AGENTS.md` block text is inlined only when it is small or asked for with
  `focus: "agents"` — a migration report that costs more than the migration is
  its own failure mode.
- A failed `apply` names the file that blocked it (a blocker *file* where a
  directory is needed fails with `ENOTDIR`) instead of reporting a count —
  `test/contract.test.mjs` pins that case.

## Config keys / UI

| Argument | Default | Range | Meaning |
| --- | --- | --- | --- |
| `root` | plugin location directory | absolute path | the project to report on |
| `focus` | `all` | `all`, `index`, `pages`, `sizes`, `agents`, `candidates` | which detail to return |
| `apply` | `false` | boolean | write files that do not exist; never an existing one |

## Tests that pin it

`test/plugin.test.mjs`: `the reference map is conformant, which is what an
adopted project should reach`, `a section past the limit is judged by how it
divides, not by its size`, `a non-conformant page is reported by what it lacks`,
`generated rows carry the trigger the page already states`.

`test/contract.test.mjs`: `adoption writes what is missing and never edits what
exists` (byte comparison on a project's own `AGENTS.md`), `a project with
nothing is sent to the scaffold instead`, `documents outside the map are
reported and never converted`, `the checker separates drift from size advice`,
`the drift report asks only for the splits that are really missing`.

## Related

[regen.md](regen.md) · [map-tool.md](map-tool.md) · [templates.md](templates.md) ·
[packaging.md](packaging.md)
