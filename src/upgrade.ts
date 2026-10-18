/**
 * Converting a legacy Markdown map to the HTML format.
 *
 * The conversion is additive by default: every `.md` page gets an `.html`
 * sibling, the index `README.md` becomes `index.html`, and both formats are
 * read forever afterwards — `listPages()` prefers the HTML page when a stem has
 * both, so the old file costs nothing but survives a merge or a review that
 * still points at it. `prune` is the one way the old files go away, and it is
 * never implied.
 *
 * The other half of the job is the code policy. A fenced block with a language
 * is real code copied into a document about the feature, so it becomes
 * pseudocode — `data-from-lang` keeps the provenance and the report names it
 * for review. A `verbatim` block must say why its exact bytes matter; a
 * converted one that does not gets a visible placeholder reason and a line in
 * the report, because "verbatim" with no reason is how a copied block escapes
 * the review that was supposed to turn it into prose.
 *
 * @module opencode-feature-map/upgrade
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'

import {
  LEGACY_MAP_INDEX,
  MAP_DIR,
  MAP_INDEX_HTML,
  findMapRoot,
  toPosix,
} from './map.js'
import { htmlSibling, isMarkdownFile, markdownToHtmlDocument } from './html.js'

/** Every Markdown file under a directory, recursively, in path order. */
async function walkMarkdown(dir) {
  const files = []
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (isMarkdownFile(entry.name)) files.push(path)
    }
  }
  await walk(dir)
  return files.sort()
}

/** The first `#` heading of a Markdown document. */
function titleOf(text, rel) {
  const title = /^#[ \t]+(.+)$/m.exec(String(text ?? ''))?.[1]?.trim()
  return title || posix.basename(rel).replace(/\.md$/i, '')
}

/**
 * Work out what an upgrade would write, without writing anything.
 *
 * @param root - project root, or a directory inside it.
 * @param options - `force` overwrites an existing `.html`; `prune` also removes
 * the `.md` sources when applied.
 * @returns the plan: `{ root, absent?, entries, counts, legacy }`.
 */
export async function planUpgrade(root, options: any = {}) {
  const base = resolve(root)
  const found = findMapRoot(base)
  const mapDir = join((found?.root ?? base), ...MAP_DIR.split('/'))
  if (!found && !existsSync(mapDir)) {
    // The no-map plan keeps the same keys as the normal one: callers read
    // `flagged` and `verbatim` unconditionally, so an absent plan that omitted
    // them would throw on the very case it exists to report.
    return {
      root: base,
      absent: true,
      legacy: false,
      alreadyHtml: false,
      prune: options.prune === true,
      entries: [],
      flagged: [],
      verbatim: [],
      counts: { pages: 0, writes: 0, exists: 0, flagged: 0, verbatim: 0, prune: 0 },
    }
  }
  const projectRoot = found?.root ?? base
  const mapRoot = join(projectRoot, ...MAP_DIR.split('/'))
  const files = await walkMarkdown(mapRoot)
  const entries = []
  const flagged = []
  const verbatim = []

  for (const path of files) {
    const rel = toPosix(projectRoot, path)
    const isIndex = rel === LEGACY_MAP_INDEX
    const targetRel = isIndex ? MAP_INDEX_HTML : htmlSibling(rel)
    const targetPath = join(projectRoot, ...targetRel.split('/'))
    const exists = existsSync(targetPath)
    const status = exists ? (options.force ? 'overwrite' : 'exists') : 'create'
    const raw = await readFile(path, 'utf8').catch(() => '')
    const converted = markdownToHtmlDocument(raw, { title: titleOf(raw, rel) })
    entries.push({
      rel,
      path,
      targetRel,
      targetPath,
      kind: isIndex ? 'index' : 'page',
      status,
      content: converted.html,
      flagged: converted.flagged,
      verbatim: converted.verbatim,
      bytes: Buffer.byteLength(converted.html, 'utf8'),
    })
    for (const entry of converted.flagged) flagged.push({ rel, ...entry })
    for (const entry of converted.verbatim) verbatim.push({ rel, ...entry })
  }

  const pages = entries.filter((entry) => entry.kind === 'page')
  return {
    root: projectRoot,
    absent: false,
    legacy: Boolean(found?.legacy) || entries.length > 0,
    alreadyHtml: entries.length === 0 && existsSync(join(projectRoot, ...MAP_INDEX_HTML.split('/'))),
    prune: options.prune === true,
    entries,
    flagged,
    verbatim,
    counts: {
      pages: pages.length,
      writes: entries.filter((entry) => entry.status !== 'exists').length,
      exists: entries.filter((entry) => entry.status === 'exists').length,
      flagged: flagged.length,
      verbatim: verbatim.length,
      prune: entries.filter((entry) => entry.status !== 'exists').length,
    },
  }
}

