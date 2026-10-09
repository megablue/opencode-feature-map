# Packaging — how this plugin reaches OpenCode and stays loadable

Status: shipped (0.1.0) · Read when: changing `package.json`, `src/index.ts`'s
registrations, the commands, the install script, or installing the plugin

## What it does

- Registers with the host as one plugin (`feature-map`): one `context` session
  hook (the standing instruction), five tools, one permission guard and five
  commands — all in one `setup()`.
- Ships exactly one runtime dependency, `@opencode/plugin`, and registers its
  tools with raw JSON Schema rather than importing the host's schema types.
- The five tools are also five commands: `/feature-map`, `/feature-map-check`,
  `/feature-map-init`, `/feature-map-adopt`, `/feature-map-regen`, each running
  the tool behind it and delivering the reply as a session message.
- Installs by copy into a plugins directory (`scripts/install.mjs`), because the
  config-array path specifiers do not resolve on Windows — see below.

## Map

- `src/index.ts` — `setup()`, `toolDef()` (the DSH→OpenCode tool adapter),
  `parseArgs()`, `buildCommands()`, `DEFAULT_CONFIG`, `resolveConfig()`, and the
  `export default Plugin.define({ id: 'feature-map', setup })` entry.
- `package.json` — `exports`, `files`, the `plugin:*` scripts.
- `scripts/install.mjs` — `install()`, `remove()`, `pluginDir()`, `configDir()`.
- `tsconfig.json` — `NodeNext`, `strict: false` (the ported files are pinned by
  the suite rather than by the typechecker), `rootDir: src`, `outDir: dist`.
- `scripts/test.mjs` — every `test/*.test.mjs` in one process.

## How & why

**The host, not the plugin, owns placement.** DSH gave a plugin a service list
and a prompt-section order, and the port carried neither: OpenCode pushes a
`context` hook's system parts onto every model request and runs plugin
registrations in load order, so there is no slot table and no ordering to keep
in step. The whole DSH `apply(ctx, config)` became `async setup(ctx)`; the
five `ctx.tools.register` calls became five `editor.add` calls inside one
`ctx.tool.transform`; the guard became a `ctx.permission.hook('evaluate')`.

**One adapter, five tool bodies.** `toolDef()` is the single place that knows
both shapes — DSH's `parameters` / `output.schema` / structured reply, and
OpenCode's `input` / `output` / `{ content }` result — so the five tool bodies
read exactly as they did on the DSH host and the contract tests pin them
through the adapter. The tool JSON Schema objects are passed untyped on
purpose: importing the host's schema types would put a second package in
lockstep with the plugin for no behavioral gain. One dependency, resolved
through it at runtime.

**A command is a tool call a person can type.** `buildCommands()` reuses the
registered tool objects: it runs the tool with a hand-made context ({ sessionID,
agent, messageID, id, progress, signal }) and injects the reply with
`ctx.session.synthetic({ sessionID, text, description: '/<name>' })` — recorded
in the session, so the next user turn can build on it, and without a model turn
to say it. `parseArgs()` is the shared grammar: `key:value`, bare boolean flags,
`offset:N`, `only:a,b`, `summary:<rest of line>`, leftover words are the topic.
Command names are the tool names with dashes, which is what a person types.

**The command executor answers, it does not throw.** It is the last plugin
frame before the host: a rejection there is a 500 on the command request, and
the 500 crashed the session that asked — observed, not deduced, three sessions
in a row before the guard existed. So the executor catches and delivers
`Could not run /<name>: <reason>`, the same rule the write seam follows. The
missing-template ENOENT that caused it is fixed at the source in
[templates.md](templates.md); this is the net under it.

**Config is a plain object, and the unknown-mode fallback is strict.**
`DEFAULT_CONFIG` + `resolveConfig()` are the DSH design kept verbatim: the host
passes plugin options through unvalidated, so a typo in a patch is normalized
rather than rejected, and an unrecognised `mode` falls back to `enforce` — a
mistake cannot silently disable the rule.

### Why the install is a copy, and not a config entry

OpenCode also loads plugins from the `plugins` array in `opencode.json(c)`, and
the documented forms for a local directory are an absolute path, a
config-relative path and a `file:///` URL. On Windows (verified against
OpenCode 2.0.26) the loader **drops all three without a log line** — the plugin
never appears in `opencode plugin list` and no error is recorded — while the
discovery directory (`~/.config/opencode/plugins/` globally,
`.opencode/plugins/` per project) works. A junction or symlink into the
checkout does not help either: Windows reports a junction to a directory scan
as a symlink, so it is skipped. Hence `scripts/install.mjs`.

