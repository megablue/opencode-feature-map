// Ported from the DSH plugin's lib and kept byte-faithful on purpose: its
// behaviour is pinned by the test suite and by scripts/smoke.mjs, not by the
// type checker. The JSDoc in it was written for a runtime that never type
// checked these files, so the annotations infer {} where the code reads
// options; forcing types onto them would churn the port without changing a
// behavior. src/index.ts is the new code and is fully checked.
// @ts-nocheck

/**
 * Reading a project's feature map: finding it, listing its pages, ranking them
 * against a topic, and checking that the index and the pages still agree.
 *
 * Everything here is a read of the project's own `docs/features/` tree. The
 * plugin deliberately keeps no index of its own — a cached symbol map that
 * answers after the source has moved is worse than no map at all, and the
 * whole premise of the workflow is that the map is the cheap, true answer.
 *
 * @module dsh-feature-map/map
 */

import { statSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import {
  escapeHtml,
  htmlTitle,
  htmlToMapText,
  isHtmlFile,
  isMarkdownFile,
  scanHtml,
} from './html.js'

/** Directory, relative to the project root, that holds the feature map. */
export const MAP_DIR = 'docs/features'

/** The index page of a map written in the current format. */
export const MAP_INDEX_HTML = `${MAP_DIR}/index.html`

/** The index of a map written before the HTML format; still read forever. */
export const LEGACY_MAP_INDEX = `${MAP_DIR}/README.md`

/** The index a new map gets. */
export const MAP_INDEX = MAP_INDEX_HTML

/** The index of a legacy map. */
export const MAP_INDEX_MD = LEGACY_MAP_INDEX

/** Words too common to identify a page. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'what',
  'how', 'why', 'does', 'not', 'but', 'are', 'was', 'were', 'its', 'his', 'her',
  'them', 'they', 'you', 'your', 'our', 'their', 'can', 'will', 'would', 'should',
])

/** Split text into comparable lowercase words. */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
}

/**
 * Walk up from a directory until the project root, and find its feature map.
 *
 * The walk stops after the first directory that contains `.git`, so a map in
 * an unrelated ancestor directory is never mistaken for this project's. Both
 * the directory and its `README.md` are required: a bare `docs/features/` with
 * no index is a directory the agent should see, not a map the guard can rely
 * on.
 *
 * Synchronous on purpose: the tool guard is a synchronous check, and one
 * lookup shared by the guard and the tools is better than two implementations
 * of "where is the map" that can disagree.
 *
 * @param startDir - absolute directory to start from, usually the session cwd.
 * @returns the project root and index path, or `undefined` when there is none.
 */
export function findMapRoot(startDir) {
  let dir = resolve(startDir ?? '')
  for (;;) {
    const current = join(dir, ...MAP_INDEX_HTML.split('/'))
    if (isFile(current)) {
      return { root: dir, indexPath: current, indexRel: MAP_INDEX_HTML, format: 'html', legacy: false }
    }
    const legacy = join(dir, ...LEGACY_MAP_INDEX.split('/'))
    if (isFile(legacy)) {
      return { root: dir, indexPath: legacy, indexRel: LEGACY_MAP_INDEX, format: 'markdown', legacy: true }
    }
    const parent = dirname(dir)
    if (isFile(join(dir, '.git')) || parent === dir) return undefined
    dir = parent
  }
}

/** Is this an existing regular file? Never throws. */
function isFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
}

/** Convert an absolute path to the POSIX-style relative form used in links. */
export function toPosix(from, to) {
  return relative(from, to).split(sep).join(posix.sep)
}

/**
 * List every page under the map, excluding the index and the assets.
 *
 * Both formats are read, forever: a project that never runs the upgrade keeps
 * working, and a project that ran it keeps its old `.md` files beside the new
 * `.html` ones. When both exist for one stem the HTML page wins, so the
 * upgrade does not double every entry in the index and in every reply. Files
 * whose name starts with `_` are the map's own assets (`_map.css`, a partial),
 * not pages.
 *
 * @param root - absolute project root.
 * @returns one entry per page, with its map-relative path, title, text and
 * format; `text` is the canonical text every reader and size uses.
 */
