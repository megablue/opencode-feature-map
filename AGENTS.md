# AGENTS.md

**Before you grep, glob or open a source file: read `HANDOFF.md`, then
`docs/features/README.md`, then only the feature page(s) for the area you are
about to change. The feature pages name the files, functions and tests you
would otherwise hunt for — the code comes after them, not before.**

opencode-feature-map is the OpenCode counterpart of the DSH feature-map tool family (`feature_map`, `feature_map_init`, `feature_map_check`): it keeps a project's feature map in `docs/features/` — one page per feature naming the files, types, functions and pinning tests for that area — so an agent reads the page before the code.

Three kinds of document, and keeping them apart is the point:

- **`docs/SPEC.md` is product behavior** — what the product does and what a
  user sees, readable without knowing the code. Behavior belongs there even
  when the code is where the reason for it lives.
- **`docs/features/` is the feature map** — one page per feature with its
  files, mechanisms, traps and pinning tests. Read the page for the area you
  are about to change; keep it true in the same commit.
- **This file is process and hard rules** — the commands, the workflow and
  the constraints that apply across every feature.

Where a rule has a behavior half and a mechanism half, the behavior half is a
pointer to `docs/SPEC.md` and the mechanism half to its feature page rather
than a second copy: two copies of a default value is one more thing that can
be wrong.

## Read first
`HANDOFF.md` holds the current state; if it is missing, carry on with the
feature map and the code. Then `docs/features/README.md` — the feature map —
and only the feature doc(s) for what you are about to change.
`docs/SPEC.md` is user-visible behavior; this file is process and hard rules;
the feature docs are the map, the mechanism and the traps.

## Layout

One bullet per top-level directory: what it owns, and why it is separate from
its neighbour.

- **`src/`** — the plugin, in four files. `index.ts` is the only OpenCode-aware
  file: the host adapters (`toolDef`, `buildCommands`, `parseArgs`), the guard
  and the `Plugin.define` entry. `map.ts`, `regen.ts` and `templates.ts` are
  byte-faithful ports of the DSH implementation (`@ts-nocheck`, pinned by the
  suite rather than the typechecker) — the map reading/ranking/checking, the
  regeneration, and the scaffold templates. They stay separate so the OpenCode
  surface can change without the ported logic drifting from its original.
- **`dist/`** — the built output (`tsc`). What `scripts/install.mjs` copies;
  never edit by hand, and always rebuilt as part of the gate.
- **`templates/`** — the four `.tmpl` boilerplate files a scaffolded project
  receives. The suffix is load-bearing (it must never be read as an
  instruction file); see `docs/features/templates.md`.
- **`test/`** — `plugin.test.mjs` (the map/template layer on `dist/`),
  `contract.test.mjs` (the host surface: registrations, tools, guard, commands),
  `install.test.mjs` (the install/uninstall surface). The tests import the
  built `dist/`, so the build is part of the test gate.
- **`scripts/`** — `test.mjs` (runs every `*.test.mjs` in one process),
  `smoke.mjs` (a plan-only pass over this repository), `measure.mjs` (the
  ranking savings on the reference fixture), `install.mjs` (install/uninstall
  into a plugins directory).
- **`reference/PingLatencyOverlay/`** — a real conformant feature map from
  another project, used as the fixture the checker, the regenerator and the
  measure script are pinned against. Not this plugin's documentation.
- **`.github/workflows/ci.yml`** — the same gate as the local chain, on Node 22.

## Commands

Run from the repository root. The gate before a commit is the whole chain, not
the test run alone:

```powershell
npm run typecheck   # tsc --noEmit        — src/index.ts must be clean
npm run build       # tsc                 — emits dist/, which the tests import
npm test            # scripts/test.mjs    — every test/*.test.mjs, one process
npm run smoke       # scripts/smoke.mjs . — a plan-only pass over this repo
npm run measure     # scripts/measure.mjs . — ranking savings on the fixture
```

Install for live use (global or per-project), after the build:

