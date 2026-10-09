# The boilerplate — the documents this plugin hands to a new project

Status: shipped (0.1.0) · Read when: editing `templates/`,
`src/templates.ts`, `feature_map_init`, or the placeholder set

## What it does

- Ships four documents: `AGENTS.md` (process and hard rules), `HANDOFF.md`
  (volatile session state), `docs/SPEC.md` (user-visible behavior) and
  `docs/features/README.md` (the map index and the page template).
- `feature_map_init` renders them with the project's name and summary and, by
  default, returns their content for the caller to write with its own tools.
- `feature_map_init` with `write: true` writes them to the filesystem.
- Refuses to replace a file that exists unless `force: true`, and reports what
  it left alone.

## Map

- `templates/AGENTS.md.tmpl`, `templates/HANDOFF.md.tmpl`,
  `templates/docs/SPEC.md.tmpl`, `templates/docs/features/README.md.tmpl`.
- `src/templates.ts` — `TEMPLATES`, `TEMPLATE_DIR`, `packageRoot()`,
  `substitute()`, `templateVariables()`, `targetPath()`, `planScaffold()`,
  `applyScaffold()`, `SUMMARY_PLACEHOLDER`.
- `src/index.ts` — the `feature_map_init` tool, and `writeThrough()`, the seam
  every writing tool shares.

## How & why

**The `.tmpl` suffix is load-bearing in the host that reads instructions.**
OpenCode loads `AGENTS.md` from the project root down to the working directory,
and the same is true of other harnesses — so a file named
`templates/AGENTS.md` in this repository would be injected as live instructions
into every session working here — with `{{PROJECT_NAME}}` unsubstituted and the
guidance comments still in it. The suffix is the entire mechanism that keeps the
boilerplate data rather than instructions, which is why
`the shipped boilerplate keeps its .tmpl suffix and never claims an instruction
name` is a test rather than a convention. (This was not hypothetical on the DSH
host: the first draft of `templates/AGENTS.md` was loaded as instructions within
seconds of being written.)

An unresolved placeholder stays visible. `substitute()` reports the names it
had no value for and leaves the token in place, because a silently blanked
`{{PROJECT_NAME}}` produces a document that looks finished and says nothing —
and the report is what lets `feature_map_init` tell the caller which tokens to
fill in.

The plan is the default and the write is opt-in. `planScaffold()` renders every
file, checks what exists, and returns the content; the caller can then write it
with the tools it already has, or ask for `write: true`.

### The templates directory is resolved from the package root

`TEMPLATE_DIR` is `join(packageRoot(), 'templates')`, where `packageRoot()`
walks up from this module to the nearest `package.json` — not the DSH
original's fixed `../templates/` hop. An installed copy is not guaranteed to
keep the built layout: OpenCode's loader was observed resolving a plugin
entry to a flattened root `index.js`, and a module at the package root then
resolved `../templates/` one directory *above* the package. Every
`feature_map_init` and `feature_map_adopt` call died on an ENOENT for
`AGENTS.md.tmpl` — three sessions, each a 500 on the command request. The
package root is the one location a `dist/` module, a root module and a `src/`
module share, so one rule covers all three, and both layouts are pinned by a
test rather than by an argument.

### The write seam has no sandbox policy to carry — and keeps the rule it taught

`writeThrough()` in `src/index.ts` is the one place every writing tool goes
through: `feature_map_init`'s `write`, `feature_map_adopt`'s `apply` and
`feature_map_regen`'s `apply` all hand it their content. On the DSH host it
resolved paths with `ctx.fs.resolve()` and wrote with `ctx.fs.writeText()`,
carrying the session's sandbox policy per call — because a write is exactly the
operation a sandbox policy exists to decide. An OpenCode plugin runs inside the
server under the installing user's authority, so the seam is now a plain
`mkdir` + `writeFile` on `node:fs/promises`: there is no policy service and no
sandbox to route around.

What survives from the DSH seam is the rule it taught, and it is the reason
`writeThrough()` still exists as one seam: **a write is opt-in, per call, and
reports what it could not write**. `write`, `apply` and `force` are explicit
arguments, an existing file is never replaced without `force`, and a failure is
named per file rather than folded into a count — the DSH bug where every write
failed on a `workspace-write` profile while reporting nothing but
`Wrote 0 file(s)` is why the reply text names the file and the reason. The bytes
matter too: the templates ship byte-for-byte and a section is measured in bytes,
so the writer is UTF-8 without a BOM and touches nothing else about the content.

### Naming what is still a placeholder

The scaffold's second job is telling the project what to do with the files:
`planScaffold()` returns the per-file status, and the tool's reply names the
sections that are still placeholders — the layout, the commands and the hard
rules in `AGENTS.md`, and the first row of the index. A project that ships the
boilerplate unfilled has documents that read as authoritative and say nothing.

### Traps

- `templates/` must stay project-agnostic: no language, no build tool, no
  command a new project would not have. The only substitutions are
  `PROJECT_NAME`, `PROJECT_SUMMARY`, `HANDOFF_COMMIT` and `HANDOFF_DATE`.
- The templates and this repository's own documents are the same text with the
  placeholders resolved. A change to one is a change to the other in the same
  commit, or the next scaffolded project gets a version nobody uses.
- OpenCode accepts these files as instructions only from an `AGENTS.md`-shaped
  name, so the `.tmpl` suffix is also what keeps a `{{...}}` token out of any
  prompt-interpolation path — file content is never prompt text.
- **An install that flattens the built files breaks template resolution.** A
  copy with `index.js` at the package root and no `dist/` resolves
  `../templates/` above the package. This is why the installer keeps the
  package layout and why the resolution walks to the package root: either fix
  alone would have stopped the crash, and both are pinned.

## Config keys / UI

| Key | Default | Range | Set by |
| --- | --- | --- | --- |
| `root` | plugin location directory | any absolute path | `feature_map_init` argument |
| `project` | last path segment of `root` | any string | `feature_map_init` argument |
| `summary` | a visible fill-in comment | any string | `feature_map_init` argument |
| `write` | `false` | boolean | `feature_map_init` argument |
| `force` | `false` | boolean | `feature_map_init` argument |
| `only` | all four | template ids | `feature_map_init` argument |

## Tests that pin it

`test/plugin.test.mjs`: `the shipped boilerplate keeps its .tmpl suffix and
never claims an instruction name`, `the built module resolves its templates
from the package root`, `a flattened install finds its templates from the
package root too`, `the scaffold plans every file, then writes it`,
`a placeholder with no value stays visible instead of blanking the
document`.

`test/contract.test.mjs`: `a failed write is named, never counted` — the reply
names the blocking file and the reason (a blocker *file* where a directory is
needed fails with `ENOTDIR`), and `a command whose tool fails delivers the
reason instead of throwing`, which is the other half of the crash this page
records.

## Related

[map-tool.md](map-tool.md) · [enforcement.md](enforcement.md) ·
[adoption.md](adoption.md) · [packaging.md](packaging.md)
