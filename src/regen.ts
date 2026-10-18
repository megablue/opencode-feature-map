// Ported from the DSH plugin's lib and kept byte-faithful on purpose: its
// behaviour is pinned by the test suite and by scripts/smoke.mjs, not by the
// type checker. The JSDoc in it was written for a runtime that never type
// checked these files, so the annotations infer {} where the code reads
// options; forcing types onto them would churn the port without changing a
// behavior. src/index.ts is the new code and is fully checked.
// @ts-nocheck

/**
 * Rewriting an existing feature map into a shape this plugin can read.
 *
 * The reader in `map.js` hands out one section at a time, which only works when
 * a page carries the documented `##` skeleton and no section is larger than a
 * read. A map written by hand before the workflow existed often has neither, and
 * the missing words are the author's. So everything here is **structure**: the
 * headings are inserted, an oversized section is cut at boundaries the author
 * already wrote, and a chunk that cannot be named from the author's own lead-in
 * gets a visible `<!-- chunk 2/3: name this -->` rather than an invented name.
 *
 * Three properties are load-bearing, and each one is a test:
 *
 * - **Nothing outside a rewritten range changes.** An edit is a line range over
 *   the original line array, so the file's EOL style, a BOM and a missing final
 *   newline all survive.
 * - **No prose is added, removed or reworded.** The single text edit is dropping
 *   the `**` markers around a lead-in that becomes a heading.
 * - **A second run changes nothing.** Every transformation is idempotent, so
 *   running this after the author has named the placeholders is a no-op.
 *
 * @module dsh-feature-map/regen
 */

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'

import {
  LEGACY_MAP_INDEX,
  MAP_DIR,
  MAP_INDEX,
  MAP_INDEX_HTML,
  PAGE_HEADINGS,
  TRIGGER_PLACEHOLDER,
  divisibility,
  firstHeading,
  generateIndexRows,
  listPages,
  parseIndexRows,
  readMapIndex,
  renderIndexRow,
  renderIndexTable,
  splitSubsections,
} from './map.js'

import { renderMapDocument } from './html.js'

/** What each mandated section is for, as a fill-in comment, from the template. */
const SECTION_HINTS = {
  'What it does': '<!-- 3–6 bullets: what it is for. -->',
  Map: '<!-- files, types, functions and test names — the payload. Names, never line numbers. -->',
  'How & why': '<!-- the mechanism, the invariants and the traps. -->',
  'Config keys / UI': '<!-- key, default, range or clamp, and the control that sets it. -->',
  'Tests that pin it': '<!-- the test names to run first. -->',
  Related: '<!-- links to the other feature pages. -->',
}

/** A lead-in longer than this is prose, not a heading. */
const MAX_LEAD_IN = 60

/** Bytes held back per chunk for the `###` heading that has to fit with it. */
const HEADING_RESERVE = 96

/**
 * The line ending a document uses.
 *
 * Detected rather than assumed: a Windows project's map is CRLF, and rewriting
 * one with `\n` would report every line as changed.
 *
 * @param text - the document.
 * @returns `\r\n` or `\n`.
 */
function eolOf(text) {
  const match = /\r?\n/.exec(String(text ?? ''))
  return match ? match[0] : '\n'
}

/** Apply line edits, highest position first so no earlier index is invalidated. */
function applyEdits(lines, edits) {
  const ordered = [...edits].sort((a, b) => b.at - a.at)
  for (const edit of ordered) lines.splice(edit.at, edit.remove ?? 0, ...edit.lines)
  return lines
}

/** Is this line a `##` heading? */
function isSectionHeading(line) {
  return /^##[ \t]/.test(line)
}

/** Is this line a top-level list item? */
function isBullet(line) {
  return /^\s*[-*+] /.test(line)
}

/** The label a page is known by: its title, or its file name. */
function labelOf(page) {
  return page.title || posix.basename(page.rel).replace(/\.(md|html?)$/i, '')
}