export async function listPages(root) {
  const base = join(root, ...MAP_DIR.split('/'))
  const files = await walkDocs(base)
  const htmlStems = new Set(
    files.filter((path) => isHtmlFile(path)).map((path) => toPosix(root, path).replace(/\.html?$/i, '')),
  )
  const pages = []
  for (const path of files) {
    const rel = toPosix(root, path)
    if (rel === MAP_INDEX_HTML || rel === LEGACY_MAP_INDEX) continue
    if (posix.basename(rel).startsWith('_')) continue
    if (isMarkdownFile(path) && htmlStems.has(rel.replace(/\.md$/i, ''))) continue
    const raw = await readFile(path, 'utf8').catch(() => '')
    const format = isHtmlFile(path) ? 'html' : 'markdown'
    const text = format === 'html' ? htmlToMapText(raw) : raw
    pages.push({
      rel,
      path,
      title: firstHeading(text) ?? (format === 'html' ? htmlTitle(raw) : undefined) ?? posix.basename(path).replace(/\.(md|html?)$/i, ''),
      text,
      format,
      ...(format === 'html' ? { html: raw } : {}),
    })
  }
  pages.sort((a, b) => a.rel.localeCompare(b.rel))
  return pages
}

/** Every Markdown and HTML file under a directory, recursively, in path order. */
async function walkDocs(dir) {
  const files = []
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (isMarkdownFile(entry.name) || isHtmlFile(entry.name)) files.push(path)
    }
  }
  await walk(dir)
  return files.sort()
}

/**
 * Read the map's index in its canonical text form, whichever format it is in.
 *
 * @param root - absolute project root.
 * @returns the index's rel path, absolute path, format, legacy flag and text.
 */
export async function readMapIndex(root) {
  const found = findMapRoot(root)
  const rel = found?.indexRel ?? MAP_INDEX
  const path = found?.indexPath ?? join(root, ...MAP_INDEX.split('/'))
  const format = found?.format ?? 'html'
  const raw = await readFile(path, 'utf8').catch(() => '')
  return {
    rel,
    path,
    format,
    legacy: Boolean(found?.legacy),
    raw,
    text: format === 'html' ? htmlToMapText(raw) : raw,
  }
}

/**
 * Markdown or HTML under `docs/` that is not a page of the map.
 *
 * Reported, never touched. A `docs/SPEC.md` is not a feature page, and deciding
 * that `docs/GAME.md` should become one is a judgement about the project rather
 * than a fact about its files — which is exactly the line this plugin does not
 * cross.
 *
 * @param root - absolute project root.
 * @returns one entry per candidate, with its title, size and section count.
 */
export async function docsCandidates(root) {
  const docsRoot = join(root, 'docs')
  const mapRoot = join(root, ...MAP_DIR.split('/'))
  const candidates = []
  for (const path of await walkDocs(docsRoot)) {
    const inside = relative(mapRoot, path)
    if (!inside.startsWith('..') && !isAbsolute(inside)) continue
    const raw = await readFile(path, 'utf8').catch(() => '')
    const text = isHtmlFile(path) ? htmlToMapText(raw) : raw
    candidates.push({
      rel: toPosix(root, path),
      title: firstHeading(text) ?? posix.basename(path).replace(/\.(md|html?)$/i, ''),
      bytes: Buffer.byteLength(text, 'utf8'),
      sections: splitSections(text).sections.length,
    })
  }
  return candidates.sort((a, b) => a.rel.localeCompare(b.rel))
}

/** The text of the first `# ` heading, without the marker. */
export function firstHeading(text) {
  const match = /^#[ \t]+(.+)$/m.exec(String(text ?? ''))
  return match ? match[1].trim() : undefined
}

/**
 * The headings a conformant feature page carries, in order.
 *
 * This is the conformance target, and it is not this module's invention: the
 * shipped doc template fixes these headings, which is what lets a page be split
 * into retrievable sections at all.
 */
export const PAGE_HEADINGS = [
  'What it does',
  'Map',
  'How & why',
  'Config keys / UI',
  'Tests that pin it',
  'Related',
]

