# Session handoff — opencode-feature-map

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `0cd5320` — `2026-10-09`.

## State

Initial commit `0cd5320` on `main`, working tree clean, no remote configured.
There is no source tree yet: the only files are the documentation scaffold
written by `feature_map_init` — this file, `AGENTS.md`, `docs/SPEC.md` and
`docs/features/README.md`. `.gitattributes` pins LF, and `core.autocrlf` is
`true` system-wide on this machine, so do not drop it.

## Open threads

Nothing in flight: the project has not been started. The next concrete step
is the first source tree, after which `AGENTS.md`'s Layout and Commands
sections and the first feature page need real content.

## Known gaps (volatile; the durable traps live in the feature pages)

<!-- What has never been verified by eye, what is exercised by scripted repros
only, and the environment quirks that change how a request for evidence should
be phrased. -->

## Local-only state (not on the remote)

Nothing: the repository has no remote, so the whole history is local.
(`git remote -v` is the check.)