/** Where a link in the index points, as an absolute path. */
function targetOf(indexPath, doc) {
  return resolve(dirname(indexPath), ...String(doc).replace(/^\.\//, '').split('/'))
}

/**
 * Does this index row already belong to this page?
 *
 * Path first, then file name, then label: a row is matched on the strongest
 * evidence available, because a page that moved keeps its file name and a row
 * written before a rename keeps its label. Nothing is matched by similarity —
 * a wrong match would rewrite a link that was already right.
 *
 * @param row - a row from {@link parseIndexRows}.
 * @param target - `{ feature, path }`, where `path` is the page's absolute path.
 * @param indexPath - the index file, which links resolve against.
 * @returns whether the row belongs to that page.
 */
function rowMatches(row, target, indexPath) {
  if (row.doc && target.path) {
    if (targetOf(indexPath, row.doc) === target.path) return true
    if (posix.basename(row.doc).toLowerCase() === posix.basename(target.path).toLowerCase()) {
      return true
    }
  }
  const label = String(row.feature ?? '')
    .replace(/\*\*/g, '')
    .trim()
    .toLowerCase()
  return Boolean(label) && label === String(target.feature ?? '').trim().toLowerCase()
}

/** Is this label the first part of that title, cut at a word boundary? */
function labelHeadsTitle(label, title) {
  const head = String(label ?? '').trim().toLowerCase()
  const full = String(title ?? '').trim().toLowerCase()
  if (head.length < 3 || !full.startsWith(head)) return false
  const rest = full.slice(head.length)
  return rest === '' || /^[\s:—–-]/.test(rest)
}

/**
 * Which page a row belongs to, and why not when it belongs to none.
 *
 * The tiers are tried in order of how much they prove: the link's own path, its
 * file name, the row's label, and finally a label that is the first part of a
 * page's title. That last one is what a map written with short labels ("Tray")
 * against long titles ("Tray — the resident process…") needs to keep a
 * hand-written trigger when a link breaks — without it such a row is dropped and
 * replaced, which loses wording a person chose.
 *
 * A tier that matches more than one page matches none: guessing between two
 * owners would rewrite a link that was already right, and the reply can say the
 * row was ambiguous instead.
 *
 * @param row - a row from {@link parseIndexRows}.
 * @param targets - one entry per page, with `taken` marking the ones already used.
 * @param indexPath - the index file, which links resolve against.
 * @returns the matching target, or a reason it could not be decided.
 */
function matchTarget(row, targets, indexPath) {
  const free = targets.filter((target) => !target.taken)
  if (row.doc) {
    const byPath = free.filter(
      (target) => target.path && targetOf(indexPath, row.doc) === target.path,
    )
    if (byPath.length === 1) return { target: byPath[0] }
    const name = posix.basename(row.doc).toLowerCase()
    const byName = free.filter(
      (target) => posix.basename(target.path ?? '').toLowerCase() === name,
    )
    if (byName.length === 1) return { target: byName[0] }
    if (byPath.length > 1 || byName.length > 1) {
      return { reason: 'more than one page answers to that file name' }
    }
  }
  const label = String(row.feature ?? '')
    .replace(/\*\*/g, '')
    .trim()
    .toLowerCase()
  if (label) {
    const byLabel = free.filter(
      (target) => String(target.feature ?? '').trim().toLowerCase() === label,
    )
    if (byLabel.length === 1) return { target: byLabel[0] }
    if (byLabel.length > 1) return { reason: 'more than one page shares that label' }
    const byHead = free.filter((target) => labelHeadsTitle(label, target.feature))
    if (byHead.length === 1) return { target: byHead[0] }
    if (byHead.length > 1) return { reason: 'more than one page title starts with that label' }
  }
  return {}
}

/** Rewrite a row's link target, keeping the label unless it was the old file name. */
function repointLine(line, oldDoc, newDoc) {
  return line.replace(/\[([^\]]*)\]\(([^)]*)\)/, (whole, text, target) => {
    if (target !== oldDoc) return whole
    const label = text === posix.basename(oldDoc) ? posix.basename(newDoc) : text
    return `[${label}](${newDoc})`
  })
}