/**
 * Write a plan produced by {@link planUpgrade}.
 *
 * @param plan - the plan.
 * @param write - `(path, content) => Promise<void>`; injectable so the caller
 * controls the seam.
 * @returns `{ written, skipped, removed, failed }`.
 */
export async function applyUpgrade(plan, write = defaultWrite) {
  const written = []
  const skipped = []
  const removed = []
  const failed = []
  for (const entry of plan.entries) {
    if (entry.status === 'exists') {
      skipped.push(entry)
      continue
    }
    try {
      await mkdir(dirname(entry.targetPath), { recursive: true })
      await write(entry.targetPath, entry.content)
      written.push(entry)
      if (plan.prune) {
        await rm(entry.path, { force: true })
        removed.push(entry.rel)
      }
    } catch (error) {
      failed.push({ rel: entry.targetRel, reason: error?.message ?? String(error) })
    }
  }
  return { written, skipped, removed, failed }
}

/** The default writer: UTF-8, no BOM, parents created. */
async function defaultWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/**
 * The upgrade's reply.
 *
 * @param plan - from {@link planUpgrade}.
 * @param result - from {@link applyUpgrade}, when it ran.
 * @returns the text a caller reads before deciding to apply.
 */
export function renderUpgradeText(plan, result = undefined) {
  if (plan.absent) {
    return `No \`${MAP_DIR}/\` under \`${plan.root}\`, so there is no map to convert. \`feature_map_init\` writes the HTML index and page template a project starts from.`
  }
  if (plan.alreadyHtml) {
    return `The map under \`${plan.root}\` is already HTML (\`${MAP_INDEX_HTML}\`); there is no Markdown index to convert.`
  }

  const lines = []
  const head = `${plan.counts.pages} page(s) and 1 index: ${plan.counts.writes} file(s) to write, ${plan.counts.exists} already present and left alone.`
  lines.push(head)
  if (!result) {
    lines.push(
      'Both formats are read after the conversion; the HTML page wins when a stem has both, and the `.md` file is kept unless you pass `prune`.',
    )
  }
  if (plan.flagged.length) {
    lines.push(
      `\n${plan.flagged.length} fenced code block(s) became pseudocode (\`data-from-lang\` keeps the language) and want a review:`,
    )
    for (const entry of plan.flagged.slice(0, 8)) {
      lines.push(`- \`${entry.rel}\` line ${entry.line} (${entry.lang}): ${entry.preview || '(empty)'}`)
    }
    if (plan.flagged.length > 8) lines.push(`- +${plan.flagged.length - 8} more`)
  }
  if (plan.verbatim.length) {
    lines.push(
      `\n${plan.verbatim.length} verbatim block(s) carry no \`data-why\`; a placeholder reason was written and wants an author:`,
    )
    for (const entry of plan.verbatim.slice(0, 8)) {
      lines.push(`- \`${entry.rel}\` line ${entry.line}: ${entry.preview || '(empty)'}`)
    }
    if (plan.verbatim.length > 8) lines.push(`- +${plan.verbatim.length - 8} more`)
  }
  if (result) {
    lines.push(
      `\nWrote ${result.written.length} file(s)${result.removed.length ? `, removed ${result.removed.length} legacy \`.md\` source(s)` : ', kept every `.md` source'}.`,
    )
    for (const entry of result.written) lines.push(`- \`${entry.targetRel}\``)
    for (const entry of result.failed) lines.push(`- could not write \`${entry.rel}\`: ${entry.reason}`)
    lines.push('\nRun `feature_map_check` to confirm the HTML index and the pages agree.')
  } else if (plan.counts.writes) {
    lines.push(`\nPlan only: nothing was written. Pass \`apply: true\` to write ${plan.counts.writes} file(s).`)
  }
  return lines.join('\n')
}
