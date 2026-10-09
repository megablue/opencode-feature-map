/**
 * Unit tests for the parts that are pure enough to test without the harness:
 * the map reader and the template writer.
 *
 * The scaffold tests write into the OS temp directory rather than the
 * repository on purpose. This plugin ships a file that becomes `AGENTS.md`,
 * and OpenCode loads instruction files from a project — so a test that
 * scaffolded inside the repository would inject the unsubstituted boilerplate
 * into every session working here. That is the trap this plugin's hard rules
 * exist for, and the test suite must not fall into it either.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  MAP_INDEX,
  TIER1_SECTIONS,
  capText,
  checkMap,
  divisibility,
  findMapRoot,
  findPage,
  generateIndexRows,
  listPages,
  parseIndexRows,
  rankPages,
  rankSections,
  renderIndexTable,
  splitSections,
  splitSubsections,
  tokenize,
} from '../dist/map.js'
import {
  TEMPLATES,
  TEMPLATE_DIR,
  applyScaffold,
  planScaffold,
  substitute,
  templateVariables,
} from '../dist/templates.js'
import { applyRegen, findIndexTable, planRegen, regeneratePage, rewriteIndexTable } from '../dist/regen.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..')
const reference = join(repo, 'reference', 'PingLatencyOverlay')

/** Copy a file or a directory tree, creating parents as needed. */
async function copyTree(from, to) {
  const info = await stat(from)
  if (info.isDirectory()) {
    await mkdir(to, { recursive: true })
    for (const entry of await readdir(from)) await copyTree(join(from, entry), join(to, entry))
  } else {
    await mkdir(join(to, '..'), { recursive: true })
    await copyFile(from, to)
  }
}

test('the shipped boilerplate keeps its .tmpl suffix and never claims an instruction name', async () => {
  for (const template of TEMPLATES) {
    assert.ok(
      template.source.endsWith('.tmpl'),
      `${template.source} must keep the .tmpl suffix so OpenCode does not load it as instructions`,
    )
    assert.notEqual(template.source, 'AGENTS.md')
    assert.notEqual(template.source, 'CLAUDE.md')
  }
  assert.ok(existsSync(TEMPLATE_DIR))
})

test('the reference project is found from a nested directory and not from outside it', () => {
  const found = findMapRoot(join(reference, 'docs'))
  assert.ok(found, 'expected the map root to be found from a subdirectory')
  assert.equal(found.root, reference)
  assert.equal(found.indexPath, join(reference, ...MAP_INDEX.split('/')))
})

test('every reference page is listed once, and the index is not a page', async () => {
  const pages = await listPages(reference)
  assert.ok(pages.length >= 10, `expected the reference map to have pages, got ${pages.length}`)
  assert.ok(!pages.some((page) => page.rel === MAP_INDEX), 'the index must not be listed as a page')
  for (const page of pages) {
    assert.ok(page.title, `${page.rel} should have a title`)
    assert.ok(page.rel.startsWith('docs/features/'), `${page.rel} should be map-relative`)
  }
})

test('the index parses into rows that carry a link', async () => {
  const indexText = await readFile(join(reference, ...MAP_INDEX.split('/')), 'utf8')
  const rows = parseIndexRows(indexText)
  assert.ok(rows.length >= 10, `expected index rows, got ${rows.length}`)
  assert.ok(
    rows.every((row) => row.doc),
    'every row should carry a link target',
  )
  assert.ok(rows.every((row) => !row.feature.startsWith('---')))
})

test('a healthy map agrees with itself', async () => {
  const report = await checkMap(reference)
  assert.deepEqual(report.unindexed, [], 'no page should be missing from the index')
  assert.deepEqual(report.unresolved, [], 'every index link should resolve')
  assert.deepEqual(report.untitled, [], 'every page should have a title')
})

test('a topic finds the page for that area, by name before by mention', async () => {
  const pages = await listPages(reference)
  const glow = rankPages(pages, 'the underglow sweep around the line', { limit: 1 })
  assert.equal(glow[0]?.rel, 'docs/features/overlays/glow.md')
  const probes = rankPages(pages, 'probes icmp cadence', { limit: 1 })
  assert.equal(probes[0]?.rel, 'docs/features/probes.md')
  assert.deepEqual(
    rankPages(pages, 'zzzzq', { limit: 2 }),
    [],
    'a word the map does not contain matches nothing',
  )
})