/**
 * Find the index's own table, and say which one it is.
 *
 * A table block is a run of `|` lines. It is *the map's* table when its header
 * names a feature or when one of its rows already points at a page; anything else
 * is somebody's other table and is left alone. That distinction is why this
 * returns a verdict rather than a range: an index that opens with a table of its
 * own must not have it eaten by a tool that only knows about pages.
 *
 * @param indexText - the index page.
 * @param pages - pages from `listPages`.
 * @param indexPath - absolute path of the index file.
 * @returns `{ status, table?, reason?, count }`, where `status` is `found`,
 * `none` (no table at all) or `foreign` (tables, but none of them the map's).
 */
export function findIndexTable(indexText, pages = [], indexPath = MAP_INDEX) {
  const lines = String(indexText ?? '').split(/\r?\n/)
  const blocks = []
  let start = -1
  for (let index = 0; index <= lines.length; index += 1) {
    const isRow = index < lines.length && lines[index].trim().startsWith('|')
    if (isRow && start < 0) start = index
    if (!isRow && start >= 0) {
      blocks.push({ start, end: index - 1 })
      start = -1
    }
  }
  if (blocks.length === 0) return { status: 'none', count: 0 }

  const targets = pages.map((page) => ({ feature: labelOf(page), path: page.path }))
  const described = blocks.map((block) => {
    const header = lines[block.start]
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    const separator = /^\|[\s:|-]+\|$/.test(lines[block.start + 1]?.trim() ?? '')
    const bodyStart = separator ? block.start + 2 : block.start + 1
    const rows = lines.slice(bodyStart, block.end + 1).flatMap((line) => parseIndexRows(line))
    const namesFeature = /feature/i.test(header[0] ?? '')
    // Only a row that actually *links* something is evidence: a table of names
    // whose first cell happens to read like a page title is somebody else's.
    const linksAPage = rows.some(
      (row) => row.doc && matchTarget(row, targets, indexPath).target,
    )
    return {
      start: block.start,
      end: block.end,
      headerIndex: block.start,
      separatorIndex: separator ? block.start + 1 : undefined,
      bodyStart,
      bodyEnd: block.end,
      columns: header.length,
      qualifying: namesFeature || linksAPage,
      linksAPage,
    }
  })

  const qualifying = described.filter((block) => block.qualifying)
  if (qualifying.length === 1) {
    return { status: 'found', table: qualifying[0], count: blocks.length }
  }
  if (qualifying.length === 0) {
    return {
      status: 'foreign',
      count: blocks.length,
      reason: `the index has ${blocks.length} table(s) and none of them is the map's`,
    }
  }
  const best = qualifying.find((block) => block.linksAPage)
  if (best) return { status: 'found', table: best, count: blocks.length }
  return {
    status: 'foreign',
    count: blocks.length,
    reason: `the index has ${qualifying.length} tables that could be the map's; name the one to rewrite`,
  }
}

/** Insert a freshly rendered table where the index introduces its pages. */
function insertTable(indexText, rows, eol) {
  const text = String(indexText ?? '')
  const lines = text.split(/\r?\n/)
  if (/\r?\n$/.test(text)) lines.pop()
  const firstHeading = lines.findIndex(isSectionHeading)
  const cut = firstHeading >= 0 ? firstHeading : lines.length
  const head = lines.slice(0, cut)
  const tail = lines.slice(cut)
  while (head.length && !head[head.length - 1].trim()) head.pop()
  return [...head, '', ...renderIndexTable(rows).split('\n'), '', ...tail, ''].join(eol)
}

/**
 * Reconcile the index's table with the pages that exist.
 *
 * Not a regeneration: a row that already resolves is emitted byte-identical, in
 * its original position, because the labels and triggers a project wrote are its
 * own editorial work. Measured against a real map, regenerating every cell
 * rewrote 13 of 13 rows of a healthy index; what this adds instead is the row
 * that is missing, a link that no longer resolves, and the removal of a row no
 * page claims.
 *
 * @param indexText - the index page as it stands.
 * @param pages - pages from `listPages`, after any page-level rewrite.
 * @param options - `indexPath`.
 * @returns `{ text, status, counts, changes, reason? }`; `status` is `rewritten`,
 * `unchanged`, `inserted` or `refused`.
 */
