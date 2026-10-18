/**
 * The HTML format, the migration and HTML regeneration.
 *
 * Every test that writes goes into the OS temp directory: this plugin ships
 * files that become instructions, and a fixture written inside the repository
 * would be read by the next session working here.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  LEGACY_MAP_INDEX,
  MAP_INDEX,
  checkMap,
  findMapRoot,
  listPages,
  parseIndexRows,
  readMapIndex,
} from '../dist/map.js'
import {
  htmlToMapText,
  markdownToHtmlDocument,
  mermaidToEdges,
  renderMapDocument,
  scanHtml,
} from '../dist/html.js'
import { applyUpgrade, planUpgrade, renderUpgradeText } from '../dist/upgrade.js'
import { applyRegen, planRegen } from '../dist/regen.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..')

/** A map page in canonical text, carrying every construct the reader knows. */
const PAGE_TEXT = [
  '# Widgets — the widget pipeline',
  '',
  'Status: shipped (0.2.0) · Read when: changing the widget pipeline',
  '',
  '## What it does',
  '',
  '- Turns **widgets** into gadgets, with `makeWidget()`.',
  '- See [the map tool](map-tool.html) for the read order.',
  '',
  '## Map',
  '',
  '| Name | Where |',
  '| --- | --- |',
  '| `makeWidget()` | `src/widgets.ts` |',
  '',
  '### The queue',
  '',
  '```pseudo ts',
  'widget → queue → gadget',
  '```',
  '',
  '```verbatim why="the command must run byte for byte"',
  'npm run test',
  '```',
  '',
  '## How & why',
  '',
  'A widget is queued and drained on idle.',
  '',
  '## Config keys / UI',
  '',
  '| Key | Default |',
  '| --- | --- |',
  '| `WIDGET_LIMIT` | `8` |',
  '',
  '## Tests that pin it',
  '',
  '`widgets.test.mjs`: `makes a widget`.',
  '',
  '## Related',
  '',
  '- none',
].join('\n')