test('a page is resolved by name, by path and by fragment', async () => {
  const pages = await listPages(reference)
  assert.equal(findPage(pages, 'glow').matches[0]?.rel, 'docs/features/overlays/glow.md')
  assert.equal(findPage(pages, 'glow.md').matches[0]?.rel, 'docs/features/overlays/glow.md')
  assert.equal(
    findPage(pages, 'docs/features/overlays/glow.md').matches[0]?.rel,
    'docs/features/overlays/glow.md',
  )
  assert.equal(findPage(pages, 'nothing-like-this').matches.length, 0)
})

test('tokenize drops the words that identify nothing', () => {
  assert.deepEqual(tokenize('The quick brown fox and the lazy dog'), [
    'quick',
    'brown',
    'fox',
    'lazy',
    'dog',
  ])
})

test('capText cuts on a line boundary and says so', () => {
  const text = Array.from({ length: 200 }, (_value, index) => `line ${index}`).join('\n')
  const capped = capText(text, 100)
  assert.equal(capped.truncated, true)
  assert.ok(capped.text.length < text.length)
  assert.ok(!capped.text.endsWith('\n'), 'a capped body should not end on a dangling newline')
  assert.equal(capText('short', 1000).truncated, false)
  assert.equal(capText(text, 0).truncated, false, 'a non-positive budget disables the cap')
})

test('a placeholder with no value stays visible instead of blanking the document', () => {
  const { text, missing } = substitute('{{PROJECT_NAME}} is {{PROJECT_SUMMARY}}', {
    PROJECT_NAME: 'thing',
  })
  assert.equal(text, 'thing is {{PROJECT_SUMMARY}}')
  assert.deepEqual(missing, ['PROJECT_SUMMARY'])
})