```powershell
npm run plugin:install            # ~/.config/opencode/plugins/feature-map
npm run plugin:install:project    # .opencode/plugins/feature-map in this project
npm run plugin:uninstall
```

The gate is red if any step fails; `npm test` alone does not cover the build
the tests import, and neither covers a live-registration check — after a change
to the registrations or the install script, `opencode plugin list` (with the
copy refreshed by `plugin:install`) is the confirmation that it loads.

## Workflow
- **The features map is part of the change, not the cleanup.** Before staging a
  commit, update the feature doc(s) for whatever you changed
  (`docs/features/`), and add an index row if the doc is new. User-visible
  behavior also updates `docs/SPEC.md` in the same commit. A docs-only
  follow-up commit is the one that gets skipped. Pure refactors with no
  behavior, mechanism, config or test change need no doc edit — do not churn
  the map.
- **Read the map before the code, and keep the map worth reading.** A feature
  page is an anti-hunting payload: the file, type, function and test names for
  one area, and the traps that cost someone an afternoon. Opening the source
  first and writing the page afterwards spends the tokens twice. If a page is
  wrong, fix it in the same commit rather than working around it — a map
  nobody trusts is worse than no map.
- **Search the map in the same breath as the code.** A grep for a feature, a
  symbol or a behaviour runs over `docs/features/` too: the feature pages name
  the identifiers and the tests, so the page you need is usually one hop from
  the hit.
- **`HANDOFF.md` is refreshed at the end of a session, not per commit.** It
  carries what only the passing session knows — open threads, next steps, the
  last thing delivered — under an `As of` stamp. It is allowed to lag the tip:
  its header says the code wins. Refresh it before you hand the work over.
- **Measure, don't deduce it.** Reading the code and doing the arithmetic in
  your head is how geometry, layout and formatting bugs ship. Print the real
  numbers from the real thing — a headless run, a scratch script, the actual
  command — and assert both the good and the broken case, so each test carries
  its own failure mode.
- **Gate on the whole check set, not just the tests.** The linter catches the
  classes of defect the test run compiles straight past. Run the formatting,
  the lint with warnings denied, the tests and the build before you call
  something done.
- **Commit messages go through a file.** Write the message to a scratch file
  (this machine uses `%LOCALAPPDATA%\Temp\opencode\<project>-commit-msg.txt`)
  and run `git commit -F <path>`; a PowerShell here-string gets its terminator
  mangled by the shell tool.
- **No AI attribution in a commit message, ever, without being asked.** No
  `Co-Authored-By` trailer, no `Generated with` footer, nothing that reads as
  crediting a model or tool. These commits are the user's. This is enforced,
  not merely preferred: a machine-wide `commit-msg` hook
  (`core.hooksPath` = `C:/Users/mega/.githooks`) rejects the commit outright,
  and it blocks human co-authors too, so the only ways past it are `--no-verify`
  or `ALLOW_COAUTHOR=1`. **Use neither without the user asking in that
  conversation.** If the hook blocks something, report it and stop; do not
  reword the message to slip a trailer past the pattern.
- **Package after committing.** If the version is derived from the commit
  (a count since a base tag, a stamped build number), packaging first yields
  the previous commit's number. Raise the minor and the base together, in the
  same commit, and keep every reader of that number reading it from one place.
- **Do not commit before the user has looked at it.** Hand a visual change over
  as a build and wait for confirmation.

## Where the working knowledge lives

The per-feature working knowledge lives in `docs/features/`; its `README.md` is
the index. This file keeps the process rules and the hard rules that apply
across features; the feature pages keep the maps, mechanisms and traps.

## Hard rules
No project-specific invariant is pinned yet. Add one bullet per constraint
that must not decay — the rule, the reason it exists, and the test or check
that pins it.

- The README is for users. Implementation detail belongs in `docs/SPEC.md` for
  behavior and here for working knowledge, and the user must be consulted
  before technical detail is added to the README.
