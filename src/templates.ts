// Ported from the DSH plugin's lib and kept byte-faithful on purpose: its
// behaviour is pinned by the test suite and by scripts/smoke.mjs, not by the
// type checker. The JSDoc in it was written for a runtime that never type
// checked these files, so the annotations infer {} where the code reads
// options; forcing types onto them would churn the port without changing a
// behavior. src/index.ts is the new code and is fully checked.
// @ts-nocheck

/**
 * The boilerplate this plugin writes into a project.
 *
 * Every shipped template lives under `templates/` with a `.tmpl` suffix, and
 * the suffix is load-bearing: DSH loads `AGENTS.md`/`CLAUDE.md` from every
 * directory between the project root and the session's working directory, so a
 * file literally named `templates/AGENTS.md` would be injected as live
 * instructions — with `{{PROJECT_NAME}}` unsubstituted — into every session in
 * the repository that ships it. Keeping the template data rather than
 * instructions is the whole job of this module's naming convention.
 *
 * @module dsh-feature-map/templates
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The package root: the nearest directory above this module that holds a
 * `package.json`.
 *
 * The templates directory is resolved from here rather than from a fixed
 * relative hop (`../templates/` in the DSH original) because an installed
 * copy is not guaranteed to keep the built layout: OpenCode's loader was
 * observed resolving a plugin entry to a flattened root `index.js`, and a
 * module at the package root then found `../templates/` pointing one
 * directory *above* the package. The package root is the one location a
 * `dist/` module, a root module and a `src/` module share.
 *
 * Falls back to the module's own directory when no manifest is found above
 * it — unreachable for a shipped package, and it keeps the module
 * importable from a bare source tree.
 *
 * @returns the absolute package root.
 */
function packageRoot() {
  const here = dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return here
    dir = parent
  }
}

/** Absolute path of the shipped `templates/` directory. */
export const TEMPLATE_DIR = join(packageRoot(), 'templates')

/**
 * The boilerplate set, in the order a project should read it.
 *
 * `target` is a POSIX-style path relative to the project root; it is joined
 * with `node:path` at write time so the same manifest works on Windows.
 */
export const TEMPLATES = [
  {
    id: 'agents',
    source: 'AGENTS.md.tmpl',
    target: 'AGENTS.md',
    what: 'process and hard rules — the file DSH injects as instructions',
  },
  {
    id: 'feature-map',
    source: 'docs/features/index.html.tmpl',
    target: 'docs/features/index.html',
    what: 'the feature map: one HTML page per feature, and the page template',
  },
  {
    id: 'spec',
    source: 'docs/SPEC.md.tmpl',
    target: 'docs/SPEC.md',
    what: 'user-visible behavior',
  },
  {
    id: 'handoff',
    source: 'HANDOFF.md.tmpl',
    target: 'HANDOFF.md',
    what: 'volatile session state',
  },
]

/** `{{NAME}}` tokens, upper snake case only, so prose can use `{{` freely. */
const TOKEN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g

/** What a scaffolded `AGENTS.md` says when the caller gave no summary. */
export const SUMMARY_PLACEHOLDER =
  '<!-- one line: what it is, what it is built with, and what it is for. -->'

/**
 * Substitute `{{NAME}}` tokens in one template body.
 *
 * An unresolved token is reported rather than replaced by an empty string: a
 * silently blanked `{{PROJECT_NAME}}` produces a document that looks finished
 * and says nothing, which is worse than a visible token.
 *
 * @param text - the template body.
 * @param variables - token values; a missing or empty value is reported.
 * @returns the substituted text and the names that had no value.
 */
export function substitute(text, variables) {
  const missing = new Set()
  const rendered = text.replace(TOKEN, (token, name) => {
    const value = variables[name]
    if (value === undefined || value === null || value === '') {
      missing.add(name)
      return token
    }
    return String(value)
  })
  return { text: rendered, missing: [...missing] }
}

