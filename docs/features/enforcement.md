# The guard — deny the first source lookup of a session, once

Status: shipped (0.1.0) · Read when: changing the guard, `sourceTools`,
`exemptPaths`, `mode`, or anything that runs before a tool call

## What it does

- Denies the first source lookup of a session (`read`, `grep`, `glob` by
  default) in a project that has a feature map, with a reason that names the
  remedy: call `feature_map`, then call the tool again.
- Never denies twice. The denial sets `asked`, and `asked` is checked before
  every other condition, so the retry always proceeds.
- Never fires in a project with no map: the absence sets `waived` for the
  session, so the plugin costs a mapless project exactly zero tool calls.
- Registers no hook at all in `mode: 'off'`, and registers the instruction but
  no guard in `mode: 'prompt'`.
- Treats a call outside the project, under `docs/`, or at an instruction file
  as not a source lookup — those are how a session talks to a project.

## Map

- `src/index.ts` — `guardLookup()`, `denialText()`, `sessionState()`, the
  `settings.mode === 'enforce'` block in `setup()`.
- `src/map.ts` — `findMapRoot()`, the synchronous lookup the guard depends on.
- `src/index.ts` — `DEFAULT_EXEMPT`.

## How & why

A permission hook runs after the configured rules, sees the action and its
resources, and can turn an `allow` or `ask` into a `deny` that carries its
reason. It never sees an action that is not one of `read`, `glob` or `grep`, and
a configured `deny` is final before the hook runs — the correct precedence: an
explicit deny is stricter than this rule, not looser. Within that, the rule is
deny-only and monotonic: the hook can refuse, never permit.

So the guard needs a synchronous answer to two questions: *is there a map?* and
*is this path inside the project?* Both are answered by `node:fs` rather than by
an await: `findMapRoot()` walks upward from the plugin location's directory with
`statSync(path, { throwIfNoEntry: false })`, and `guardLookup()` uses
`existsSync` for the "does this file exist" question. The alternative is caching
an async answer computed somewhere else, and a stale cache that says "no map"
silently disables the guard for a whole session.

**Which directory is "the project" is per-location, not per-plugin.** The host
instantiates a plugin for each location that loads it, so `ctx.location.directory`
is the session's own project root, not a single global folder — a global install
still maps each session to the session's project. The state, however, is a plain
`Map` keyed by session id, created per `setup()`: it has to outlive one model
request but not the server.

The denial message is the instruction that clears the denial. A permission
denial surfaces to the agent as the refusal text, so the text carries the whole
remedy: the tool to call, the optional argument that makes it specific, and the
fact that this is the only time the session will ask. A denial that leaves the
agent guessing costs more than the search it prevented.

### Traps

- A denied call is not a thrown error: the agent sees a refusal and retries.
  Anything that makes the retry fail too is a deadlock, which is why `asked` is
  set *before* the message is attached and checked *first*.
- `settings.sourceTools` is matched against the live action name. A profile
  that renames or restricts the fs tools away leaves the guard inert rather
  than broken — it never invents a tool.
- **The action decides what its resource is, and they do not agree.** `read`
  carries a path, `glob` carries a pattern whose head is a path, and `grep`
  carries the regular expression with no location at all. A grep is therefore
  always a source lookup — it is the whole-project hunt the map exists to
  avoid — while `read` and `glob` are judged by where they point. The
  alternative is a guard that cannot see where a grep searches.
- `mode: 'prompt'` exists because a session doing an unusual job (a large
  mechanical refactor) is better served by the instruction than by the denial.
  The two modes are the same plugin and the same tools.
- **A plugin reload forgets which sessions have consulted the map.** The state
  is a `Map` created per `setup()`, so an install, a restart or a config reload
  starts every session over and the guard asks once more. The cost is one extra
  prompt after a reload, which is the right side of the trade — the alternative
  is state that outlives the code that wrote it.

## Config keys / UI

| Key | Default | Range | Set by |
| --- | --- | --- | --- |
| `mode` | `enforce` | `enforce`, `prompt`, `off` | plugin options |
| `sourceTools` | `['read','grep','glob']` | action names | plugin options |
| `exemptPaths` | `['docs/','AGENTS.md','CLAUDE.md','HANDOFF.md','README.md']` | project-relative prefixes | plugin options |

## Tests that pin it

`test/contract.test.mjs` drives the guard directly against a mock context and a
scratch project: `the guard denies the first source lookup once, and always
yields`, `the guard stands down once the map is read, and in a project without
one`, `mode prompt keeps the instruction and drops the guard`,
`a guard never fires for a call it cannot attribute to a session`,
`a grep with no path is always a source lookup`, and the exemption cases.

`test/plugin.test.mjs` covers the map layer the guard stands on:
`the reference project is found from a nested directory and not from outside
it` and `a healthy map agrees with itself`.

The denial was also observed end to end in a live session against this
repository: a `read` of `src/index.ts` was denied with the message below, a
`feature_map` call with a topic returned the sections for the area, and the
next `read` proceeded. That is the loop this page describes, and it is the
acceptance test for any change here.

```
read "src/index.ts" reads source in a project that keeps a feature map.
Call feature_map first — add `topic` if you know the area, otherwise it
returns the index — and read the sections for that area: they name the files,
functions and tests, which is cheaper than searching for them. This is the
only time this session will ask; call read again and it will proceed.
```

## Related

[map-tool.md](map-tool.md) · [templates.md](templates.md) ·
[packaging.md](packaging.md)