/**
 * The `Status: … · Read when: …` line, and the trigger inside it.
 *
 * The trigger is the half that matters for an index: it is the phrase someone
 * searches for when they do not yet know which page they need. It is read, not
 * invented — a page without one gets a flagged gap rather than a plausible
 * sentence this tool made up.
 *
 * @param text - a page body.
 * @returns the line and its trigger, or `undefined` when there is no such line.
 */
export function parseStatusLine(text) {
  const line = /^Status:[^\n]*$/m.exec(String(text ?? ''))?.[0]
  if (!line) return undefined
  const trigger = /Read when:\s*(.+?)\s*$/i.exec(line)?.[1]
  return { line, trigger: trigger || undefined }
}

/**
 * How a section divides, and whether that is enough.
 *
 * A section past the byte limit is not automatically a problem: one with `###`
 * headings is already retrievable in chunks, which is the whole point of the
 * subsection level. The report has to say which kind it is, or it asks for work
 * that has already been done — `runtime.md → How & why` is 11,761 B and arrives
 * as seven chunks, the largest 2,347 B.
 *
 * @param section - one section from {@link splitSections}.
 * @param maxSectionBytes - the size a chunk should fit in.
 * @returns the chunk count, the largest chunk, and whether it is addressable.
 */
export function divisibility(section, maxSectionBytes = 2048) {
  const subsections = splitSubsections(section)
  if (subsections.length === 0) {
    return {
      chunks: 1,
      largestChunk: section.bytes,
      addressable: section.bytes <= maxSectionBytes,
    }
  }
  const largestChunk = subsections.reduce((max, sub) => Math.max(max, sub.bytes), 0)
  return {
    chunks: subsections.length,
    largestChunk,
    addressable: largestChunk <= maxSectionBytes,
  }
}

/**
 * Parse the index's table into rows.
 *
 * @param indexText - the index page.
 * @returns one row per table body line, with its label, link target and
 * "read when" cell; a row whose link has no target keeps the label only.
 */
export function parseIndexRows(indexText) {
  const rows = []
  for (const line of String(indexText ?? '').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 2) continue
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === '')) continue
    const link = /\[([^\]]*)\]\(([^)]*)\)/.exec(cells[1])
    const feature = cells[0]
    const target = link?.[2]?.trim()
    if (!link && /^(feature|doc|read when)$/i.test(feature)) continue
    rows.push({
      feature: feature.replace(/\*\*/g, ''),
      doc: target || link?.[1] || '',
      when: cells[2] ?? '',
    })
  }
  return rows
}

/**
 * Derive index rows from the pages that exist.
 *
 * This is the deterministic half of adopting a project: a page's title is its
 * feature label, its path is its link, and its `Status:` line carries the
 * trigger. Nothing is invented — a page with no trigger produces a row with an
 * empty trigger and a flag, because the trigger is the search key and a
 * plausible-sounding sentence this tool made up would be worse than a gap.
 *
 * @param pages - pages from {@link listPages}.
 * @param options - `indexPath` is what links are made relative to.
 * @returns one row per page, with duplicate labels and missing triggers marked.
 */
export function generateIndexRows(pages, options = {}) {
  const indexDir = dirname(options.indexPath ?? join(MAP_DIR, 'index.html'))
  const rows = pages.map((page) => {
    const status = parseStatusLine(page.text)
    const label =
      page.title || posix.basename(page.rel).replace(/\.(md|html?)$/i, '')
    return {
      feature: label,
      doc: relative(indexDir, page.path).split(sep).join(posix.sep),
      when: status?.trigger ?? '',
      missingTrigger: !status?.trigger,
      duplicate: false,
    }
  })
  const counts = new Map()
  for (const row of rows) counts.set(row.feature, (counts.get(row.feature) ?? 0) + 1)
  for (const row of rows) row.duplicate = counts.get(row.feature) > 1
  return rows
}

/**
 * What a row says when the page states no trigger of its own.
 *
 * Shared by the row renderer and by anything that fills a `Status:` line in, so
 * a page and its index row are never given two different-looking gaps.
 */
export const TRIGGER_PLACEHOLDER = '<!-- the trigger: what would make someone search for this -->'

