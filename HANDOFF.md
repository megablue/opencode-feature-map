# Session handoff — opencode-feature-map

Next: `docs/features/index.html` — the feature map. Read only the page for your
area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.html` is the behaviour spec
(`docs/SPEC.md` is its pointer stub).
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `2026-10-24` — version `0.3.0` on `main`, two commits ahead of
`origin/main` and not yet pushed: the shortened command descriptions, then the
daily update check.

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
- **The gate is green**: typecheck, build, **104 tests** (87 at `9f278f4`),
  smoke (`8` HTML pages, `0` unindexed, `0` unresolved, regen would change
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
  instruction hook, one guard and the `tui` entrypoint.
- **Command descriptions are one line.** The palette has no second line, so
  each of the six now says what it does plus the flags a person types: ~400
  characters in total, down from ~1.4k of manual. The full grammar stays in the
  README and the detail in each tool description, which is what the agent
  reads. Pinned by `every command description is one line, because the palette
  has no second line`.
- **The plugin has a TUI half now.** `src/tui.ts` checks the published
  `package.json` once a day and toasts a newer version once; the rules are in
  `src/update.ts`, the `updateCheck` switch in `src/config.ts`
  (`~/.config/opencode/feature-map.json`). The install writes a second root shim,
  `tui.js`, because the loader resolves a directory target to `<dir>/tui`; the
  package also exports `./tui`. The suite is 104 tests, with the check pinned in
  `test/update.test.mjs` over a fake context and a stubbed `fetch`, and the shim
  in `test/install.test.mjs`. The `tui.js` in the global install loads and
  toasts when exercised directly. See `docs/features/update-check.html`.
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
- **The README gained its packaging furniture.** A header image
  (`docs/assets/header.svg`), a badge strip (licence, version, Node 22+, topic,
  PayPal), an `Author` section, a `Buy me a coffee` section with the PayPal
  link, a linked `LICENSE`, and `.github/FUNDING.yml` naming the same PayPal
  address. The version badge is a hand copy of `package.json`'s `version`:
  bump both in the same commit. `README.md` stays canonical and `README.html`
  is re-rendered from it — the header and badges are Markdown images and
  links because the renderer does not pass raw HTML through.
- **`AGENTS.md` is the source of truth.** OpenCode injects the Markdown itself,
  so a pointer stub would leave later sessions with a link rather than the
  rules; the document stays full Markdown and there is no `AGENTS.html`.
  `.html-as-doc.json` skips only `reference/`, so `scan` sees no unconverted
  copy here. `HANDOFF.md` is skipped by the skill because tooling rewrites it.
- **Legacy maps are still read forever.** `findMapRoot()` prefers
  `index.html`, falls back to `README.md`, and returns `{format, legacy}`.
  Every reply from a legacy map carries a one-line notice naming
  `feature_map_upgrade`; the checker does the same.
- **`feature_map_upgrade`** is additive by default (`plan`, `apply`, `prune`,
  `force`). A fenced block with a language becomes `<pre class="pseudo"
  data-from-lang="…">` and is reported for review; `text` fences become
  `verbatim` with a visible `TODO` reason; `.md` links become `.html`.

## Open threads

- **The update check has not been seen in a live TUI.** The `tui.js` in the
  global install toasts when exercised directly, but the running terminal
  predates the install, so restart it to see the real toast. The installed copy
  is already `0.3.0` and the published manifest still says `0.2.0`, so a real
  toast needs a later release: nothing published is newer than the disk.
- Nothing from the plugin is left uncommitted; the `c3e0b97` HTML change, the
  no-map `planUpgrade()` fix and the `html-as-doc` docs pass (SPEC stub,
  `README.html`, `.html-as-doc.json`, this file) are committed and installed.
  `AGENTS.md` was restored to the full process doc and `AGENTS.html` removed:
  the host injects the Markdown, so the pointer stub had hidden the rules from
  later sessions.
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
  green `verify` to mean the page is current. Observed on the old `AGENTS.html` page.

## Local-only state (not on the remote)

- The global plugins directory holds the live copy
  (`~/.config/opencode/plugins/feature-map/`), refreshed after the 0.3.0
  build. `npm run plugin:uninstall` removes it; the same copy under a project's
  `.opencode/plugins/` is what `--project` creates.