function rewriteIndexText(indexText, pages, options = {}) {
  const indexPath = options.indexPath ?? join(...MAP_INDEX.split('/'))
  const eol = eolOf(indexText)
  const counts = { added: 0, repointed: 0, dropped: 0, kept: 0 }
  const found = findIndexTable(indexText, pages, indexPath)

  if (found.status === 'foreign') {
    return { text: indexText, status: 'refused', counts, changes: [], reason: found.reason }
  }
  if (pages.length === 0) {
    return {
      text: indexText,
      status: 'refused',
      counts,
      changes: [],
      reason: 'there are no pages to derive rows from, so a rewrite could only delete rows',
    }
  }

  const generated = generateIndexRows(pages, { indexPath })
  const targets = pages.map((page, position) => ({
    doc: generated[position].doc,
    feature: generated[position].feature,
    when: generated[position].when,
    path: page.path,
  }))

  if (found.status === 'none') {
    counts.added = generated.length
    return {
      text: insertTable(indexText, generated, eol),
      status: 'inserted',
      counts,
      changes: generated.map((row) => ({ kind: 'added', line: renderIndexRow(row) })),
    }
  }

  const table = found.table
  const lines = String(indexText ?? '').split(/\r?\n/)
  const body = []
  for (let index = table.bodyStart; index <= table.bodyEnd; index += 1) {
    const [row] = parseIndexRows(lines[index])
    body.push({ line: lines[index], row })
  }

  const kept = []
  const changes = []
  for (const entry of body) {
    if (!entry.row) {
      kept.push(entry.line)
      continue
    }
    const match = matchTarget(entry.row, targets, indexPath)
    if (!match.target) {
      counts.dropped += 1
      changes.push({ kind: 'dropped', line: entry.line, reason: match.reason })
      continue
    }
    match.target.taken = true
    const line = repointLine(entry.line, entry.row.doc, match.target.doc)
    if (line === entry.line) {
      counts.kept += 1
    } else {
      counts.repointed += 1
      changes.push({ kind: 'repointed', was: entry.line, line })
    }
    kept.push(line)
  }

  const added = targets
    .filter((target) => !target.taken)
    .map((target) => renderIndexRow(target, table.columns))
  for (const line of added) {
    counts.added += 1
    changes.push({ kind: 'added', line })
  }

  const current = lines.slice(table.bodyStart, table.bodyEnd + 1).join(eol)
  if (kept.join(eol) === current) {
    return { text: indexText, status: 'unchanged', counts, changes: [] }
  }
  return {
    text: [...lines.slice(0, table.bodyStart), ...kept, ...added, ...lines.slice(table.bodyEnd + 1)].join(eol),
    status: 'rewritten',
    counts,
    changes,
  }
}

/**
 * Reconcile the index's table, and re-emit it in the index's own format.
 *
 * The table logic above is written against canonical text, which is how the
 * HTML index is read too; a rewritten HTML index is then wrapped back into the
 * document shell. An unchanged index keeps the caller's original bytes —
 * `options.raw` — so a run that found nothing to reconcile does not restyle a
 * page it did not change.
 *
 * @param indexText - the index as canonical text.
 * @param pages - pages from `listPages`.
 * @param options - `indexPath`, `format` (`html` or `markdown`), `raw` and
 * `title`.
 * @returns `{ text, status, counts, changes, reason? }`.
 */
export function rewriteIndexTable(indexText, pages, options = {}) {
  const result = rewriteIndexText(indexText, pages, options)
  if (options.format !== 'html') return result
  if (result.status === 'unchanged') {
    return { ...result, text: options.raw ?? indexText }
  }
  const title = options.title ?? firstHeading(indexText) ?? 'Feature map'
  return { ...result, text: renderMapDocument({ title, text: result.text, kind: 'index' }) }
}

