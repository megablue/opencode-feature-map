/**
 * Print what the map reader sees, against whatever directory is passed in.
 *
 * A human- and agent-facing probe, not a test: it asserts nothing and exits 0
 * either way, so it is safe to run against a project whose map is still being
 * written. `node --test` is the gate; this is how you see the numbers.
 *
 * Usage: node scripts/smoke.mjs [project-directory]
 */

import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAP_INDEX, checkMap, findMapRoot, listPages, parseIndexRows, rankPages } from '../dist/map.js'
import { TEMPLATES, TEMPLATE_DIR, planScaffold, templateVariables } from '../dist/templates.js'
import { planRegen } from '../dist/regen.js'
import { readFile } from 'node:fs/promises'

const here = fileURLToPath(new URL('.', import.meta.url))
const target = resolve(process.argv[2] ?? join(here, '..', 'reference', 'PingLatencyOverlay'))

const line = (label, value) => console.log(`${label.padEnd(22)} ${value}`)

console.log(`map probe: ${target}\n`)

const found = findMapRoot(target)
line('map root', found ? found.root : '(none)')
if (!found) {
  console.log(`\nNo ${MAP_INDEX} at or above this directory.`)
} else {
  const indexText = await readFile(found.indexPath, 'utf8').catch(() => '')
  const pages = await listPages(found.root)
  const rows = parseIndexRows(indexText)
  line('index bytes', Buffer.byteLength(indexText, 'utf8'))
  line('index rows', rows.length)
  line('pages', pages.length)

  const report = await checkMap(found.root)
  line('pages unindexed', report.unindexed.length)
  line('rows unresolved', report.unresolved.length)
  line('pages untitled', report.untitled.length)
  line('sections > 2 KB', report.oversized.length)
  if (report.largest) {
    line(
      'largest section',
      `${report.largest.heading} in ${report.largest.page} (${report.largest.bytes} B)`,
    )
  }
  for (const page of report.unindexed) console.log(`  unindexed  ${page}`)
  for (const row of report.unresolved) console.log(`  unresolved ${row.row} → ${row.doc ?? ''}`)
  for (const section of report.oversized) {
    console.log(`  oversized  ${section.page} → ## ${section.heading} (${section.bytes} B)`)
  }

  for (const topic of ['overlay rendering', 'probes', 'config storage', 'theming']) {
    const ranked = rankPages(pages, topic, { limit: 2 })
    line(`topic "${topic}"`, ranked.map((page) => `${page.rel} (${page.score})`).join(', ') || '(no match)')
  }
}

console.log(`\nregen (a plan; writes nothing):`)
const regen = await planRegen(found ? found.root : target, { maxSectionBytes: 2048 })
if (regen.absent) {
  line('  map', `(none — ${regen.root} has no docs/features/)`)
} else {
  line(`  pages`, `${regen.counts.pages} (${regen.counts.changed} would change)`)
  line(
    '  sections',
    `${regen.counts.splits} split into ${regen.counts.chunks} chunk(s), ${regen.counts.placeholders} placeholder heading(s)`,
  )
  if (regen.counts.indexRows) {
    const counts = regen.counts.indexRows
    line(
      '  index rows',
      `${counts.added} added, ${counts.repointed} re-pointed, ${counts.dropped} dropped, ${counts.kept} kept`,
    )
  }
  for (const entry of regen.entries) {
    if (entry.status === 'unchanged') continue
    for (const change of entry.changes) console.log(`  ${entry.rel}  ${change.kind}: ${change.detail}`)
    if (!entry.changes.length && entry.status !== 'absent') {
      console.log(`  ${entry.rel}  ${entry.status}${entry.reason ? `: ${entry.reason}` : ''}`)
    }
  }
}

console.log(`\ntemplates: ${TEMPLATE_DIR}`)
for (const template of TEMPLATES) {
  const plan = await planScaffold({
    root: target,
    only: [template.id],
    variables: templateVariables({ project: 'probe' }),
  })
  const entry = plan.entries[0]
  line(`  ${template.id}`, `${template.source} → ${template.target} (${Buffer.byteLength(entry.content, 'utf8')} bytes)`)
}
