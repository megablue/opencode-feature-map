# opencode-feature-map — behavior spec

An OpenCode plugin that makes a project's feature map the first thing an agent
reads, and gives a new project that map in the first place.

User-visible behavior only. Mechanism, files and traps live in
`docs/features/`; process and hard rules live in `AGENTS.md`.

## What a session sees

- **A standing instruction.** Once the plugin is installed, every agent that can
  read files is told, in its system prompt, to work from `docs/features/` before
  the source: the map holds one page per feature with that area's files, types,
  tests and traps, and `docs/features/index.html` is the index. Pages are HTML
  documents; the agent receives them as compact text, with code-shaped blocks as
  pseudocode unless a block says why its exact bytes matter, and a graph as an
  edge list. A map written as `docs/features/README.md` plus `.md` pages is still
  read. An agent whose
  profile has restricted the filesystem tools away is told nothing — the rule is
  dropped rather than left as noise it cannot act on.
- **A tool that answers with the map, at the size of the question.** A read can
  be as coarse as the index or as fine as one `###` inside one section:

  | Ask | Answer |
  | --- | --- |
  | nothing | the index — the feature table and the pages it links |
  | `topic` | the sections that match: names, files and tests, with the prose left out unless the topic matched it |
  | `topic` + `skeleton` | the matching pages' section lists and sizes, no content |
  | `page` | that page's shape: its sections and their sizes |
  | `page` + `section` | that one section |
  | `page` + `section` + `sub` | that one `###` subsection |
  | `page` + `full` | the whole page |

  Every answer names what it left out and the call that reaches it. It reads the
  project's own documents; it holds no index of its own and answers nothing the
  map does not already say.
- **The same six, as commands.** `/feature-map`, `/feature-map-check`,
  `/feature-map-init`, `/feature-map-adopt`, `/feature-map-regen` and
  `/feature-map-upgrade` run the
  tool behind each name with the arguments typed after it and deliver the reply
  into the session as a message — the same text the tool would have returned,
  without a model turn to say it.
- **One interruption, at most, per session.** In a project that has a map, the
  first source lookup (`read`, `grep` or `glob`) is denied once, with a message
  that names the remedy. The next attempt proceeds whether or not the agent
  complied. A second denial never happens in the same session.
- **Nothing at all in a project with no map.** No denial, no nagging, and no
  cost beyond the standing instruction.
- **A way to start a map.** `feature_map_init` returns the four documents that
  make up the workflow — `AGENTS.md`, `HANDOFF.md`, `docs/SPEC.md` and the map
  index with its page template — rendered for the project, or writes them on
  request.
- **A way to check the map.** `feature_map_check` reports pages no index row
  links, index rows whose link does not resolve, pages with no title, and — as a
  separate note, not as drift — the sections that have outgrown a single read,
  saying which of those already divide at `###` level. A consistent index is
  reported clean even when its prose is long.
- **A way to adopt an existing project.** `feature_map_adopt` reports what a
  project that already has docs is missing: pages without the mandated headings,
  pages with no `Read when:` trigger, index rows that do not resolve, documents
  under `docs/` that are not in the map, and `AGENTS.md` blocks that are absent.
  It returns a plan whose items say whether they are derived from the files or
  need an author, and it never edits a file that exists: `apply` writes only
  files that do not exist. A project with no docs and no `AGENTS.md` is pointed
  at `feature_map_init` instead.
- **A way to rewrite a map that has outgrown its shape.** `feature_map_regen`
  reads the map that exists and reports what it would make of it: the six
  headings and the `Status: … Read when:` line where they are missing, every
  section larger than the size limit divided into `###` chunks that fit one read,
  and the index reconciled with the pages. A chunk it can name from the author's
  own lead-in is named; any other is left as a visible
  `<!-- chunk 1/2: name this -->`. It adds, removes and rewords no prose, moves
  nothing between sections, and touches nothing outside `docs/features/`.
  Nothing is written until `apply` is passed, and a second run changes nothing.
- **A way to convert a legacy map.** `feature_map_upgrade` reports the HTML files
  a Markdown map would become: one `.html` sibling per `.md` page and
  `index.html` for `README.md`, with internal links rewritten. `apply` writes
  them, `prune` removes the `.md` sources, and `force` overwrites an existing
  HTML file. Without `prune` the old files stay, both formats keep working, and
  the HTML page wins when a stem has both. Both the plan and every legacy-map
  reply say the map is still Markdown.
- **A review note on code blocks.** `feature_map_check` reports pseudocode that
  was converted from a real language and `verbatim` blocks with no `data-why`
  reason, under `On code:` rather than as drift.

## Page format

A page is an HTML document with an `h1` title, a `p class="status"` line and one
`section` per `h2`. The headings are what the tools address, so the skeleton is
fixed in the same way the Markdown one was. The agent never receives the markup:
replies are rendered to text and every size is measured there. A person opening
the file sees a styled page, working links and a drawn graph.

A code-shaped block is `<pre class="pseudo">` — pseudocode is the default, and a
fence converted from a language keeps that language in `data-from-lang`.
`<pre class="verbatim" data-why="…">` is for bytes that must survive exactly, and
the reason is required. `<pre class="mermaid">` is a graph; the browser loads the
renderer from a CDN and the agent is given the edge list.

## Modes

| Mode | Standing instruction | Guard |
| --- | --- | --- |
| `enforce` (default) | yes | denies the first source lookup of a session, once |
| `prompt` | yes | none |
| `off` | no | none |

Tools and commands are available in every mode.

## Scope and limits

- The plugin never parses a project's source, caches a symbol index, or infers
  a file path from a feature name. If the map is silent, the plugin is silent.
- The map is found by walking up from the session's location directory,
  stopping at the project root: a `docs/features/index.html` (or legacy
  `README.md`) in an unrelated ancestor directory is not this project's map.
- A reply is capped at a byte budget (12 KB by default). A capped reply says
  where it stopped and how to resume; the offset it reports always advances, so
  even one oversized section can be read to its end in a few calls.
- A page written without `##` headings is still readable: it is delivered as a
  single chunk named after its title rather than disappearing from a search.
- The plugin runs inside the OpenCode server, under the authority of the user
  who installed it, so reading the map and writing the boilerplate are both
  plain filesystem operations. There is no sandbox seam to write through, and
  no user interface of its own: no settings page, no panel - the six commands
  above are the whole surface. Its configuration is the plugin options entry in
  `opencode.json(c)`.