/**
 * Cut one oversized section into chunks an author can name.
 *
 * The units are what the author already separated: a paragraph, or one top-level
 * bullet with its continuation lines. A chunk never cuts inside a unit and never
 * exceeds the budget unless a single unit does, in which case it is reported
 * rather than broken mid-sentence. The first chunk stays under the section's own
 * `##` heading; every later one gets a `###`.
 *
 * @param body - the section's lines, without its `##` heading.
 * @param eol - the document's line ending.
 * @param maxSectionBytes - the budget for one chunk, its heading included.
 * @returns `{ chunks, oversized }`, or `undefined` when it cannot be divided.
 */
function chunkSection(body, eol, maxSectionBytes, headingBytes = 0) {
  const units = []
  let blank = false
  for (const line of body) {
    if (!line.trim()) {
      blank = true
      continue
    }
    const last = units[units.length - 1]
    // A new unit starts at a blank line (a new paragraph) or at a bullet; a
    // paragraph's own continuation lines stay with it, so a unit is never cut.
    if (!last || blank || isBullet(line)) {
      units.push({ separator: units.length ? (blank ? 'blank' : 'tight') : 'tight', lines: [line] })
    } else {
      last.lines.push(line)
    }
    blank = false
  }

  const renderUnits = (group) => {
    const out = []
    group.forEach((unit, index) => {
      if (index > 0 && unit.separator === 'blank') out.push('')
      out.push(...unit.lines)
    })
    return out
  }

  const nameOf = (unit, position, total) => {
    const match = /^\*\*([^*]+)\*\*\s*(.*)$/.exec(unit.lines[0] ?? '')
    if (match) {
      const text = match[1].trim().replace(/[.。]$/, '')
      if (text.length > 0 && text.length <= MAX_LEAD_IN) {
        return { heading: text, rest: match[2], named: true }
      }
    }
    return {
      heading: `<!-- chunk ${position}/${total}: name this -->`,
      rest: undefined,
      named: false,
    }
  }

  const renderChunks = (groups) =>
    groups.map((group, position) => {
      if (position === 0) return { heading: undefined, lines: renderUnits(group), named: false }
      // Numbered over the `###` chunks, because that is all a reader of the map
      // ever sees: the first chunk stays under the section's own `##`.
      const { heading, rest, named } = nameOf(group[0], position, groups.length - 1)
      const adjusted = group.map((unit, index) =>
        index === 0 && rest !== undefined
          ? { ...unit, lines: rest ? [rest, ...unit.lines.slice(1)] : unit.lines.slice(1) }
          : unit,
      )
      return { heading, lines: [`### ${heading}`, '', ...renderUnits(adjusted)], named }
    })

  const pack = () => {
    const groups = []
    let current = []
    for (const unit of units) {
      const candidate = [...current, unit]
      // Every chunk pays for its own heading: the first for the section's own
      // `##` line, each later one for the `###` this tool adds. Budgeting the
      // body alone let a section measure over the limit and still read as one
      // chunk, which is how it got reported as having no boundary to cut at.
      const reserve = groups.length === 0 ? headingBytes : HEADING_RESERVE
      const cost = Buffer.byteLength(renderUnits(candidate).join(eol), 'utf8') + reserve
      if (current.length > 0 && cost > maxSectionBytes) {
        groups.push(current)
        current = [unit]
      } else {
        current = candidate
      }
    }
    groups.push(current)
    return groups
  }

  const costOf = (chunk, index) =>
    Buffer.byteLength(chunk.lines.join(eol), 'utf8') + (index === 0 ? headingBytes : 0)

  let groups = pack()
  // A heading costs bytes, so a chunk that fitted while packing may not fit once
  // it has one. Move its last unit into the next chunk until every chunk fits; a
  // chunk of a single unit is left alone and reported instead.
  for (let guard = 0; guard < 500; guard += 1) {
    const rendered = renderChunks(groups)
    const over = rendered.findIndex((chunk, index) => costOf(chunk, index) > maxSectionBytes)
    if (over < 0) break
    if (groups[over].length < 2) {
      const later = rendered.findIndex(
        (chunk, index) => index > over && costOf(chunk, index) > maxSectionBytes,
      )
      if (later < 0 || groups[later].length < 2) break
      const moved = groups[later].pop()
      groups.splice(later + 1, 0, [moved])
      continue
    }
    const moved = groups[over].pop()
    if (groups[over + 1]) groups[over + 1].unshift(moved)
    else groups.splice(over + 1, 0, [moved])
  }

  const rendered = renderChunks(groups)
  return {
    chunks: rendered,
    oversized: rendered
      .map((chunk, index) => costOf(chunk, index))
      .filter((bytes) => bytes > maxSectionBytes),
  }
}