/**
 * Render one index row.
 *
 * The one place a row's shape is decided: {@link renderIndexTable} builds on it,
 * and the regeneration writes a single row at a time — two renderers would be
 * two answers to "what does a row look like", and the index is parsed back by a
 * third piece of code.
 *
 * @param row - a row from {@link generateIndexRows}.
 * @param columns - the table's column count; extra cells are left empty so a
 * regenerated row never breaks a project's wider table.
 * @returns the markdown table line.
 */
export function renderIndexRow(row, columns = 3) {
  const label = posix.basename(row.doc)
  const when = row.when || TRIGGER_PLACEHOLDER
  const cells = [row.feature, `[${label}](${row.doc})`, when]
  while (cells.length < Math.max(3, columns)) cells.push('')
  return `| ${cells.join(' | ')} |`
}

/** Render generated rows as the index's table, ready to paste. */
export function renderIndexTable(rows) {
  const header = ['| Feature | Doc | Read when |', '| --- | --- | --- |']
  return [...header, ...rows.map((row) => renderIndexRow(row))].join('\n')
}

/**
 * Render generated rows as the HTML table's body.
 *
 * The HTML index carries a marked row where its rows go, so scaffolding and
 * adoption can fill it without rewriting the project's prose around it.
 *
 * @param rows - rows from {@link generateIndexRows}.
 * @returns one `<tr>` per row.
 */
export function renderIndexHtmlTable(rows) {
  return rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.feature)}</td><td><a href="${escapeHtml(row.doc)}">${escapeHtml(
          posix.basename(row.doc),
        )}</a></td><td>${escapeHtml(row.when || '')}</td></tr>`,
    )
    .join('\n')
}

/**
 * Rank pages against a topic.
 *
 * A name match outranks a mention: the page whose *filename* carries the topic
 * is the page for that area, while a page that merely says the word once is
 * usually not. That ordering is what makes a one-word topic ("probes",
 * "theming") return the right page instead of the index.
 *
 * @param pages - pages from {@link listPages}.
 * @param topic - free text: a feature name, a symptom, a symbol.
 * @param options - `limit` caps the results; defaults to 2.
 * @returns the matching pages, best first, each with its score and matched words.
 */
export function rankPages(pages, topic, options = {}) {
  const limit = options.limit ?? 2
  const words = [...new Set(tokenize(topic))]
  if (words.length === 0) return []
  const scored = []
  for (const page of pages) {
    const name = `${page.rel} ${page.title}`.toLowerCase()
    const headings = String(page.text ?? '')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('#'))
      .join(' ')
      .toLowerCase()
    const body = String(page.text ?? '').toLowerCase()
    let score = 0
    const matched = new Set()
    for (const word of words) {
      let hit = 0
      if (name.includes(word)) hit += 6
      if (headings.includes(word)) hit += 3
      const occurrences = body.split(word).length - 1
      if (occurrences > 0) hit += Math.min(occurrences, 5)
      if (hit > 0) matched.add(word)
      score += hit
    }
    if (matched.size > 0) scored.push({ ...page, score, matched: [...matched] })
  }
  scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
  return scored.slice(0, limit)
}

/**
 * The sections that carry the anti-hunting payload: what the area does, the
 * names in it, and the tests that pin it — without the prose that explains why.
 *
 * A topic reply defaults to these. A mechanical change needs the names and the
 * tests; it needs `How & why` only when the mechanism itself is the question,
 * and that section is where most of a page's bytes live.
 */
export const TIER1_SECTIONS = ['What it does', 'Map', 'Tests that pin it']

/** A heading as a comparable slug: lowercase words joined by `-`. */
export function slugify(heading) {
  return String(heading ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** The heading text of a chunk, without its markers. */
export function headingOf(chunk) {
  const match = /^#{1,6}[ \t]+(.+)$/m.exec(String(chunk ?? ''))
  return match ? match[1].trim() : undefined
}

/**
 * Split a page into its `##` sections.
 *
 * The headings are the retrieval unit, which is why the shipped doc template
 * fixes them: a page whose sections are predictable can be read one section at
 * a time. The preamble — the `#` title and the `Status:` line — comes back
 * separately because it is what orients a reader who was handed one section.
 *
 * @param text - the page body.
 * @returns the preamble, and every `##` section with its heading, slug, byte
 * size and document position.
 */