/**
 * Build the substitution table for a project.
 *
 * @param input - the project name, its one-line summary, and an ISO date.
 * @returns token values; `PROJECT_SUMMARY` falls back to a visible fill-in.
 */
export function templateVariables(input) {
  const project = input.project?.trim() || 'this project'
  const summary = input.summary?.trim() || SUMMARY_PLACEHOLDER
  const date = input.date ?? new Date().toISOString().slice(0, 10)
  const commit = input.commit?.trim() || '<commit>'
  return {
    PROJECT_NAME: project,
    PROJECT_SUMMARY: summary,
    HANDOFF_COMMIT: commit,
    HANDOFF_DATE: date,
  }
}

/**
 * Resolve a template-relative target inside the project root.
 *
 * @param root - absolute project root.
 * @param target - POSIX-style path from {@link TEMPLATES}.
 * @returns the absolute path to write.
 */
export function targetPath(root, target) {
  return join(resolve(root), ...target.split('/'))
}

/**
 * Read one shipped template by its `source` name.
 *
 * @param source - a `source` from {@link TEMPLATES}, e.g. `AGENTS.md.tmpl`.
 * @returns the template body, unsubstituted.
 */
export async function readTemplate(source) {
  return readFile(join(TEMPLATE_DIR, ...String(source).split('/')), 'utf8')
}

/**
 * The `##` blocks an existing document lacks, compared with a template.
 *
 * Adoption never edits a document it did not write, so the useful thing to say
 * about an existing `AGENTS.md` is which blocks are absent by name — the caller
 * can then hand over exactly those, and a project that has already rewritten a
 * block keeps its own version.
 *
 * @param existingText - the document as it stands; empty for a missing file.
 * @param templateText - the template to compare against.
 * @returns the template's headings that the document does not have.
 */
export function missingBlocks(existingText, templateText) {
  const headingsOf = (text) =>
    [...String(text ?? '').matchAll(/^##[ \t]+(.+)$/gm)].map((match) => match[1].trim())
  const have = new Set(headingsOf(existingText))
  return headingsOf(templateText).filter((heading) => !have.has(heading))
}

/**
 * Work out what a scaffold would write, without writing anything.
 *
 * @param input - root, token values, an optional template filter, and whether
 * an existing file may be replaced.
 * @returns one entry per template, each with its status and rendered content.
 */
export async function planScaffold(input) {
  const root = resolve(input.root)
  const wanted = input.only?.length
    ? TEMPLATES.filter((template) => input.only.includes(template.id))
    : TEMPLATES
  const entries = []
  const missing = new Set()

  for (const template of wanted) {
    const source = await readTemplate(template.source)
    const { text, missing: unresolved } = substitute(source, input.variables ?? {})
    for (const name of unresolved) missing.add(name)
    const path = targetPath(root, template.target)
    const existing = await stat(path).then(
      (info) => info.isFile(),
      () => false,
    )
    entries.push({
      id: template.id,
      what: template.what,
      target: template.target,
      path,
      exists: existing,
      status: existing ? (input.force ? 'overwrite' : 'exists') : 'create',
      content: text,
    })
  }

  return { root, entries, missing: [...missing] }
}

/**
 * Write a plan produced by {@link planScaffold}.
 *
 * The writer is injected rather than imported so the write goes through the
 * harness's own filesystem seam — which is what applies the profile's sandbox
 * and observation policy — instead of around it through `node:fs`.
 *
 * @param plan - the plan to apply.
 * @param write - writes one absolute path with its content.
 * @returns the entries actually written, and the ones left alone.
 */
export async function applyScaffold(plan, write) {
  const written = []
  const skipped = []
  for (const entry of plan.entries) {
    if (entry.status === 'exists') {
      skipped.push(entry)
      continue
    }
    await mkdir(dirname(entry.path), { recursive: true })
    await write(entry.path, entry.content)
    written.push(entry)
  }
  return { written, skipped }
}