/**
 * Rewrite one page's skeleton, and divide the sections that outgrew a read.
 *
 * @param page - `{ rel, path, title, text }` from `listPages`.
 * @param context - `{ rows, indexPath, maxSectionBytes }`; `rows` are the index's
 * own rows, which is where a missing trigger is read from.
 * @returns `{ text, status, changes }`; `status` is `changed` or `unchanged`, and
 * every note that needs an author travels in `changes` either way.
 */
export function regeneratePage(page, context = {}) {
  const text = String(page.text ?? '')
  const eol = eolOf(text)
  const maxSectionBytes = context.maxSectionBytes ?? 2048
  const indexPath = context.indexPath ?? join(...MAP_INDEX.split('/'))
  const changes = []
  const lines = text.split(/\r?\n/)
  const headingIndices = lines
    .map((line, index) => (isSectionHeading(line) ? index : -1))
    .filter((index) => index >= 0)

  if (headingIndices.length === 0 && text.trim()) {
    changes.push({
      kind: 'needs-author',
      detail:
        'the page has no `##` headings, and adding empty ones would leave its body in the preamble, where no section search returns it',
    })
    return { text, status: 'unchanged', changes }
  }

  const edits = []
  const titleIndex = lines.findIndex((line) => /^#[ \t]/.test(line))
  const statusIndex = lines.findIndex((line) => /^Status:/.test(line))
  if (titleIndex < 0 || statusIndex < 0) {
    const row = (context.rows ?? []).find(
      (candidate) =>
        matchTarget(candidate, [{ feature: labelOf(page), path: page.path }], indexPath).target,
    )
    const trigger = row?.when?.trim() || TRIGGER_PLACEHOLDER
    const statusLine = `Status: shipped (vX.Y) · Read when: ${trigger}`
    const fromIndex = row?.when?.trim()
      ? 'its trigger taken from the index row for this page'
      : 'with a visible trigger placeholder'
    if (titleIndex < 0) {
      const block = [`# ${labelOf(page)}`, '']
      if (statusIndex < 0) block.push(statusLine, '')
      edits.push({ at: 0, lines: block })
      changes.push({ kind: 'title', detail: `inserted \`# ${labelOf(page)}\`` })
      if (statusIndex < 0) changes.push({ kind: 'status', detail: `inserted a \`Status:\` line ${fromIndex}` })
    } else {
      const at = titleIndex + 1
      const separated = lines[at] === undefined || lines[at].trim() === ''
      edits.push({ at, lines: separated ? [statusLine] : ['', statusLine] })
      changes.push({ kind: 'status', detail: `inserted a \`Status:\` line ${fromIndex}` })
    }
  }

  const present = headingIndices.map((index) => {
    const heading = lines[index].replace(/^##[ \t]+/, '').trim()
    const rank = PAGE_HEADINGS.indexOf(heading)
    return { index, heading, rank: rank < 0 ? PAGE_HEADINGS.length : rank }
  })
  const missing = PAGE_HEADINGS.filter(
    (heading) => !present.some((entry) => entry.heading === heading),
  )
  const insertions = new Map()
  for (const heading of missing) {
    const rank = PAGE_HEADINGS.indexOf(heading)
    const successor = present.find((entry) => entry.rank > rank)
    const limit = successor ? successor.index : lines.length
    let at = limit
    while (at > 0 && lines[at - 1].trim() === '') at -= 1
    const entry = insertions.get(at) ?? { at, remove: limit - at, headings: [] }
    entry.headings.push(heading)
    insertions.set(at, entry)
    changes.push({ kind: 'heading', detail: `inserted \`## ${heading}\` with a fill-in comment` })
  }
  for (const entry of insertions.values()) {
    const block = entry.at === 0 ? [] : ['']
    for (const heading of entry.headings) {
      block.push(`## ${heading}`, '', SECTION_HINTS[heading] ?? '<!-- fill this in -->', '')
    }
    edits.push({ at: entry.at, remove: entry.remove, lines: block })
  }

  const extra = present.filter((entry) => entry.rank === PAGE_HEADINGS.length)
  if (extra.length) {
    changes.push({
      kind: 'note',
      detail: `left where they are: ${extra.map((entry) => `\`## ${entry.heading}\``).join(', ')} — ${
        extra.length === 1 ? 'it is not one' : 'they are not among'
      } the six template headings`,
    })
  }

  for (let position = 0; position < present.length; position += 1) {
    const section = present[position]
    const end = position + 1 < present.length ? present[position + 1].index : lines.length
    const sectionText = lines.slice(section.index, end).join('\n')
    const bytes = Buffer.byteLength(sectionText, 'utf8')
    if (bytes <= maxSectionBytes) continue
    const before = { text: sectionText, heading: section.heading, bytes }
    if (splitSubsections(before).length > 0) {
      const { addressable, largestChunk } = divisibility(before, maxSectionBytes)
      if (!addressable) {
        changes.push({
          kind: 'needs-author',
          detail: `\`## ${section.heading}\` already divides, and its largest \`###\` chunk is ${largestChunk} B — only its author can cut that one`,
        })
      }
      continue
    }
    const boundaries = [...insertions.values()]
      .map((entry) => entry.at)
      .filter((at) => at > section.index)
    // The edit stops where the next edit starts: a heading inserted above the
    // next section already owns the blank run between them, and emitting the
    // separation twice is how a rewritten section grew a blank line.
    const boundary = boundaries.length ? Math.min(end, ...boundaries) : end
    const body = lines.slice(section.index + 1, boundary)
    const chunked = chunkSection(body, eol, maxSectionBytes, Buffer.byteLength(lines[section.index], 'utf8') + eol.length)
    if (chunked.chunks.length < 2) {
      // Nothing to insert: the section's content already fits one chunk. If that
      // single chunk is still over the budget it is one unbreakable paragraph or
      // bullet, and only its author can cut it.
      for (const size of chunked.oversized) {
        changes.push({
          kind: 'needs-author',
          detail: `\`## ${section.heading}\` is ${size} B in a single paragraph or bullet, with no boundary to cut at — it needs an author`,
        })
      }
      continue
    }
    const placeholders = chunked.chunks.filter((chunk) => chunk.heading && !chunk.named)
    const named = chunked.chunks.filter((chunk) => chunk.named).length
    const replacement = []
    chunked.chunks.forEach((chunk, index) => {
      if (index > 0) replacement.push('')
      replacement.push(...chunk.lines)
    })
    edits.push({
      at: section.index + 1,
      remove: body.length,
      lines:
        boundary === end ? ['', ...replacement, ''] : ['', ...replacement],
    })
    changes.push({
      kind: 'split',
      detail: `\`## ${section.heading}\` (${bytes} B) → ${chunked.chunks.length} chunks: ${named} named from a lead-in, ${placeholders.length} placeholder heading(s)`,
      placeholders: placeholders.map((chunk) => chunk.heading),
    })
    for (const size of chunked.oversized) {
      changes.push({
        kind: 'needs-author',
        detail: `\`## ${section.heading}\` has a chunk of ${size} B that no boundary divides — it needs an author`,
      })
    }
  }

  if (edits.length === 0) return { text, status: 'unchanged', changes }
  const next = applyEdits([...lines], edits).join(eol)
  return { text: next, status: next === text ? 'unchanged' : 'changed', changes }
}

