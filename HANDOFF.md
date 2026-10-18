# Session handoff — opencode-feature-map

Next: `docs/features/index.html` — the feature map. Read only the page for your
area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.html` is the behaviour spec
(`docs/SPEC.md` is its pointer stub).
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `2026-10-18` — version `0.2.0` (`c3e0b97`), plus the crash fix found by
verifying the live tool and the `html-as-doc` docs pass (the HTML SPEC,
`README.html`, `AGENTS.html`), both committed on `main`.

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
- **The gate is green**: typecheck, build, **86 tests** (84 at `c3e0b97`),
  smoke (`7` HTML pages, `0` unindexed, `0` unresolved, regen would change
  `0`) and `measure` (the reference fixture is still Markdown and still reads).
- **Live verification found a shipped crash.** Calling the live
  `feature_map_upgrade` on a project with no map returned
  `undefined is not an object (evaluating 'plan.flagged.length')`:
  `planUpgrade()`'s absent branch omitted `flagged`/`verbatim`, which the tool
  reads before it checks `absent`. Fixed by giving the absent plan the full
  shape, pinned by two new tests, and recorded as a trap in
  `html-format.html`.
- **Live install refreshed**: `npm run plugin:install` and
  `opencode plugin list` show `feature-map local` from the global plugins
  directory. The registered surface is six tools, six commands, one
  instruction hook and one guard.
- **The behaviour spec is HTML now.** `docs/SPEC.html` is the source of truth
  and `docs/SPEC.md` is an `html-as-doc` pointer stub (marker comment plus a
  link), kept so the many tools and instructions that look for `SPEC.md` still
  resolve. Edit the HTML. `README.html` is a rendering of `README.md`, which
  stays canonical; re-render it instead of hand-editing, with
  `node ~/.config/opencode/skills/html-as-doc/scripts/html-docs.mjs convert . --only README.md`
  then `... verify .`. `.html-as-doc.json` lists `reference/` as `skip` so a
  `scan` there stays quiet: the fixture must keep its Markdown for the
  dual-read and `feature_map_upgrade` tests. `README.html` still links
  `docs/SPEC.md` and that hop is deliberate: the stub says where the spec went,
  and `README.md` has to keep the `.md` link for GitHub and the tools that look
  for that name. The shipped `templates/docs/SPEC.md.tmpl` stays
  Markdown on purpose: the skill is optional for a scaffolded project, so the
  plugin must not require HTML for a SPEC.
- **`AGENTS.html` is the source of truth**, and `AGENTS.md` is an
  `html-as-doc` pointer stub. Edit the HTML. The stub is deliberate even though
  OpenCode injects `AGENTS.md` as instruction text: later sessions see the link
  rather than the rules, and `feature_map_adopt` reports the six template blocks
  missing against the stub. `.html-as-doc.json` skips only `reference/`, so
  `scan` sees no unconverted copy here. `HANDOFF.md` is skipped by the skill
  because tooling rewrites it.
- **Legacy maps are still read forever.** `findMapRoot()` prefers
  `index.html`, falls back to `README.md`, and returns `{format, legacy}`.
  Every reply from a legacy map carries a one-line notice naming
  `feature_map_upgrade`; the checker does the same.
- **`feature_map_upgrade`** is additive by default (`plan`, `apply`, `prune`,
  `force`). A fenced block with a language becomes `<pre class="pseudo"
  data-from-lang="…">` and is reported for review; `text` fences become
  `verbatim` with a visible `TODO` reason; `.md` links become `.html`.

## Open threads

- Nothing from the plugin is left uncommitted; the `c3e0b97` HTML change, the
  no-map `planUpgrade()` fix and the `html-as-doc` docs pass (SPEC stub,
  `README.html`, `AGENTS.html`, `.html-as-doc.json`, this file) are committed
  and installed. The human reviewed the pass and chose to keep the
  `AGENTS.md` pointer stub over a canonical Markdown copy, accepting that
  later sessions are injected with the link rather than the rules.
- **Live paths are all observed**: after reloading the reinstalled plugin, a
  human ran `/feature-map` and `/feature-map-upgrade` against a real session.
  The no-map reply reads "no map to convert" instead of throwing; the tool
  bodies and the slash dispatch are now both confirmed.
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
- `html-as-doc verify` checks the doctype, title, `main`, headings and code
  blocks — not paragraphs. A page whose prose was edited by hand still passes
  its checks, so re-render after every Markdown edit rather than trusting a
  green `verify` to mean the page is current. Observed on `AGENTS.html`.

## Local-only state (not on the remote)

- The global plugins directory holds the live copy
  (`~/.config/opencode/plugins/feature-map/`), refreshed after the 0.2.0
  build. `npm run plugin:uninstall` removes it; the same copy under a project's
  `.opencode/plugins/` is what `--project` creates.
