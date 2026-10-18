# Session handoff — opencode-feature-map

Next: `docs/features/index.html` — the feature map. Read only the page for your
area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `2026-10-18` — version `0.2.0`, the HTML-format change committed on
`main` as `c3e0b97`.

## State

- **The HTML format is shipped.** A feature map is now
  `docs/features/index.html` plus one HTML page per feature. The agent still
  receives compact text: `listPages()` parses each page with
  `htmlToMapText()`, and every rank, cap and byte count uses that text.
- **The plugin's own map was converted**, with `prune`, by the new
  `feature_map_upgrade`: `docs/features/README.md` and the six `.md` pages are
  gone, replaced by `index.html` and seven `.html` pages, including the new
  `html-format.html`. The index has a `Page format` section and a mermaid
  graph demonstrating the format.
- **The gate is green**: typecheck, build, **84 tests** (up from 69), smoke
  (`7` HTML pages, `0` unindexed, `0` unresolved, regen would change `0`) and
  `measure` (the reference fixture is still Markdown and still reads).
- **Live install refreshed**: `npm run plugin:install` and
  `opencode plugin list` show `feature-map local` from the global plugins
  directory. The registered surface is six tools, six commands, one
  instruction hook and one guard.
- **Legacy maps are still read forever.** `findMapRoot()` prefers
  `index.html`, falls back to `README.md`, and returns `{format, legacy}`.
  Every reply from a legacy map carries a one-line notice naming
  `feature_map_upgrade`; the checker does the same.
- **`feature_map_upgrade`** is additive by default (`plan`, `apply`, `prune`,
  `force`). A fenced block with a language becomes `<pre class="pseudo"
  data-from-lang="…">` and is reported for review; `text` fences become
  `verbatim` with a visible `TODO` reason; `.md` links become `.html`.

## Open threads

- The HTML change is committed as `c3e0b97`; nothing is left in the working
  tree.
- Exercise `/feature-map-upgrade` and `/feature-map` live after the server
  picks up the reinstall; the registrations and the tool bodies are pinned by
  `test/contract.test.mjs`, but the live command path is the last unobserved
  step.
- `reference/PingLatencyOverlay/` is deliberately still Markdown: it is the
  fixture that pins dual-read and the upgrade tests. Do not convert it.

## Known gaps (volatile; the durable traps live in the feature pages)

- The mermaid loader is a CDN import. Offline, a browser shows the graph source
  unstyled; the agent is unaffected because it reads the edge list.
- `npm run measure .` runs its default reference topics against this
  repository, so three of the four report "no match". Point it at
  `reference/PingLatencyOverlay` for the original measurement.
- The HTML reader is a small tokenizer, not a DOM: exotic markup outside the
  vocabulary in `html-format.html` degrades to paragraph text rather than
  failing.
- The regenerator rewrites a changed HTML page through the canonical text. A
  graph inside a section that regen actually splits becomes an edge list; an
  unchanged page keeps its original bytes and its graph.

## Local-only state (not on the remote)

- The global plugins directory holds the live copy
  (`~/.config/opencode/plugins/feature-map/`), refreshed after the 0.2.0
  build. `npm run plugin:uninstall` removes it; the same copy under a project's
  `.opencode/plugins/` is what `--project` creates.