/** Write a legacy map into a fresh temp directory. */
async function legacyProject() {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-html-'))
  await mkdir(join(root, 'docs', 'features'), { recursive: true })
  await writeFile(
    join(root, 'docs', 'features', 'README.md'),
    [
      '# demo — features map',
      '',
      '| Feature | Doc | Read when |',
      '| --- | --- | --- |',
      '| Widgets | [widgets.md](widgets.md) | the widget pipeline |',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(root, 'docs', 'features', 'widgets.md'),
    [
      '# Widgets — the pipeline',
      '',
      'Status: shipped (0.2.0) · Read when: the widget pipeline',
      '',
      '## What it does',
      '',
      '- turns widgets into gadgets.',
      '',
      '```ts',
      'const widget = makeWidget()',
      '```',
      '',
      '```text',
      'npm run test',
      '```',
      '',
      '## Map',
      '',
      '- `src/widgets.ts` — `makeWidget()`.',
      '',
    ].join('\n'),
  )
  return root
}

test('markup reads back as the canonical text', () => {
  const html = renderMapDocument({ title: 'Widgets', text: PAGE_TEXT })
  const text = htmlToMapText(html)
  assert.equal(text, PAGE_TEXT, 'the writer and the reader are inverses')
  assert.ok(!text.includes('class='), 'no markup leaks into the text')
  assert.ok(!text.includes(':root{'), 'the stylesheet is not prose')
})

test('a mermaid graph is read as an edge list, not as source', () => {
  const graph = mermaidToEdges(
    ['flowchart LR', '  A[Alpha] -->|yes| B[Beta]', '  B --> C[Gamma]', '  C --- A'].join('\n'),
  )
  assert.ok(graph, 'the graph was parsed')
  assert.equal(graph.edges.length, 3)
  assert.equal(graph.edges[0].from, 'A')
  assert.equal(graph.edges[0].to, 'B')
  assert.equal(graph.edges[0].label, 'yes')
  assert.ok(graph.text.includes('- Alpha → Beta (yes)'))
  assert.ok(graph.text.includes('3 node(s), 3 edge(s)'))

  const page = renderMapDocument({
    title: 'Graph',
    text: '# Graph\n\n```mermaid\nflowchart TD\n  X-->Y\n```',
  })
  const text = htmlToMapText(page)
  assert.ok(text.includes('- X → Y'), 'the page reply carries the edge, not the source')
  assert.ok(text.includes('Graph (flowchart TD)'), 'the graph names its kind')
  assert.ok(!text.includes('X-->Y'), 'and not the graph source')

  assert.equal(mermaidToEdges('this is not a graph'), undefined)
})

test('a Markdown link to a map page becomes HTML, and other files stay Markdown', () => {
  const converted = markdownToHtmlDocument(
    [
      '# T',
      '',
      '- See [the map tool](map-tool.md#what) and [the spec](docs/SPEC.md).',
      '- See [the root README](README.md) and [an external](https://example.com/x.md).',
      '',
      '```md',
      '[inside a fence](map-tool.md)',
      '```',
    ].join('\n'),
  )
  assert.ok(converted.html.includes('href="map-tool.html#what"'))
  assert.ok(converted.html.includes('>the map tool<'), 'the label is prose and stays')
  assert.ok(converted.html.includes('href="docs/SPEC.md"'), 'docs stay Markdown')
  assert.ok(converted.html.includes('href="README.md"'), 'root files stay Markdown')
  assert.ok(converted.html.includes('https://example.com/x.md'), 'external links are untouched')
  assert.ok(converted.html.includes('[inside a fence](map-tool.md)'), 'a fence is not rewritten')
})

test('a converted fence becomes pseudocode and keeps its language', () => {
  const converted = markdownToHtmlDocument(
    ['# T', '', '```ts', 'const x = 1', '```', '', '```text', 'exact bytes', '```', ''].join('\n'),
  )
  assert.ok(converted.html.includes('<pre class="pseudo" data-from-lang="ts">'))
  assert.ok(converted.html.includes('<pre class="verbatim" data-why="TODO: why must these bytes be exact?">'))
  assert.equal(converted.flagged.length, 1)
  assert.equal(converted.flagged[0].lang, 'ts')
  assert.equal(converted.verbatim.length, 1)
})

test('a verbatim block without a reason is reported', () => {
  assert.equal(scanHtml('<pre class="verbatim">x</pre>').verbatimWithoutWhy.length, 1)
  assert.equal(scanHtml('<pre class="verbatim" data-why="the exact bytes matter">x</pre>').verbatimWithoutWhy.length, 0)
})

test('an HTML index is preferred and a same-stem Markdown page is hidden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-html-discovery-'))
  try {
    await mkdir(join(root, 'docs', 'features'), { recursive: true })
    await writeFile(
      join(root, 'docs', 'features', 'index.html'),
      renderMapDocument({
        title: 'demo — features map',
        text: '# demo — features map\n\n| Feature | Doc | Read when |\n| --- | --- | --- |\n| Widgets | [widgets.html](widgets.html) | the widget pipeline |',
        kind: 'index',
      }),
    )
    await writeFile(join(root, 'docs', 'features', 'README.md'), '# legacy\n\n| Feature | Doc | Read when |\n| --- | --- | --- |\n| Widgets | [widgets.md](widgets.md) | old |\n')
    await writeFile(join(root, 'docs', 'features', 'widgets.html'), renderMapDocument({ title: 'Widgets', text: PAGE_TEXT }))
    await writeFile(join(root, 'docs', 'features', 'widgets.md'), PAGE_TEXT)
    await writeFile(join(root, 'docs', 'features', '_partial.html'), '<h1>asset</h1>')

    const found = findMapRoot(root)
    assert.equal(found.indexRel, MAP_INDEX)
    assert.equal(found.format, 'html')
    assert.equal(found.legacy, false)

    const pages = await listPages(root)
    assert.deepEqual(pages.map((page) => page.rel), ['docs/features/widgets.html'])
    assert.equal(pages[0].format, 'html')
    assert.ok(pages[0].text.includes('## What it does'))

    const index = await readMapIndex(root)
    assert.equal(index.format, 'html')
    assert.equal(parseIndexRows(index.text).length, 1)
    assert.ok(index.text.includes('(widgets.html)'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a legacy map is found, read and reported as legacy', async () => {
  const root = await legacyProject()
  try {
    const found = findMapRoot(root)
    assert.equal(found.indexRel, LEGACY_MAP_INDEX)
    assert.equal(found.format, 'markdown')
    assert.equal(found.legacy, true)

    const index = await readMapIndex(root)
    assert.equal(index.legacy, true)
    const report = await checkMap(root)
    assert.equal(report.legacy, true)
    assert.equal(report.rows.length, 1)
    assert.deepEqual(report.unindexed, [])
    assert.equal(report.pages[0].format, 'markdown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a project with no map plans an absent upgrade rather than throwing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-nomap-'))
  const withMap = await legacyProject()
  try {
    const plan = await planUpgrade(root)
    assert.equal(plan.absent, true)
    assert.deepEqual(plan.entries, [])
    // The keys callers read must exist on the absent plan too — the tool reads
    // `flagged.length` and `verbatim.length` before it looks at `absent`.
    assert.deepEqual(Object.keys(plan).sort(), Object.keys(await planUpgrade(withMap)).sort())
    assert.equal(plan.flagged.length, 0)
    assert.equal(plan.verbatim.length, 0)
    assert.ok(renderUpgradeText(plan).includes('no map to convert'))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(withMap, { recursive: true, force: true })
  }
})

test('an upgrade writes siblings and leaves the sources', async () => {
  const root = await legacyProject()
  try {
    const plan = await planUpgrade(root)
    assert.equal(plan.counts.pages, 1)
    assert.equal(plan.counts.writes, 2)
    assert.equal(plan.counts.flagged, 1)
    assert.equal(plan.counts.verbatim, 1)
    assert.ok(plan.entries.every((entry) => entry.status === 'create'))

    const result = await applyUpgrade(plan)
    assert.deepEqual(
      result.written.map((entry) => entry.targetRel).sort(),
      ['docs/features/index.html', 'docs/features/widgets.html'],
    )
    assert.deepEqual(result.removed, [])

    const index = await readFile(join(root, 'docs', 'features', 'index.html'), 'utf8')
    assert.ok(index.includes('href="widgets.html"'), 'the link was rewritten')
    assert.ok(!index.includes('href="widgets.md"'))
    assert.ok((await readdir(join(root, 'docs', 'features'))).includes('widgets.md'), 'the source survives')

    const report = await checkMap(root)
    assert.equal(report.legacy, false)
    assert.equal(report.rows.length, 1)
    assert.deepEqual(report.unresolved, [])
    assert.deepEqual(report.unindexed, [])
    assert.equal(report.pages[0].format, 'html')
    assert.equal(report.findings[0].graphs, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prune removes what it replaced', async () => {
  const root = await legacyProject()
  try {
    const plan = await planUpgrade(root, { prune: true })
    const result = await applyUpgrade(plan)
    assert.equal(result.removed.length, 2)
    const left = await readdir(join(root, 'docs', 'features'))
    assert.ok(!left.includes('widgets.md'))
    assert.ok(!left.includes('README.md'))
    assert.ok(left.includes('widgets.html'))
    assert.ok(left.includes('index.html'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an existing page is not overwritten without force', async () => {
  const root = await legacyProject()
  try {
    const target = join(root, 'docs', 'features', 'widgets.html')
    await writeFile(target, '<!-- keep me -->', 'utf8')
    const plan = await planUpgrade(root)
    const entry = plan.entries.find((candidate) => candidate.targetRel === 'docs/features/widgets.html')
    assert.equal(entry.status, 'exists')

    await applyUpgrade(plan)
    assert.equal(await readFile(target, 'utf8'), '<!-- keep me -->')

    const forced = await planUpgrade(root, { force: true })
    assert.equal(forced.entries.find((candidate) => candidate.targetRel === 'docs/features/widgets.html').status, 'overwrite')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unchanged HTML page is not rewritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-html-regen-'))
  try {
    await mkdir(join(root, 'docs', 'features'), { recursive: true })
    const html = renderMapDocument({ title: 'Widgets', text: PAGE_TEXT })
    await writeFile(join(root, 'docs', 'features', 'widgets.html'), html, 'utf8')
    await writeFile(
      join(root, 'docs', 'features', 'index.html'),
      renderMapDocument({
        title: 'demo',
        text: '# demo\n\n| Feature | Doc | Read when |\n| --- | --- | --- |\n| Widgets | [widgets.html](widgets.html) | changing the widget pipeline |',
        kind: 'index',
      }),
      'utf8',
    )

    const plan = await planRegen(root)
    const page = plan.entries.find((entry) => entry.rel === 'docs/features/widgets.html')
    assert.equal(page.status, 'unchanged')
    assert.equal(page.text, html, 'an unchanged page keeps its original bytes')
    assert.equal(plan.counts.changed, 0)

    const applied = await applyRegen(plan, async () => {
      throw new Error('nothing should be written')
    })
    assert.deepEqual(applied.written, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a changed HTML page is rewritten as HTML', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-html-regen2-'))
  try {
    await mkdir(join(root, 'docs', 'features'), { recursive: true })
    const page = [
      '<!doctype html><html><head><title>Widgets</title></head><body>',
      '<h1>Widgets</h1>',
      '<h2>What it does</h2><ul><li>turns widgets into gadgets.</li></ul>',
      '</body></html>',
    ].join('\n')
    await writeFile(join(root, 'docs', 'features', 'widgets.html'), page, 'utf8')

    const plan = await planRegen(root)
    const entry = plan.entries.find((candidate) => candidate.rel === 'docs/features/widgets.html')
    assert.equal(entry.status, 'changed', 'the missing Status line and headings are added')
    assert.ok(entry.text.startsWith('<!doctype html>'), 'the output is a document')
    assert.ok(entry.text.includes('Status: shipped (vX.Y)'))
    assert.ok(entry.text.includes('<h2>Map</h2>'))

    const applied = await applyRegen(plan, async () => {})
    assert.ok(applied.written.some((candidate) => candidate.rel === 'docs/features/widgets.html'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("this repository's own map is HTML", async () => {
  const found = findMapRoot(repo)
  assert.equal(found.format, 'html')
  assert.equal(found.indexRel, MAP_INDEX)
  const pages = await listPages(repo)
  assert.ok(pages.length >= 7)
  assert.ok(pages.every((page) => page.format === 'html'))
  const report = await checkMap(repo)
  assert.deepEqual(report.unresolved, [])
  assert.deepEqual(report.unindexed, [])
  assert.equal(report.legacy, false)
})