/**
 * Plan the rewrite of a whole map: every page, then its index.
 *
 * The index is reconciled against the pages **after** they were rewritten, so a
 * row for a page that just gained a `Status:` line carries the new trigger.
 *
 * @param root - absolute project root.
 * @param options - `maxSectionBytes`.
 * @returns `{ root, indexPath, entries, counts, absent? }`.
 */
export async function planRegen(root, options = {}) {
  const base = resolve(root)
  const mapDir = join(base, ...MAP_DIR.split('/'))
  const maxSectionBytes = options.maxSectionBytes ?? 2048
  const absent = !existsSync(mapDir)
  const index = await readMapIndex(base)
  const indexPath = index.path
  const indexText = index.text
  const pages = absent ? [] : await listPages(base)
  const ownRows = parseIndexRows(indexText)

  const entries = []
  const updated = []
  for (const page of pages) {
    const format = page.format ?? 'markdown'
    const result = regeneratePage(page, { rows: ownRows, indexPath, maxSectionBytes })
    const output =
      format === 'html'
        ? result.status === 'changed'
          ? renderMapDocument({ title: firstHeading(result.text) ?? page.title, text: result.text })
          : page.html ?? result.text
        : result.text
    entries.push({
      rel: page.rel,
      path: page.path,
      format,
      status: result.status,
      changes: result.changes,
      text: output,
      bytes: { before: Buffer.byteLength(page.text, 'utf8'), after: Buffer.byteLength(result.text, 'utf8') },
    })
    updated.push({ ...page, text: result.text, title: firstHeading(result.text) ?? page.title })
  }

  if (absent) {
    return { root: base, indexPath, indexRel: index.rel, entries, absent, counts: emptyCounts(pages.length) }
  }
  if (!index.raw) {
    entries.push({
      rel: index.rel,
      path: indexPath,
      kind: 'index',
      status: 'absent',
      changes: [],
      text: '',
      reason: `there is no \`${MAP_INDEX_HTML}\` (or legacy \`${LEGACY_MAP_INDEX}\`); \`feature_map_adopt\` writes one from the template`,
    })
  } else {
    const result = rewriteIndexTable(indexText, updated, {
      indexPath,
      format: index.format,
      raw: index.raw,
      title: firstHeading(indexText),
    })
    entries.push({
      rel: index.rel,
      path: indexPath,
      kind: 'index',
      format: index.format,
      changes: result.changes,
      bytes: { before: Buffer.byteLength(indexText, 'utf8'), after: Buffer.byteLength(result.text, 'utf8') },
      ...result,
    })
  }

  const splits = entries.flatMap((entry) => entry.changes).filter((change) => change.kind === 'split')
  return {
    root: base,
    indexPath,
    entries,
    counts: {
      pages: pages.length,
      changed: entries.filter((entry) => ['changed', 'rewritten', 'inserted'].includes(entry.status))
        .length,
      splits: splits.length,
      chunks: splits.reduce(
        (total, change) => total + Number(/(\d+) chunks/.exec(change.detail)?.[1] ?? 0),
        0,
      ),
      placeholders: splits.reduce((total, change) => total + (change.placeholders?.length ?? 0), 0),
      indexRows: entries.find((entry) => entry.rel === MAP_INDEX)?.counts,
    },
  }
}