### What the discovery loader accepts as a package entry

The same discovery that rescues the install has its own convention, and it is
**not** the manifest's: a plugin package directory is resolved to its root
`index.js`/`index.ts`, and `main`/`exports` are not consulted. Observed twice
in one afternoon — an installed copy whose entry was only `dist/index.js` did
not load at all (dropped silently, like the config-array failures), while the
same package with a root `index.js` loaded. So the installed copy keeps the
shipped layout — `package.json`, `dist/`, `templates/` — and gains a one-line
re-export at the root (`export { default } from './dist/index.js'`): the shim
is the entire bridge between what the loader accepts and what the package is,
and the built files are what actually run. The installer also **wipes the
target before copying**, so a previous install that laid the built files out
differently cannot outlive it — the flattening that started the first crash
was exactly that, a stale root `index.js` beside a fresh `dist/`.

### Traps

- A missing plugin is silent: no `plugin list` row, no log line. When that
  happens, suspect the entry — the config-array specifiers above, or a package
  whose root `index.js` the shim was supposed to provide. A plugin that loads
  but throws is the loud case: the command request 500s, so fix throwing code
  with the same seriousness as a missing entry.
- `scripts/install.mjs` copies the **built** output. An edit without
  `npm run build` installs the previous build; the gate is the chain in
  `AGENTS.md`, and a stale `dist/` is indistinguishable from a code bug at
  runtime.
- The ported files (`src/map.ts`, `src/regen.ts`, `src/templates.ts`) carry
  `@ts-nocheck` by design: they are byte-faithful ports pinned by the suite, and
  typing them would make the port drift from the original. `src/index.ts` — the
  file that knows OpenCode — is fully typechecked. Extending the OpenCode
  surface means extending `src/index.ts`, not adding `any` to the ports. The
  one deviation so far is `packageRoot()` in `templates.ts`, which the crash
  above forced and which the DSH original needs mirrored.
- `opencode service restart` kills the service hosting the invoking session, so
  from inside a session it always looks aborted. The restart still completes;
  verify with the next command rather than the exit code.
- Plugin state is per `setup()`, which the host re-runs on reload: a session's
  consulted/asked flags reset, and the guard asks once more. One extra prompt
  after a reload is the right side of that trade — see
  [enforcement.md](enforcement.md).

## Config keys / UI

| Key | Default | Range | Set by |
| --- | --- | --- | --- |
| `mode` | `enforce` | `enforce`, `prompt`, `off` (unknown → `enforce`) | plugin options |
| `sourceTools` | `['read','grep','glob']` | action names | plugin options |
| `exemptPaths` | `['docs/','AGENTS.md','CLAUDE.md','HANDOFF.md','README.md']` | project-relative prefixes | plugin options |
| `maxBytes` | `12000` | positive integer; non-positive disables the cap | plugin options |
| `sectionsPerTopic` | `3` | positive integer | plugin options |
| `maxSectionBytes` | `2048` | positive integer | plugin options |

Options arrive through the object form of the `plugins` array; see the README.

## Tests that pin it

`test/contract.test.mjs`: `the plugin declares the services it needs and
nothing it does not` (one hook, five tools, one guard, five commands),
`every tool declares a closed schema and a JSON Schema parameter block`,
`a tool reply matches the schema the harness validates it against`,
`the commands inject the tool reply into the session`,
`the command grammar parses the arguments a person types`,
`a command whose tool fails delivers the reason instead of throwing`.

`test/install.test.mjs`: `installs the built package: the manifest, the built
output and the data`, `reinstalls over a previous copy, so upgrading is the
same command`, `wipes the target first, so a stale flattened install cannot
outlive it` (the root entry is the shim, no stale root modules),
`removes its own copy, and says so when there is none`,
`refuses to remove a directory that is not this package`.

The install itself is verified live against this machine's global plugins
directory — `opencode plugin list` shows the row, and `/feature-map-init` and
`/feature-map-adopt` both answer through the server API; see `HANDOFF.md`.

## Related

[enforcement.md](enforcement.md) · [map-tool.md](map-tool.md) ·
[templates.md](templates.md) · [adoption.md](adoption.md) ·
[regen.md](regen.md)
