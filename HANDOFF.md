# Session handoff — opencode-feature-map

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `0ced0e0` — `2026-10-09`.

## State

As of the stamp above, `main` is clean at `0ced0e0` with no remote configured;
`git log --oneline` and `git status` are the checks, since this file lags by its
own commit. The scaffold is two commits: `0cd5320` adds the docs, `0ced0e0`
points this file at it. No source tree exists yet — `git ls-files` is the check
— the only files are the documentation scaffold written by `feature_map_init`
plus `.gitignore` and `.gitattributes`. The latter pins LF; `core.autocrlf` is
`true` system-wide on this machine, so do not drop it.

## Open threads

Nothing in flight: the project has not been started. The next concrete step
is the first source tree, after which `AGENTS.md`'s Layout and Commands
sections and the first feature page need real content.

## Known gaps (volatile; the durable traps live in the feature pages)

Nothing has been verified by eye, because nothing runs yet. Two things a next
session should not treat as settled:

- The one-line project description in `AGENTS.md` is inferred from the
  repository name and the sibling checkouts, not confirmed by the user.
- There is no source, no `package.json` and no test run, so whether the plugin
  does what it says has no answer yet.

## Local-only state (not on the remote)

Nothing: the repository has no remote, so the whole history is local.
(`git remote -v` is the check.)