test('the scaffold plans every file, then writes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-'))
  try {
    const plan = await planScaffold({
      root,
      variables: templateVariables({ project: 'scratch-project', summary: 'a scratch project.' }),
    })
    assert.equal(plan.entries.length, TEMPLATES.length)
    assert.deepEqual(plan.missing, [], 'every token should have a value in a full plan')
    assert.ok(
      plan.entries.every((entry) => entry.status === 'create'),
      'a fresh root has nothing to overwrite',
    )
    assert.ok(
      plan.entries.every((entry) => !entry.content.includes('{{')),
      'no token may survive the substitution',
    )

    const writes = []
    const { written, skipped } = await applyScaffold(plan, async (path, content) => {
      writes.push(path)
      await writeFile(path, content, 'utf8')
    })
    assert.equal(written.length, TEMPLATES.length)
    assert.equal(skipped.length, 0)
    assert.equal(writes.length, TEMPLATES.length)

    const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
    assert.ok(agents.includes('scratch-project'), 'the project name should be substituted')
    assert.ok(agents.includes('a scratch project.'))

    const second = await planScaffold({
      root,
      variables: templateVariables({ project: 'scratch-project' }),
    })
    assert.ok(
      second.entries.every((entry) => entry.status === 'exists'),
      'an existing file is left alone without force',
    )
    const forced = await planScaffold({
      root,
      force: true,
      variables: templateVariables({ project: 'scratch-project' }),
    })
    assert.ok(forced.entries.every((entry) => entry.status === 'overwrite'))

    const only = await planScaffold({
      root,
      only: ['feature-map'],
      variables: templateVariables({ project: 'scratch-project' }),
    })
    assert.deepEqual(
      only.entries.map((entry) => entry.target),
      ['docs/features/README.md'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a project with no name and no summary still produces a readable document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-'))
  try {
    const plan = await planScaffold({ root, variables: templateVariables({}) })
    const agents = plan.entries.find((entry) => entry.target === 'AGENTS.md')
    assert.ok(agents.content.includes('this project is'))
    assert.ok(agents.content.includes('one line: what it is'))
    assert.ok(!agents.content.includes('{{'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a page splits on its ## headings, and keeps its preamble apart', () => {
  const text = [
    '# Glow — the underglow',
    '',
    'Status: shipped (0.2) · Read when: the glow',
    '',
    '## What it does',
    '',
    '- Glows.',
    '',
    '## How & why',
    '',
    'Because.',
    '',
  ].join('\n')
  const { preamble, sections } = splitSections(text)
  assert.ok(preamble.startsWith('# Glow'))
  assert.ok(preamble.includes('Status: shipped'))
  assert.deepEqual(
    sections.map((section) => section.heading),
    ['What it does', 'How & why'],
  )
  assert.deepEqual(
    sections.map((section) => section.slug),
    ['what-it-does', 'how-why'],
  )
  assert.ok(sections[0].bytes > 0 && sections[0].bytes < Buffer.byteLength(text, 'utf8'))
  assert.ok(sections[0].text.startsWith('## What it does'))
})

test('a page with no ## headings degrades to one chunk instead of vanishing', () => {
  const text = '# Notes — a page without sections\n\nJust prose, no headings.\n'
  const { preamble, sections } = splitSections(text)
  assert.equal(preamble, '', 'the title line must not be printed twice')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].heading, 'Notes — a page without sections')
  assert.equal(sections[0].slug, 'notes-a-page-without-sections')
  assert.ok(sections[0].text.includes('Just prose'))
  assert.ok(!sections[0].text.startsWith('# '), 'the title travels as the heading, not the body')
})

test('a section splits into its ### subsections, each carrying the section lead', () => {
  const { sections } = splitSections(
    ['# P', '', '## How & why', '', 'The premise.', '', '### First', '', 'One.', '', '### Second', '', 'Two.', ''].join('\n'),
  )
  const subs = splitSubsections(sections[0])
  assert.deepEqual(
    subs.map((sub) => sub.heading),
    ['First', 'Second'],
  )
  assert.ok(subs[0].lead.includes('The premise.'), 'a slice must not arrive without its premise')
  assert.ok(subs[1].text.includes('Two.'))
  assert.deepEqual(splitSubsections({ text: '## Only\n\nNo subsections.\n' }), [])
})

test('a heading beats a mention, and a cheap section beats an equal prose one', () => {
  const pages = [
    {
      rel: 'docs/features/prose.md',
      title: 'Prose',
      text: '# Prose\n\n## How & why\n\nThe widget pipeline drains.\n',
    },
    {
      rel: 'docs/features/names.md',
      title: 'Names',
      text: '# Names\n\n## Map\n\n- the widget pipeline lives in `src/a.js`.\n',
    },
    {
      rel: 'docs/features/heading.md',
      title: 'Heading',
      text: '# Heading\n\n## Widget pipeline\n\nNothing else here.\n',
    },
  ]
  const ranked = rankSections(pages, 'widget pipeline', { limit: 3 })
  assert.equal(
    ranked[0].page.rel,
    'docs/features/heading.md',
    'a heading that carries the topic outranks a body that mentions it',
  )
  assert.equal(
    ranked[1].page.rel,
    'docs/features/names.md',
    'and one mention inside a cheap section outranks the same mention in prose',
  )
  assert.equal(ranked[1].tier, true)
  assert.equal(ranked[2].page.rel, 'docs/features/prose.md')
  assert.equal(ranked[2].tier, false)
  assert.ok(TIER1_SECTIONS.includes('Map'))
})

test('a capped reply can be resumed, and the walk always advances', () => {
  const text = Array.from({ length: 60 }, (_value, index) => `line ${index} of the body`).join('\n')
  const first = capText(text, 200)
  assert.equal(first.truncated, true)
  assert.ok(first.nextOffset > 0)

  let cursor = 0
  let rebuilt = ''
  let windows = 0
  for (; windows < 40; windows += 1) {
    const window = capText(text, 200, cursor)
    rebuilt += (cursor > 0 ? '\n' : '') + window.text
    if (!window.nextOffset) break
    assert.ok(window.nextOffset > cursor, 'a continuation must always advance')
    cursor = window.nextOffset
  }
  assert.ok(windows < 40, 'the walk must terminate')
  assert.equal(rebuilt, text, 'walking the continuation must rebuild the whole body')

  // One line larger than the whole budget: kept whole, so the offset still moves.
  const huge = `x${'y'.repeat(500)}`
  const single = capText(huge, 100)
  assert.equal(single.text, huge)
  assert.equal(single.nextOffset, undefined, 'a single over-budget line ends the walk')
})

test('the reference map reports the sections that outgrew a single read', async () => {
  const report = await checkMap(reference)
  assert.ok(report.oversized.length >= 10, `expected oversized sections, got ${report.oversized.length}`)
  assert.ok(
    report.oversized.every((section) => section.bytes > 2048),
    'only sections past the limit are reported',
  )
  assert.equal(report.largest.page, 'docs/features/runtime.md')
  assert.equal(report.largest.heading, 'How & why')
  assert.ok(
    report.largest.bytes > 10000,
    `the outlier that motivated subsections should still be there, got ${report.largest.bytes}`,
  )
  const runtime = (await listPages(reference)).find((page) => page.rel.endsWith('runtime.md'))
  const how = splitSections(runtime.text).sections.find((section) => section.slug === 'how-why')
  const subs = splitSubsections(how)
  assert.ok(subs.length >= 5, 'and it must still split into subsections')
  assert.ok(
    subs.every((sub) => sub.bytes < report.largest.bytes),
    'every subsection is smaller than the section it came from',
  )
})

test('a section past the limit is judged by how it divides, not by its size', async () => {
  const report = await checkMap(reference)
  const worst = report.oversized.find((section) => section.page.endsWith('runtime.md'))
  assert.equal(worst.chunks, 6, 'the 11 KB section arrives as six `###` chunks')
  assert.ok(worst.largestChunk > 2048 && worst.largestChunk < worst.bytes)
  assert.equal(
    worst.addressable,
    false,
    'one chunk is still over the limit, so it is not yet addressable',
  )
  assert.equal(
    report.splits.length,
    report.oversized.length - 1,
    'exactly one oversized section in the reference map already divides under the limit',
  )
  assert.ok(report.splits.every((section) => !section.addressable))

  const noSubs = { heading: 'How & why', bytes: 3000, text: '## How & why\n\nprose only\n' }
  assert.deepEqual(divisibility(noSubs, 2048), {
    chunks: 1,
    largestChunk: 3000,
    addressable: false,
  })
  const divided = {
    heading: 'How & why',
    bytes: 3000,
    text: '## How & why\n\nlead\n\n### One\n\na\n\n### Two\n\nb\n',
  }
  assert.equal(divisibility(divided, 2048).chunks, 2)
  assert.equal(divisibility(divided, 2048).addressable, true)
})

test('the reference map is conformant, which is what an adopted project should reach', async () => {
  const report = await checkMap(reference, { candidates: true })
  assert.deepEqual(
    report.findings.flatMap((finding) => finding.missingHeadings),
    [],
    'every page carries the six mandated headings',
  )
  assert.deepEqual(report.pagesWithoutTrigger, [], 'and every page carries a trigger')
  assert.equal(report.rowsWithoutTrigger, 0)
  assert.deepEqual(report.unindexed, [])
  assert.deepEqual(report.unresolved, [])
  assert.ok(
    report.candidates.some((candidate) => candidate.rel === 'docs/SPEC.md'),
    'documents outside the map are reported as candidates',
  )
  assert.ok(
    report.candidates.every((candidate) => !candidate.rel.startsWith('docs/features/')),
    'a page of the map is never a candidate',
  )
})

test('a non-conformant page is reported by what it lacks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-adopt-'))
  try {
    await mkdir(join(root, 'docs', 'features'), { recursive: true })
    await writeFile(
      join(root, 'docs', 'features', 'loose.md'),
      '# Loose — a page written by hand\n\n## What it does\n\n- Something.\n\n## How & why\n\nBecause.\n',
      'utf8',
    )
    const report = await checkMap(root)
    const finding = report.findings.find((entry) => entry.rel.endsWith('loose.md'))
    assert.deepEqual(finding.missingHeadings, [
      'Map',
      'Config keys / UI',
      'Tests that pin it',
      'Related',
    ])
    assert.equal(finding.statusLine, false, 'there is no Status/Read-when line to read a trigger from')
    assert.deepEqual(report.pagesWithoutTrigger, ['docs/features/loose.md'])

    const rows = generateIndexRows(report.pages, { indexPath: report.indexPath })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].doc, 'loose.md', 'the link is relative to the index')
    assert.equal(rows[0].when, '', 'a trigger is never invented')
    assert.equal(rows[0].missingTrigger, true)

    const table = renderIndexTable(rows)
    assert.ok(table.includes('[loose.md](loose.md)'))
    assert.ok(table.includes('<!-- the trigger'), 'the gap is left visible, not filled in')
    const parsed = parseIndexRows(table)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].doc, 'loose.md')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('generated rows carry the trigger the page already states', async () => {
  const pages = await listPages(reference)
  const rows = generateIndexRows(pages, { indexPath: join(reference, ...MAP_INDEX.split('/')) })
  assert.equal(rows.length, pages.length)
  assert.ok(
    rows.every((row) => row.when && !row.missingTrigger),
    'every reference page states its trigger',
  )
  const parsed = parseIndexRows(renderIndexTable(rows))
  assert.deepEqual(
    parsed.map((row) => row.doc).sort(),
    rows.map((row) => row.doc).sort(),
    'the generated table parses back into the same links',
  )
  assert.deepEqual(
    rows.filter((row) => row.duplicate),
    [],
    'no two reference pages share a title',
  )
})

