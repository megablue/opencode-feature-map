# Session handoff — opencode-feature-map

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `2026-10-09` — `main` at `0ced0e0` with an **uncommitted working tree**.

## State

- The port from `../workflow` (dsh-feature-map) is complete: `src/` (four files,
  `index.ts` typechecked, the three ports `@ts-nocheck` by design),
  `templates/`, `scripts/` (+ the new `install.mjs`), `test/` (three files),
  `.github/workflows/ci.yml`, `README.md`, `docs/SPEC.md`, six feature pages.
  `git status` and `git log --oneline` are the checks — nothing has been
  committed because the user has not looked yet.
- The gate is green as of the stamp: `npm run typecheck`, `npm run build`,
  `npm test` (**64 tests**, 59 from the port plus 5 for the install script),
  `npm run smoke` and `npm run measure` (25% smaller on this repository's map;
  42% on the reference fixture) all pass.
- The plugin is installed and **verified live** on this machine:
  `opencode plugin list` shows `feature-map local`; the guard denied a real
  `read` of `src/index.ts` with the remedy text, and the retry proceeded after
  `feature_map` was consulted; `/feature-map-check` ran through the server API
  and delivered its report as a synthetic session message.
- The machine's global install is `~/.config/opencode/plugins/feature-map/`,
  made by `npm run plugin:install`. `~/.config/opencode/opencode.json` is back
  to only the `@tarquinen/opencode-dcp@latest` entry — every attempt to load
  this plugin from the `plugins` array (`file:///C:/…`, the absolute path, the
  `../../`-relative path) was **silently dropped** by OpenCode 2.0.26 on
  Windows; see `docs/features/packaging.md`.

## Open threads

- Nothing in flight beyond the commit itself: the tree is complete and green,
  waiting for the user's look before anything is staged.
- The repo's own `AGENTS.md` Layout and Commands sections were filled by hand
  from the same facts as `templates/AGENTS.md.tmpl`'s placeholders. The
  template still carries its fill-in comments — `templates.md` says a change to
  one is a change to the other in the same commit, so decide whether the
  template should be brought up to the filled text or stay deliberately
  generic.

## Known gaps (volatile; the durable traps live in the feature pages)

- The guard's live denial was observed for a `read` action; the `grep` and
  `glob` paths are pinned by `test/contract.test.mjs` but were not triggered
  live (a grep denial also clears the session's one ask, so re-verifying needs
  a fresh session).
- `/feature-map-check` is the only command exercised end to end; the other four
  share `buildCommands()` and the same synthetic delivery, and are pinned by
  tests.

## Local-only state (not on the remote)

- The global plugins directory holds the live copy
  (`~/.config/opencode/plugins/feature-map/`). That is the documented install
  route, so leaving it installed is the working state;
  `npm run plugin:uninstall` removes it, and the same copy under a project's
  `.opencode/plugins/` is what `--project` creates.