/** The counts of a map that is not there. */
function emptyCounts(pages) {
  return { pages, changed: 0, splits: 0, chunks: 0, placeholders: 0, indexRows: undefined }
}

/**
 * Write a plan produced by {@link planRegen}.
 *
 * The writer is injected, exactly as the scaffold's is, so the write goes through
 * the harness's filesystem seam rather than around it. One file is one
 * `writeText`, so a failure leaves whole files either written or not; what was
 * already written stays written and is reported.
 *
 * @param plan - the plan to apply.
 * @param write - writes one absolute path with its content.
 * @returns the files written, the ones with nothing to do, and the failures.
 */
export async function applyRegen(plan, write) {
  const written = []
  const unchanged = []
  const failed = []
  for (const entry of plan.entries) {
    if (entry.status === 'unchanged' || entry.status === 'absent') {
      unchanged.push(entry)
      continue
    }
    if (entry.status === 'refused') {
      failed.push({ rel: entry.rel, reason: entry.reason ?? 'refused' })
      continue
    }
    try {
      await mkdir(dirname(entry.path), { recursive: true })
      await write(entry.path, entry.text)
      written.push(entry)
    } catch (error) {
      failed.push({ rel: entry.rel, reason: error?.message ?? String(error) })
    }
  }
  return { written, unchanged, failed }
}