/** A page object shaped the way `listPages` returns one. */
function pageOf(root, rel, text) {
  return {
    rel: `docs/features/${rel}`,
    path: join(root, 'docs', 'features', ...rel.split('/')),
    title: /^#[ \t]+(.+)$/m.exec(text)?.[1],
    text,
  }
}

/** A conformant page's other sections, so a fixture only tests what it means to. */
const REST_OF_PAGE = [
  '## Map',
  '',
  '- `src/widgets.js` — `makeWidget()`.',
  '',
  '## Config keys / UI',
  '',
  'None yet.',
  '',
  '## Tests that pin it',
  '',
  '- `widgets.test.mjs`: `makes a widget`.',
  '',
  '## Related',
  '',
  '- none',
  '',
].join('\n')

test('an oversized section is split at paragraph and bullet boundaries and every chunk fits', () => {
  const root = join(tmpdir(), 'feature-map-fixture')
  const text = [
    '# Widgets — the widget pipeline',
    '',
    'Status: shipped (0.1.0) · Read when: the widget pipeline',
    '',
    '## What it does',
    '',
    '- turns widgets into gadgets.',
    '',
    '## How & why',
    '',
    'A first paragraph of its own, short enough to stay under the budget.',
    '',
    '- **A bullet that carries a good number of words so that it is long enough to matter**',
    '- another bullet that also carries a fair number of words, and continues',
    '  onto this line, which belongs to its bullet and must travel with it',
    '- a third bullet',
    '',
    'A closing paragraph with enough words to want a chunk of its own here.',
    '',
    REST_OF_PAGE,
  ].join('\n')
  const result = regeneratePage(pageOf(root, 'widgets.md', text), { maxSectionBytes: 220 })
  assert.equal(result.status, 'changed')
  const after = splitSections(result.text).sections.find((section) => section.heading === 'How & why')
  const chunks = splitSubsections(after)
  assert.ok(chunks.length >= 2, `expected a divided section, got ${chunks.length} chunk(s)`)
  for (const chunk of chunks) {
    assert.ok(chunk.bytes <= 220, `chunk ${chunk.heading} is ${chunk.bytes} B, over the budget`)
  }
  assert.equal(
    divisibility(after, 220).addressable,
    true,
    'the checker must call the rewritten section addressable',
  )
  const continuation = chunks.find((chunk) => chunk.text.includes('another bullet that also'))
  assert.ok(
    continuation.text.includes('onto this line, which belongs to its bullet'),
    'a bullet is never cut from its own continuation lines',
  )
  assert.deepEqual(
    result.text.split('\n').filter((line) => line.trim() && !/^### /.test(line)),
    text.split('\n').filter((line) => line.trim()),
    'no prose line is added, removed or reordered by a split',
  )
})

test('a paragraph-initial bold lead-in becomes the heading and the bold markers go away', () => {
  const root = join(tmpdir(), 'feature-map-fixture')
  const text = [
    '# Widgets',
    '',
    'Status: shipped (0.1.0) · Read when: widgets',
    '',
    '## How & why',
    '',
    'A first paragraph, short.',
    '',
    '**The cast is a sweep, never a widening stroke.** And this is the rest of that paragraph, which is long enough to need its own chunk.',
    '',
    REST_OF_PAGE,
  ].join('\n')
  const result = regeneratePage(pageOf(root, 'widgets.md', text), { maxSectionBytes: 160 })
  assert.equal(result.status, 'changed')
  assert.ok(
    result.text.includes('### The cast is a sweep, never a widening stroke\n'),
    'the author’s own lead-in becomes the heading',
  )
  assert.ok(!result.text.includes('**The cast is a sweep'), 'and the bold markers go with it')
  assert.ok(
    result.text.includes('And this is the rest of that paragraph'),
    'the rest of the paragraph stays, unedited',
  )
})

test('a chunk with no paragraph-initial lead-in gets a visible placeholder heading', () => {
  const root = join(tmpdir(), 'feature-map-fixture')
  const text = [
    '# Widgets',
    '',
    'Status: shipped (0.1.0) · Read when: widgets',
    '',
    '## How & why',
    '',
    'A first paragraph, short.',
    '',
    '- a bullet whose bold sits inside the bullet, so it is not a lead-in',
    '- a second bullet, to push the section past the budget with room to spare',
    '',
  ].join('\n')
  const result = regeneratePage(pageOf(root, 'widgets.md', text), { maxSectionBytes: 140 })
  assert.ok(
    /^### <!-- chunk 1\/\d+: name this -->$/m.test(result.text),
    `expected a visible placeholder heading, got:\n${result.text}`,
  )
})

test('a placeholder split only inserts heading lines and keeps the body byte-for-byte', () => {
  const root = join(tmpdir(), 'feature-map-fixture')
  const section = `${[
    '## How & why',
    '',
    '- a bullet that carries enough words to fill a chunk of its own on its own',
    '- another bullet that carries enough words to want the next chunk',
    '- a third bullet, also long enough to be worth a chunk of its own here',
  ].join('\n')}\n`
  const text = `# Widgets\n\nStatus: shipped (0.1.0) · Read when: widgets\n\n## What it does\n\n- turns widgets into gadgets.\n\n${section}\n${REST_OF_PAGE}\n`
  const result = regeneratePage(pageOf(root, 'widgets.md', text), { maxSectionBytes: 110 })
  assert.equal(result.status, 'changed')
  const after = splitSections(result.text).sections.find((entry) => entry.heading === 'How & why')
  assert.equal(
    after.text.replace(/\n\n### <!-- chunk [^\n]*-->\n\n/g, '\n'),
    section,
    'removing the inserted headings gives back exactly the body that was there',
  )
})

test('a page missing mandated headings gets them with fill-in comments and nothing else moves', () => {
  const root = join(tmpdir(), 'feature-map-fixture')
  const text = [
    '# Widgets — the widget pipeline',
    '',
    'Status: shipped (0.1.0) · Read when: the widget pipeline',
    '',
    '## What it does',
    '',
    '- turns widgets into gadgets.',
    '',
    '## Related',
    '',
    '- none',
    '',
  ].join('\n')
  const result = regeneratePage(pageOf(root, 'widgets.md', text), {})
  assert.equal(result.status, 'changed')
  const headings = splitSections(result.text).sections.map((section) => section.heading)
  assert.deepEqual(headings, [
    'What it does',
    'Map',
    'How & why',
    'Config keys / UI',
    'Tests that pin it',
    'Related',
  ])
  for (const heading of ['Map', 'How & why', 'Config keys / UI', 'Tests that pin it']) {
    assert.ok(result.text.includes(`## ${heading}`), `${heading} must be inserted`)
  }
  assert.ok(result.text.includes('<!--'), 'an inserted section says what it is for')
  assert.ok(result.text.includes('- turns widgets into gadgets.'), 'and no content is lost')
  assert.ok(
    result.text.startsWith(`# Widgets — the widget pipeline\n\nStatus: shipped (0.1.0)`),
    'the title and status line are untouched',
  )
})

test('a missing Status line is filled from the index row that links the page', () => {
  const root = join(tmpdir(), 'feature-map-fixture')
  const indexPath = join(root, ...MAP_INDEX.split('/'))
  const rows = parseIndexRows(
    [
      '| Feature | Doc | Read when |',
      '| --- | --- | --- |',
      '| Widgets | [widgets.md](widgets.md) | the widget pipeline, `widgets.rs` |',
      '',
    ].join('\n'),
  )
  const result = regeneratePage(
    pageOf(root, 'widgets.md', '# Widgets\n\n## What it does\n\n- turns widgets into gadgets.\n'),
    { rows, indexPath },
  )
  assert.ok(
    result.text.includes('Status: shipped (vX.Y) · Read when: the widget pipeline, `widgets.rs`'),
    `expected the index row's trigger in the status line, got:\n${result.text}`,
  )
  assert.ok(result.text.includes('## What it does'), 'and the body is still there')
})

test('an unnameable oversized chunk is reported and never split mid-sentence', () => {
  const root = join(tmpdir(), 'feature-map-fixture')
  const paragraph = `One very long paragraph, ${'with more words '.repeat(40)}and an end.`
  const text = `# Widgets\n\nStatus: shipped (0.1.0) · Read when: widgets\n\n## What it does\n\n- turns widgets into gadgets.\n\n## How & why\n\n${paragraph}\n\n${REST_OF_PAGE}\n`
  const result = regeneratePage(pageOf(root, 'widgets.md', text), { maxSectionBytes: 200 })
  assert.equal(result.status, 'unchanged', 'a section with no boundary is left exactly as it is')
  assert.equal(result.text, text)
  assert.ok(
    result.changes.some((change) => change.kind === 'needs-author'),
    'and it is reported as needing an author',
  )
})

test('regenerating twice changes nothing the second time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-regen-'))
  try {
    await mkdir(join(root, 'docs', 'features'), { recursive: true })
    await writeFile(
      join(root, 'docs', 'features', 'widgets.md'),
      [
        '# Widgets — the widget pipeline',
        '',
        '## What it does',
        '',
        '- turns widgets into gadgets.',
        '',
        '## How & why',
        '',
        '- a bullet that carries enough words to want a chunk of its own here',
        '- another bullet that carries enough words to want the next one',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      join(root, 'docs', 'features', 'README.md'),
      [
        '# Widgets — features map',
        '',
        '| Feature | Doc | Read when |',
        '| --- | --- | --- |',
        '| Gone | [gone.md](gone.md) | a page that was deleted |',
        '',
      ].join('\n'),
      'utf8',
    )

    const first = await planRegen(root, { maxSectionBytes: 150 })
    assert.ok(
      first.entries.some((entry) => entry.status === 'changed'),
      'the page needs work: no status line, no Map section, a section past the budget',
    )
    assert.equal(first.entries.at(-1).status, 'rewritten', 'the index drops the orphan row')
    const { written, failed } = await applyRegen(first, async (path, content) => {
      await writeFile(path, content, 'utf8')
    })
    assert.deepEqual(failed, [])
    assert.ok(written.length >= 2, 'the page and the index are both written')

    const second = await planRegen(root, { maxSectionBytes: 150 })
    assert.ok(
      second.entries.every((entry) => entry.status === 'unchanged'),
      `a second run must change nothing, got ${JSON.stringify(
        second.entries.map((entry) => [entry.rel, entry.status]),
      )}`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the index is reconciled: rows appended, broken links re-pointed, orphans dropped, matched rows untouched', () => {
  const root = join(tmpdir(), 'feature-map-fixture')
  const indexPath = join(root, ...MAP_INDEX.split('/'))
  const indexText = [
    '# Widgets — features map',
    '',
    'Read this before touching code.',
    '',
    '| Feature | Doc | Read when |',
    '| --- | --- | --- |',
    '| Widgets | [widgets.md](widgets.md) | the widget pipeline |',
    '| Gadgets | [old-gadgets.md](old-gadgets.md) | the gadget pipeline |',
    '| Gone | [gone.md](gone.md) | a page that was deleted |',
    '',
  ].join('\n')
  const pages = [
    pageOf(root, 'widgets.md', '# Widgets\n\nStatus: shipped (0.1.0) · Read when: the widget pipeline\n'),
    pageOf(root, 'gadgets.md', '# Gadgets\n\nStatus: shipped (0.1.0) · Read when: the gadget pipeline\n'),
    pageOf(root, 'extras.md', '# Extras\n\nStatus: shipped (0.1.0) · Read when: the extras\n'),
  ]
  const result = rewriteIndexTable(indexText, pages, { indexPath })
  assert.equal(result.status, 'rewritten')
  assert.deepEqual(result.counts, { added: 1, repointed: 1, dropped: 1, kept: 1 })
  assert.ok(
    result.text.includes('| Widgets | [widgets.md](widgets.md) | the widget pipeline |'),
    'a row that resolves is emitted exactly as the project wrote it',
  )
  assert.ok(
    result.text.includes('| Gadgets | [gadgets.md](gadgets.md) | the gadget pipeline |'),
    'a row whose link no longer resolves is re-pointed, keeping its trigger',
  )
  assert.ok(!result.text.includes('gone.md'), 'a row no page claims is dropped')
  assert.ok(
    result.text.includes('| Extras | [extras.md](extras.md) | the extras |'),
    'a page with no row is appended, with the trigger its status line states',
  )
  assert.ok(result.text.startsWith('# Widgets — features map\n\nRead this before touching code.'))

  const again = rewriteIndexTable(result.text, pages, { indexPath })
  assert.equal(again.status, 'unchanged', 'reconciling a reconciled index is a no-op')
  assert.equal(again.text, result.text)
})

test('a broken link whose label heads the page title is re-pointed, and an ambiguous one is dropped', () => {
  const root = join(tmpdir(), 'feature-map-fixture')
  const indexPath = join(root, ...MAP_INDEX.split('/'))
  const indexText = [
    '# Map',
    '',
    '| Feature | Doc | Read when |',
    '| --- | --- | --- |',
    '| Tray | [old-tray.md](old-tray.md) | tray icon and menu |',
    '',
  ].join('\n')

  // The long title a short label belongs to: the row keeps the trigger its
  // author wrote instead of being dropped and replaced by a generated one.
  const one = rewriteIndexTable(
    indexText,
    [pageOf(root, 'tray.md', '# Tray — the resident process\n\nStatus: shipped (0.1.0) · Read when: the tray\n')],
    { indexPath },
  )
  assert.equal(one.status, 'rewritten')
  assert.deepEqual(one.counts, { added: 0, repointed: 1, dropped: 0, kept: 0 })
  assert.ok(
    one.text.includes('| Tray | [tray.md](tray.md) | tray icon and menu |'),
    `expected a re-pointed row that kept its trigger, got:\n${one.text}`,
  )

  // Two pages the label could belong to: neither is guessed at.
  const two = rewriteIndexTable(
    indexText,
    [
      pageOf(root, 'tray.md', '# Tray — the resident process\n\nStatus: shipped (0.1.0) · Read when: a\n'),
      pageOf(root, 'tray-two.md', '# Tray — the other one\n\nStatus: shipped (0.1.0) · Read when: b\n'),
    ],
    { indexPath },
  )
  const dropped = two.changes.filter((change) => change.kind === 'dropped')
  assert.equal(dropped.length, 1)
  assert.ok(
    dropped[0].reason.includes('more than one page title starts with that label'),
    `expected an ambiguity reason, got: ${dropped[0].reason}`,
  )
})

test('a foreign table is refused, and the pages are rewritten anyway', () => {
  const root = join(tmpdir(), 'feature-map-fixture')
  const indexPath = join(root, ...MAP_INDEX.split('/'))
  const indexText = [
    '# Map',
    '',
    '| Name | Purpose |',
    '| --- | --- |',
    '| Widgets | somewhere else entirely |',
    '',
    '## Notes',
    '',
  ].join('\n')
  const found = findIndexTable(indexText, [], indexPath)
  assert.equal(found.status, 'foreign', 'a table that is not the map\u2019s is not touched')
  const pages = [pageOf(root, 'widgets.md', '# Widgets\n\nStatus: shipped (0.1.0) · Read when: w\n')]
  const result = rewriteIndexTable(indexText, pages, { indexPath })
  assert.equal(result.status, 'refused')
  assert.equal(result.text, indexText, 'a refused index is returned byte-for-byte unchanged')
  assert.ok(result.reason.includes('none of them is the map'), `got: ${result.reason}`)
})

/**
 * The template directory is resolved from the package root, not from a fixed
 * relative hop.
 *
 * An installed copy is not guaranteed to keep the built layout: OpenCode's
 * loader was observed resolving a plugin entry to a flattened root index.js,
 * and a module at the package root then resolved ../templates/ one directory
 * above the package — every feature_map_init and feature_map_adopt call died
 * on an ENOENT for AGENTS.md.tmpl. Both layouts must work, so both are
 * pinned here.
 */

test('the built module resolves its templates from the package root', async () => {
  assert.equal(TEMPLATE_DIR, join(repo, 'templates'), 'dist/templates.js finds the package root')
  assert.ok(existsSync(join(TEMPLATE_DIR, 'AGENTS.md.tmpl')))
})

test('a flattened install finds its templates from the package root too', async () => {
  // Simulate the observed install: the built module copied to the package
  // root, beside the manifest and the templates directory.
  const flat = await mkdtemp(join(tmpdir(), 'fm-flat-'))
  try {
    await writeFile(join(flat, 'templates.js'), await readFile(join(repo, 'dist', 'templates.js'), 'utf8'))
    await writeFile(join(flat, 'package.json'), await readFile(join(repo, 'package.json'), 'utf8'))
    await mkdir(join(flat, 'templates', 'docs', 'features'), { recursive: true })
    await copyTree(join(repo, 'templates'), join(flat, 'templates'))

    const flattened = await import(pathToFileURL(join(flat, 'templates.js')).href)
    assert.equal(
      flattened.TEMPLATE_DIR,
      join(flat, 'templates'),
      'a module at the package root finds templates beside the manifest, not above it',
    )
    const body = await flattened.readTemplate('AGENTS.md.tmpl')
    assert.ok(body.includes('process and hard rules'), 'the template body is readable')
    const plan = await flattened.planScaffold({ root: flat, variables: flattened.templateVariables({}) })
    assert.equal(plan.entries.length, 4, 'the scaffold still plans every file')
  } finally {
    await rm(flat, { recursive: true, force: true })
  }
})