export function splitSections(text) {
  const chunks = String(text ?? '').split(/\n(?=##[ \t])/)
  let preamble = chunks[0] ?? ''
  let sections = chunks.slice(1).map((chunk, index) => {
    const heading = headingOf(chunk) ?? `(untitled ${index + 1})`
    return {
      heading,
      slug: slugify(heading),
      text: chunk,
      bytes: Buffer.byteLength(chunk, 'utf8'),
      index,
    }
  })
  if (sections.length === 0 && preamble.trim()) {
    // A page written without `##` headings is still a page. It degrades to one
    // chunk — named after its title, with the title line removed so a reply
    // never prints it twice — rather than becoming invisible to a read that
    // asks for sections.
    const heading = headingOf(preamble) ?? '(whole page)'
    const body = preamble.replace(/^#[ \t].*\r?\n?/, '')
    sections = [
      {
        heading,
        slug: slugify(heading),
        text: body,
        bytes: Buffer.byteLength(body, 'utf8'),
        index: 0,
        whole: true,
      },
    ]
    preamble = ''
  }
  return { preamble, sections }
}

/**
 * Split one section into its `###` subsections.
 *
 * A section can outgrow a read on its own — the largest one in a real map is
 * over 11 KB, bigger than every whole page but its own — and a `###` heading is
 * the only finer unit an author already provides. The section's own lead text
 * travels with every subsection, so a slice never arrives without its premise.
 *
 * @param section - one section from {@link splitSections}.
 * @returns one entry per `###` subsection, or an empty list when there are none.
 */
export function splitSubsections(section) {
  const chunks = String(section?.text ?? '').split(/\n(?=###[ \t])/)
  if (chunks.length < 2) return []
  return chunks.slice(1).map((chunk, index) => {
    const heading = headingOf(chunk) ?? `(untitled ${index + 1})`
    return {
      heading,
      slug: slugify(heading),
      text: chunk,
      bytes: Buffer.byteLength(chunk, 'utf8'),
      index,
      lead: chunks[0],
    }
  })
}

/** Find one section by heading, slug or unique fragment. */
export function findSection(sections, query) {
  const wanted = slugify(query)
  if (!wanted) return { matches: [] }
  const exact = sections.filter((section) => section.slug === wanted)
  if (exact.length) return { matches: exact }
  return { matches: sections.filter((section) => section.slug.includes(wanted)) }
}

/** Find one subsection by heading, slug or unique fragment. */
export function findSubsection(subsections, query) {
  return findSection(subsections, query)
}

/**
 * Rank the sections of every page against a topic.
 *
 * The same "a name beats a mention" weighting as {@link rankPages}, applied one
 * level down, plus a bonus for a tier-1 section: a cheap section that answers
 * the question has to outrank an expensive one that merely mentions it, or the
 * default reply is the prose again. Equal scores prefer the smaller section,
 * because the whole point is to spend fewer bytes.
 *
 * @param pages - pages from {@link listPages}.
 * @param topic - free text: a feature name, a symptom, a symbol.
 * @param options - `limit` caps the results (default 3); `tier` overrides the
 * cheap-section names.
 * @returns the matching sections, best first, each with its page and score.
 */
export function rankSections(pages, topic, options = {}) {
  const limit = options.limit ?? 3
  const tier = options.tier ?? TIER1_SECTIONS
  const words = [...new Set(tokenize(topic))]
  if (words.length === 0) return []
  const scored = []
  for (const page of pages) {
    const name = `${page.rel} ${page.title}`.toLowerCase()
    for (const section of splitSections(page.text).sections) {
      const heading = section.heading.toLowerCase()
      const body = section.text.toLowerCase()
      let score = 0
      const matched = new Set()
      for (const word of words) {
        let hit = 0
        if (heading.includes(word)) hit += 4
        if (name.includes(word)) hit += 3
        const occurrences = body.split(word).length - 1
        if (occurrences > 0) hit += Math.min(occurrences, 5)
        if (hit > 0) matched.add(word)
        score += hit
      }
      if (matched.size === 0) continue
      const cheap = tier.some((entry) => heading.startsWith(entry.toLowerCase()))
      scored.push({
        page,
        section,
        score: score + (cheap ? 3 : 0),
        matched: [...matched],
        tier: cheap,
      })
    }
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.section.bytes - b.section.bytes ||
      a.page.rel.localeCompare(b.page.rel) ||
      a.section.index - b.section.index,
  )
  return scored.slice(0, limit)
}

/** Select a page's sections by name, in document order. */
export function selectSections(sections, names) {
  const wanted = names.map((name) => slugify(name)).filter(Boolean)
  return sections
    .filter((section) => wanted.some((w) => section.slug === w || section.slug.startsWith(w)))
    .sort((a, b) => a.index - b.index)
}

/**
 * Resolve one page by map-relative path, file name, or unique substring.
 *
 * @param pages - pages from {@link listPages}.
 * @param query - what the caller asked for.
 * @returns the match, or the candidates when the query is ambiguous.
 */
export function findPage(pages, query) {
  const wanted = String(query ?? '').trim().toLowerCase().replace(/^\.\//, '')
  if (!wanted) return { matches: [] }
  const base = posix.basename(wanted).replace(/\.(md|html?)$/i, '')
  const exact = pages.filter((page) => {
    const name = posix.basename(page.rel).toLowerCase()
    return (
      page.rel.toLowerCase() === wanted ||
      page.rel.toLowerCase() === `${MAP_DIR}/${wanted}` ||
      name === wanted ||
      name.replace(/\.(md|html?)$/i, '') === base
    )
  })
  if (exact.length) return { matches: exact }
  const partial = pages.filter(
    (page) =>
      page.rel.toLowerCase().includes(wanted) || page.title.toLowerCase().includes(wanted),
  )
  return { matches: partial }
}

/**
 * Check that the index and the pages still agree, and how far the map is from
 * the shape the four retrieval levels need.
 *
 * One computation serves both tools: `feature_map_check` renders the drift
 * subset, `feature_map_adopt` renders the migration plan. Two implementations
 * of "is this page conformant" would be two answers that can disagree, and the
 * whole premise of this plugin is that the map is the cheap, true answer.
 *
 * Index links resolve the way markdown resolves them: relative to the index
 * file, not to the project root. A row that points outside `docs/features/`
 * is reported rather than followed — the index is the map's table of contents,
 * and the map is what an agent reads instead of the source.
 *
 * @param root - absolute project root.
 * @param options - `maxSectionBytes` is the size a chunk should fit in
 * (defaults to 2048); `candidates` also lists markdown under `docs/` that is
 * not a page of the map.
 * @returns the index rows and their problems, one finding per page, the
 * sections that outgrew a read and whether they are addressable, and the
 * documents that are not in the map at all.
 */
export async function checkMap(root, options = {}) {
  const index = await readMapIndex(root)
  const indexPath = index.path
  const indexText = index.text
  const mapRoot = join(root, ...MAP_DIR.split('/'))
  const maxSectionBytes = options.maxSectionBytes ?? 2048
  const rows = parseIndexRows(indexText)
  const pages = await listPages(root)
  const linked = new Set()
  const unresolved = []
  for (const row of rows) {
    if (!row.doc) {
      unresolved.push({ row: row.feature, reason: 'the row has no link' })
      continue
    }
    const target = resolve(join(indexPath, '..'), ...row.doc.replace(/^\.\//, '').split('/'))
    const inside = relative(mapRoot, target)
    if (inside.startsWith('..') || isAbsolute(inside)) {
      unresolved.push({ row: row.feature, doc: row.doc, reason: `the link leaves ${MAP_DIR}/` })
      continue
    }
    const exists = await stat(target).then(
      (info) => info.isFile(),
      () => false,
    )
    if (!exists) {
      unresolved.push({ row: row.feature, doc: row.doc, reason: 'the link does not resolve' })
      continue
    }
    linked.add(relative(root, target).split(sep).join(posix.sep))
  }

  const findings = []
  const oversized = []
  const splits = []
  const review = []
  let largest
  for (const page of pages) {
    const { sections } = splitSections(page.text)
    const have = new Set(sections.map((section) => section.heading))
    const status = parseStatusLine(page.text)
    const scan = page.format === 'html' ? scanHtml(page.html) : { verbatimWithoutWhy: [], fromLanguage: [], graphs: 0 }
    if (scan.verbatimWithoutWhy.length || scan.fromLanguage.length) {
      review.push({
        page: page.rel,
        verbatimWithoutWhy: scan.verbatimWithoutWhy.length,
        fromLanguage: scan.fromLanguage.length,
        languages: [...new Set(scan.fromLanguage)],
      })
    }
    const big = []
    for (const section of sections) {
      if (!largest || section.bytes > largest.bytes) {
        largest = { page: page.rel, heading: section.heading, bytes: section.bytes }
      }
      if (section.bytes > maxSectionBytes) {
        const entry = {
          page: page.rel,
          heading: section.heading,
          bytes: section.bytes,
          ...divisibility(section, maxSectionBytes),
        }
        oversized.push(entry)
        big.push(entry)
        if (!entry.addressable) splits.push(entry)
      }
    }
    findings.push({
      rel: page.rel,
      title: page.title,
      format: page.format,
      bytes: Buffer.byteLength(page.text, 'utf8'),
      sections: sections.length,
      missingHeadings: PAGE_HEADINGS.filter((heading) => !have.has(heading)),
      statusLine: Boolean(status),
      trigger: status?.trigger,
      linked: linked.has(page.rel),
      oversized: big,
      graphs: scan.graphs,
    })
  }

  return {
    indexPath,
    indexRel: index.rel,
    indexFormat: index.format,
    legacy: index.legacy,
    indexExists: index.raw !== '',
    rows,
    pages,
    findings,
    unindexed: pages.filter((page) => !linked.has(page.rel)).map((page) => page.rel),
    unresolved,
    untitled: pages.filter((page) => !firstHeading(page.text)).map((page) => page.rel),
    oversized,
    splits,
    review,
    graphs: findings.reduce((total, finding) => total + finding.graphs, 0),
    largest,
    rowsWithoutTrigger: rows.filter((row) => !row.when).length,
    pagesWithoutTrigger: findings.filter((finding) => !finding.trigger).map((finding) => finding.rel),
    candidates: options.candidates ? await docsCandidates(root) : [],
  }
}

/**
 * Cut text to a byte budget on a line boundary, optionally resuming later.
 *
 * The continuation is what makes a budget honest. Truncating and dropping the
 * rest is fine for a reply nobody needs the end of, and wrong for the one
 * section in a real map that is larger than every page but its own: the agent
 * gets a body that stops mid-argument with no way to ask for the remainder. The
 * returned `nextOffset` is the byte position to pass back in, and it always
 * advances — a single line larger than the whole budget is returned whole
 * rather than producing a continuation that never moves.
 *
 * @param text - the text to cap.
 * @param maxBytes - budget in UTF-8 bytes; a non-positive value disables it.
 * @param offset - byte offset to resume from; 0 starts at the beginning.
 * @returns the window, whether anything follows it, and where to resume.
 */
export function capText(text, maxBytes, offset = 0) {
  const value = String(text ?? '')
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0
  const unlimited = !Number.isFinite(maxBytes) || maxBytes <= 0
  const lines = value.split(/\r?\n/)
  const kept = []
  let position = 0
  let used = 0
  let nextOffset
  for (const line of lines) {
    const cost = Buffer.byteLength(line, 'utf8') + 1
    if (position + cost <= start) {
      position += cost
      continue
    }
    if (!unlimited && used + cost > maxBytes) {
      // An over-budget line is kept only when it is the first of the window;
      // otherwise the window would be empty and the offset would never move.
      if (kept.length > 0) {
        nextOffset = position
        break
      }
    }
    kept.push(line)
    used += cost
    position += cost
    if (!unlimited && used >= maxBytes) {
      nextOffset = position
      break
    }
  }
  const truncated = nextOffset !== undefined && nextOffset < Buffer.byteLength(value, 'utf8')
  return {
    text: kept.join('\n'),
    truncated,
    ...(start > 0 ? { offset: start } : {}),
    ...(truncated ? { nextOffset, remainingBytes: Buffer.byteLength(value, 'utf8') - nextOffset } : {}),
  }
}
