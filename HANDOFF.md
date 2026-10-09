# Session handoff — opencode-feature-map

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `2026-10-09` — `main` at `62b1308` with an **uncommitted working tree**
(the template-path crash fix).

## State

- `62b1308` is the port: the plugin, the installer, the tests, the docs — all
  committed and green (64 tests at that commit).
- **A live crash was then found and fixed in the working tree.** Every
  `/feature-map-init` (and `/feature-map-adopt`) call 500'd with
  `ENOENT … plugins\templates\AGENTS.md.tmpl` and crashed the session. Three
  causes, all in the install/resolution chain, all fixed and pinned:
  1. the discovery loader resolves a plugin package to its **root
     `index.js`**, not `main`/`exports` — the first install's flattened root
     entry was what loaded;
  2. `src/templates.ts` resolved the templates directory with a fixed
     `../templates/` hop, which from a root module points above the package —
     replaced by `packageRoot()` (walk up to the nearest `package.json`);
  3. the command executor threw on a failing tool, and a throw there is a 500
     that takes the session down — it now answers with
     `Could not run /<name>: <reason>`.
  `scripts/install.mjs` now installs the package layout (`package.json`,
  `dist/`, `templates/`) plus a one-line re-export entry, and wipes the target
  first so a stale layout cannot outlive it. `git status` and `git log` are
  the checks; nothing is committed yet.
- The gate is green as of the stamp: typecheck, build, **68 tests** (+4: the
  flattened-layout resolution, the install wipe/shim, the command soft-fail),
  smoke and measure unchanged.
- **Live re-verified after the reinstall**: `opencode plugin list` shows
  `feature-map local` with the shim entry; `/feature-map-init` returned the
  four-document plan (all four templates read) and `/feature-map-adopt
  focus:agents` returned the adoption report — the exact calls that 500'd.
- The machine's global install is `~/.config/opencode/plugins/feature-map/`,
  in the package layout plus `index.js` shim, made by `npm run
  plugin:install`. `~/.config/opencode/opencode.json` still holds only the
  `@tarquinen/opencode-dcp@latest` entry.

## Open threads

- Nothing in flight beyond the commit itself: the fix is complete, green and
  live-verified, waiting for the user's look before anything is staged.
- The DSH original (`../workflow`) still has the fixed-hop
  `TEMPLATE_DIR` and the unguarded command executor. The port fixed both on
  this side; mirroring them back is a change to that repository, not this one.
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
- `/feature-map-check`, `/feature-map-init` and `/feature-map-adopt` are the
  commands exercised end to end; the other two share `buildCommands()` and the
  same synthetic delivery, and are pinned by tests.

## Local-only state (not on the remote)

- The global plugins directory holds the live copy
  (`~/.config/opencode/plugins/feature-map/`). That is the documented install
  route, so leaving it installed is the working state;
  `npm run plugin:uninstall` removes it, and the same copy under a project's
  `.opencode/plugins/` is what `--project` creates.
