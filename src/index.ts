/**
 * opencode-feature-map — a project's feature map as the first stop before its
 * source, as an OpenCode 2 plugin.
 *
 * Four contributions, and the fourth is what makes the first three stick:
 *
 * 1. a system-prompt section stating the read order (map, then code);
 * 2. the `feature_map` tool, which returns the index and the sections for a
 *    topic for a fraction of what searching the source costs — plus
 *    `feature_map_init`, which hands over the boilerplate for a project that
 *    has no map yet, `feature_map_adopt`, which brings an existing project's
 *    documentation up to it, and `feature_map_check`, which reports where the
 *    index and the pages have drifted apart;
 * 3. `feature_map_regen`, which rewrites a map that has outgrown the shape the
 *    reader needs, dividing the long sections and marking the headings only an
 *    author can name; and `feature_map_upgrade`, which writes the HTML siblings
 *    of a legacy Markdown map without deleting the sources;
 * 4. a permission guard that denies the first source lookup of a session with
 *    the instruction that clears it.
 *
 * The guard denies exactly once per session and its own message is the remedy,
 * so it cannot deadlock a session: a second attempt always proceeds, a session
 * with no map is never nagged, and a session that never looks at fs tools never
 * sees the guard fire at all.
 *
 * @module opencode-feature-map
 *
 * The tool schemas are plain JSON Schema objects cast at registration: the
 * OpenCode plugin API accepts JSON Schema through its schema types, and
 * importing those types directly would add a second package to keep in
 * lockstep with the plugin. One dependency, resolved through it at runtime.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { Plugin } from '@opencode/plugin'

import {
  LEGACY_MAP_INDEX,
  MAP_DIR,
  MAP_INDEX,
  MAP_INDEX_HTML,
  TIER1_SECTIONS,
  capText,
  checkMap,
  findMapRoot,
  findPage,
  findSection,
  findSubsection,
  generateIndexRows,
  listPages,
  parseIndexRows,
  rankPages,
  rankSections,
  readMapIndex,
  renderIndexHtmlTable,
  renderIndexTable,
  selectSections,
  splitSections,
  splitSubsections,
} from './map.js'
import {
  applyScaffold,
  missingBlocks,
  planScaffold,
  readTemplate,
  templateVariables,
} from './templates.js'
import { applyRegen, planRegen } from './regen.js'
import { applyUpgrade, planUpgrade, renderUpgradeText } from './upgrade.js'

/**
 * Plugin id, as loader diagnostics and the command registry see it.
 *
 * OpenCode owns registration, ordering and prompt placement — a plugin
 * registers its section for every model request rather than at a section
 * order — so there is no service list and no slot table to keep in step.
 */
const PLUGIN_ID = 'feature-map'

/** The section text. Static, so a provider cache sees the same bytes all session. */
const SECTION_TEXT = `Work from the project's feature map before the source. \`docs/features/\` holds one page per feature — its files, types, tests and traps — and \`docs/features/index.html\` is the index (a legacy \`README.md\` is still read; \`feature_map_upgrade\` converts it). Call \`feature_map\` first: with a \`topic\` it returns the sections that name the files, functions and tests for that area, not the whole page; add \`page\` and \`section\` for one section, or \`full: true\` when the mechanism itself is the question. Read the map before grepping or opening source in the area; when it does not cover something you worked out, write that section in the same commit — and keep a section under about two kilobytes, because a section is what a later session reads on its own. Pages are HTML: \`<pre class="pseudo">\` is the default for a code-shaped block, \`<pre class="verbatim" data-why="…">\` is only for bytes that must not change, and \`<pre class="mermaid">\` draws a graph the tool reduces to an edge list. \`feature_map_init\` hands the whole set to a project that has none; \`feature_map_upgrade\` converts a Markdown map to HTML; \`feature_map_regen\` rewrites a map that has outgrown that shape, dividing the long sections and marking the headings only you can name; \`feature_map_check\` reports drift, and the sections that have outgrown a single read.`

/** The line a legacy map's every reply carries until it is converted. */
const LEGACY_NOTICE = `[legacy map — \`${LEGACY_MAP_INDEX}\` is still Markdown. It reads normally; \`feature_map_upgrade\` writes the same pages as HTML, leaving the \`.md\` files in place.]`

/** Instruction files a session may always read: they are how a project talks. */
const DEFAULT_EXEMPT = ['docs/', 'AGENTS.md', 'CLAUDE.md', 'HANDOFF.md', 'README.md']

/**
 * Configuration defaults, and the contract OpenCode passes in as plugin
 * options.
 *
 * Declared as a plain object rather than through a schema library on purpose:
 * the plugin declares one dependency, and a config schema that disagreed with
 * the running OpenCode would be a plugin that fails to load. Every value is
 * checked in {@link resolveConfig} instead, and an unrecognised `mode` falls
 * back to the strict one rather than to no rule.
 *
 * `sectionOrder` from the DSH shape is gone: OpenCode pushes the section onto
 * every model request's system instructions, so there is no slot table for the
 * section to sit next to the read tool in.
 */
const DEFAULT_CONFIG = {
  mode: 'enforce',
  sourceTools: ['read', 'grep', 'glob'],
  exemptPaths: DEFAULT_EXEMPT,
  maxBytes: 12000,
  sectionsPerTopic: 3,
  maxSectionBytes: 2048,
}

/**
 * Normalize configuration, keeping only the modes this plugin implements.
 *
 * @param config - the loader-supplied configuration.
 * @returns a complete configuration with a known `mode`.
 */
function resolveConfig(config) {
  const mode = ['enforce', 'prompt', 'off'].includes(config.mode)
    ? config.mode
    : DEFAULT_CONFIG.mode
  return {
    mode,
    sourceTools: config.sourceTools?.length ? config.sourceTools : DEFAULT_CONFIG.sourceTools,
    exemptPaths: config.exemptPaths?.length ? config.exemptPaths : DEFAULT_CONFIG.exemptPaths,
    maxBytes: Number.isFinite(config.maxBytes) ? config.maxBytes : DEFAULT_CONFIG.maxBytes,
    sectionsPerTopic: Number.isFinite(config.sectionsPerTopic)
      ? config.sectionsPerTopic
      : DEFAULT_CONFIG.sectionsPerTopic,
    maxSectionBytes: Number.isFinite(config.maxSectionBytes)
      ? config.maxSectionBytes
      : DEFAULT_CONFIG.maxSectionBytes,
  }
}

/**
 * Is this permission check a lookup in the project's source?
 *
 * A check outside the project, under `docs/`, at one of the instruction files,
 * or on a path that does not exist is not: the first three are how a session
 * talks to a project, and nagging about a missing file teaches nothing.
 *
 * The action decides what its resource is, and they do not agree: `read`
 * carries a path, `glob` carries a pattern whose head is a path, and `grep`
 * carries the regular expression with no location at all. A grep is therefore
 * always a source lookup — it is the whole-project hunt the map exists to
 * avoid — while `read` and `glob` are judged by where they point. That
 * asymmetry is deliberate and documented: the alternative is a guard that
 * cannot see where a grep searches.
 *
 * @param root - the project root that owns the map.
 * @param action - the permission action (`read`, `glob` or `grep`).
 * @param resources - the values the tool asked to act on.
 * @param exempt - configured path prefixes.
 * @returns the offending path or pattern for the message, or `undefined` to allow.
 */
function guardLookup(root, action, resources, exempt) {
  const resource = Array.isArray(resources) ? resources[0] : undefined
  if (typeof resource !== 'string' || !resource) return undefined
  if (action === 'grep') return resource
  // A glob pattern's path head is everything before its first wildcard
  // segment: `docs/**` and `docs/*.md` are lookups in `docs/`.
  const path =
    action === 'glob'
      ? resource
          .split('/')
          .filter((segment) => !/[*?]/.test(segment))
          .join('/')
      : resource
  if (!path) return undefined
  const absolute = isAbsolute(path) ? path : resolve(root, path)
  const rel = relative(root, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const posix = rel.split(sep).join('/')
  if (exempt.some((prefix) => posix === prefix || posix.startsWith(prefix))) return undefined
  // A glob need not name something that exists; reading a missing file teaches
  // nothing, so it is not nagged about.
  if (action !== 'glob' && !existsSync(absolute)) return undefined
  return posix
}

/** The denial message: the rule, the remedy, and the fact that it is the only ask. */
function denialText(tool, path) {
  return `${tool} "${path}" reads source in a project that keeps a feature map. Call feature_map first — add \`topic\` if you know the area, otherwise it returns the index — and read the sections for that area: they name the files, functions and tests, which is cheaper than searching for them. This is the only time this session will ask; call ${tool} again and it will proceed.`
}

/** A page's shape: its sections, their sizes, and how to ask for one. */
function skeletonText(page, sections) {
  const bytes = Buffer.byteLength(page.text, 'utf8')
  const lines = sections.map((section) => `- \`## ${section.heading}\` — ${section.bytes} B`)
  return `# ${page.rel} — ${page.title}\n${bytes} B in ${sections.length} section(s):\n${lines.join('\n')}\n\nAsk for one with page:"${page.rel}" section:"<heading>"${
    sections.some((section) => splitSubsections(section).length)
      ? ' (add sub:"<heading>" for a `###` inside it)'
      : ''
  }, or all of it with full:true.`
}

/** The line that names what was left out, and the call that gets it. */
function omittedLines(page, returned, omitted, limit = 3) {
  const rest = omitted.slice(0, limit)
  if (rest.length === 0) return ''
  const names = rest
    .map((section) => `\`## ${section.heading}\` (${section.bytes} B)`)
    .join(', ')
  const more = omitted.length > rest.length ? `, +${omitted.length - rest.length} more` : ''
  return `Not returned from \`${page.rel}\`: ${names}${more} — ask with page:"${page.rel}" section:"<heading>".`
}

/** The line that says where a capped reply resumes. */
function continuationLine(options, nextOffset) {
  const ask = [
    options.page ? `page:"${options.page}"` : undefined,
    options.topic ? `topic:"${options.topic}"` : undefined,
    options.section ? `section:"${options.section}"` : undefined,
    options.sub ? `sub:"${options.sub}"` : undefined,
    options.full ? 'full:true' : undefined,
  ].filter(Boolean)
  return `\n\n[budget reached — call feature_map again with offset:${nextOffset}${
    ask.length ? ` and ${ask.join(' ')}` : ''
  }]`
}

/**
 * Render one reply, at the coarsest level that answers the call.
 *
 * Four levels, and each one names the call that reaches the next: the index
 * (no arguments), the sections for a topic, a page's section list, and one
 * section — or the whole page when it is asked for by name. The default is the
 * cheap end because a mechanical change needs the names, the files and the
 * tests, and the prose that explains them is where a page's bytes are.
 */
function renderMapReply(root, indexText, pages, options) {
  const rows = parseIndexRows(indexText)
  const pageList = pages.map((page) => `- \`${page.rel}\` — ${page.title}`).join('\n')

  if (options.page) {
    const found = findPage(pages, options.page)
    if (found.matches.length === 0) {
      return {
        kind: 'missing-page',
        text: `No page in \`${MAP_DIR}/\` matches "${options.page}". Pages:\n${pageList}`,
      }
    }
    if (found.matches.length > 1) {
      return {
        kind: 'ambiguous-page',
        text: `"${options.page}" matches ${found.matches.length} pages; name one:\n${found.matches
          .map((page) => `- \`${page.rel}\` — ${page.title}`)
          .join('\n')}`,
      }
    }
    const page = found.matches[0]
    const { preamble, sections } = splitSections(page.text)

    if (options.full) {
      const capped = capText(page.text, options.maxBytes, options.offset)
      return {
        kind: 'page',
        page: page.rel,
        text: `# ${page.rel}\n\n${capped.text}${capped.truncated ? continuationLine(options, capped.nextOffset) : ''}`,
        pages: [page.rel],
        ...(capped.truncated ? { nextOffset: capped.nextOffset } : {}),
      }
    }

    if (options.section) {
      const hit = findSection(sections, options.section)
      if (hit.matches.length === 0) {
        return {
          kind: 'missing-section',
          page: page.rel,
          text: `\`${page.rel}\` has no section matching "${options.section}". Its sections:\n${sections
            .map((section) => `- \`## ${section.heading}\` — ${section.bytes} B`)
            .join('\n')}`,
        }
      }
      if (hit.matches.length > 1) {
        return {
          kind: 'ambiguous-section',
          page: page.rel,
          text: `"${options.section}" matches ${hit.matches.length} sections of \`${page.rel}\`: ${hit.matches
            .map((section) => `\`## ${section.heading}\``)
            .join(', ')}`,
        }
      }
      const section = hit.matches[0]
      let body = section.text
      let label = `${page.rel}#${section.slug}`

      if (options.sub) {
        const subs = splitSubsections(section)
        const subHit = findSubsection(subs, options.sub)
        if (subHit.matches.length === 0) {
          return {
            kind: 'missing-subsection',
            page: page.rel,
            section: section.heading,
            text: subs.length
              ? `\`## ${section.heading}\` has no \`###\` matching "${options.sub}". Inside it:\n${subs
                  .map((sub) => `- \`### ${sub.heading}\` — ${sub.bytes} B`)
                  .join('\n')}`
              : `\`## ${section.heading}\` has no \`###\` subsections; ask for the whole section instead.`,
          }
        }
        if (subHit.matches.length > 1) {
          return {
            kind: 'ambiguous-subsection',
            page: page.rel,
            section: section.heading,
            text: `"${options.sub}" matches ${subHit.matches.length} subsections: ${subHit.matches
              .map((sub) => `\`### ${sub.heading}\``)
              .join(', ')}`,
          }
        }
        const sub = subHit.matches[0]
        // The section's own lead travels with the slice, so a subsection never
        // arrives without the premise it was written under.
        body = `${sub.lead}${sub.text}`
        label = `${page.rel}#${section.slug}#${sub.slug}`
      }

      // No summary is prepended here. The safety net belongs to a *guessed*
      // section — one the ranker chose for a topic — not to one the caller
      // named: naming a section means the page is already known, and the
      // preamble above carries its title and status line.
      const capped = capText(`${preamble}\n\n${body}`, options.maxBytes, options.offset)
      const omitted = sections.filter((entry) => entry.slug !== section.slug)
      return {
        kind: options.sub ? 'subsection' : 'section',
        page: page.rel,
        section: section.heading,
        text: `${capped.text}${capped.truncated ? continuationLine(options, capped.nextOffset) : ''}\n\n${omittedLines(page, [section], omitted)}`.trimEnd(),
        pages: [page.rel],
        sections: [label],
        ...(omitted.length ? { omitted: omitted.map((entry) => `## ${entry.heading}`) } : {}),
        ...(capped.truncated ? { nextOffset: capped.nextOffset } : {}),
      }
    }

    return {
      kind: 'skeleton',
      page: page.rel,
      text: skeletonText(page, sections),
      pages: [page.rel],
      sections: sections.map((section) => `${page.rel}#${section.slug}`),
    }
  }

  if (options.topic) {
    const rankedPages = rankPages(pages, options.topic, { limit: options.sectionsPerTopic })

    if (options.skeleton) {
      if (rankedPages.length === 0) {
        return {
          kind: 'no-topic-match',
          text: `Nothing in \`${MAP_DIR}/\` matches "${options.topic}". Pages:\n${pageList}`,
        }
      }
      const body = rankedPages
        .map((page) => skeletonText(page, splitSections(page.text).sections))
        .join('\n\n')
      const capped = capText(body, options.maxBytes, options.offset)
      return {
        kind: 'skeleton',
        text: `${capped.text}${capped.truncated ? continuationLine(options, capped.nextOffset) : ''}`,
        pages: rankedPages.map((page) => page.rel),
        ...(capped.truncated ? { nextOffset: capped.nextOffset } : {}),
      }
    }

    const ranked = rankSections(pages, options.topic, {
      limit: options.sectionsPerTopic,
      tier: options.tier,
    })
    if (ranked.length === 0) {
      return {
        kind: 'no-topic-match',
        text: `Nothing in \`${MAP_DIR}/\` matches "${options.topic}". The index is below — name one of its rows, or search the source knowing the map does not cover this.\n\n${indexText}\n\nPages:\n${pageList}`,
      }
    }

    const wanted = ranked.map((hit) => hit.matched).flat()
    const matchingRows = rows
      .filter((row) => {
        const haystack = `${row.feature} ${row.doc} ${row.when}`.toLowerCase()
        return wanted.some((word) => haystack.includes(word))
      })
      .slice(0, 3)
    const order = [...new Set(ranked.map((hit) => hit.page.rel))]
    const blocks = []
    const returnedSections = []
    const omitted = []
    for (const rel of order) {
      const page = pages.find((entry) => entry.rel === rel)
      const { preamble, sections } = splitSections(page.text)
      const chosen = ranked.filter((hit) => hit.page.rel === rel).map((hit) => hit.section)
      // A section beyond the cheap tier is prose about a mechanism: it is read
      // correctly only next to the summary that says what the mechanism is for.
      const context = chosen.some((section) => !options.tier.includes(section.heading))
        ? selectSections(sections, ['What it does'])
        : []
      const include = [...context, ...chosen]
        .filter((section, index, all) => all.findIndex((s) => s.slug === section.slug) === index)
        .sort((a, b) => a.index - b.index)
      const status = /^Status:.*$/m.exec(preamble)?.[0]
      blocks.push(
        `## ${page.rel} — ${page.title}${status ? `\n${status}` : ''}\n\n${include
          .map((section) => section.text)
          .join('\n\n')}`,
      )
      for (const section of include) returnedSections.push(`${page.rel}#${section.slug}`)
      const rest = sections.filter(
        (section) => !include.some((entry) => entry.slug === section.slug),
      )
      omitted.push({ page, sections: rest })
    }

    const body = `${blocks.join('\n\n')}\n\n${omitted
      .map((entry) => omittedLines(entry.page, [], entry.sections))
      .filter(Boolean)
      .join('\n')}`
    const capped = capText(body, options.maxBytes, options.offset)
    const header = matchingRows.length
      ? `${matchingRows.map((row) => `- **${row.feature}** — ${row.when}`).join('\n')}\n\n`
      : ''
    return {
      kind: 'sections',
      text: `${header}${capped.text}${capped.truncated ? continuationLine(options, capped.nextOffset) : ''}`,
      pages: order,
      sections: returnedSections,
      matched: wanted,
      ...(omitted.flatMap((entry) => entry.sections).length
        ? { omitted: omitted.flatMap((entry) => entry.sections.map((s) => `${entry.page.rel}#${s.slug}`)) }
        : {}),
      ...(capped.truncated ? { nextOffset: capped.nextOffset } : {}),
    }
  }

  const capped = capText(indexText, options.maxBytes, options.offset)
  return {
    kind: 'index',
    text: `${capped.text}${capped.truncated ? continuationLine(options, capped.nextOffset) : ''}\n\nPages (${pages.length}):\n${pageList}`,
    pageCount: pages.length,
    rows: rows.length,
    ...(capped.truncated ? { nextOffset: capped.nextOffset } : {}),
  }
}

/**
 * Register the section, the tools, the guard and the commands.
 *
 * The project root is the plugin location's directory — the same root the
 * session's own tools resolve relative paths against — and every tool also
 * takes an explicit `root` argument, for a session that has moved or is
 * working in a worktree.
 *
 * @param ctx - the OpenCode plugin context.
 */
async function setup(ctx) {
  const settings = resolveConfig(ctx.options ?? {})
  const locationRoot = ctx.location.directory

  /**
   * Per-session state, keyed by session id.
   *
   * The guard denies once per session, so the state has to outlive one model
   * request but not the server: a Map keyed by session id does exactly that,
   * and a finished session's row is a few bytes.
   */
  const sessions = new Map()
  const sessionState = (sessionID) => {
    let state = sessions.get(sessionID)
    if (!state) {
      state = { consulted: false, asked: false, waived: false }
      sessions.set(sessionID, state)
    }
    return state
  }

  /** The six tool definitions, registered in one transform after they exist. */
  const tools: any[] = []

  if (settings.mode !== 'off') {
    await ctx.session.hook('context', (event) => {
      // An agent whose profile has restricted the fs tools away cannot act on
      // this rule, and telling it to consult a map it cannot read is noise.
      const hasSourceTools = settings.sourceTools.some((tool) => event.tools && tool in event.tools)
      if (hasSourceTools) event.system.push({ type: 'text', text: SECTION_TEXT })
    })
  }

  tools.push(toolDef({
    name: 'feature_map',
    description:
      "Read the project's feature map: one page per feature with its files, types, tests and traps. Call it before searching source. No arguments returns the index. A `topic` returns the sections for that area — the names, files and tests, not the whole page. A `page` alone returns that page's section list with sizes; add `section` for one section, `sub` for a `###` inside it, or `full: true` for the whole page. A reply that reached the byte budget says where to resume with `offset`.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: {
          type: 'string',
          description:
            'The area you are about to work in: a feature name, a symptom, a file or a symbol.',
        },
        page: {
          type: 'string',
          description: 'An exact page: a map-relative path, a file name, or a unique fragment.',
        },
        section: {
          type: 'string',
          description: 'One section of that page, by heading or a unique fragment of it.',
        },
        sub: {
          type: 'string',
          description:
            'One `###` subsection of that section, by heading or a unique fragment of it.',
        },
        full: {
          type: 'boolean',
          description: 'Return the whole page rather than its section list or one section.',
        },
        skeleton: {
          type: 'boolean',
          description:
            "With a `topic`, return the matching pages' section lists with sizes instead of their content — for choosing precisely.",
        },
        offset: {
          type: 'number',
          description: 'Byte offset to resume from, as reported by a previous capped reply.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text'],
        properties: {
          kind: { type: 'string' },
          text: { type: 'string' },
          root: { type: 'string' },
          index: { type: 'string' },
          page: { type: 'string' },
          section: { type: 'string' },
          pages: { type: 'array', items: { type: 'string' } },
          sections: { type: 'array', items: { type: 'string' } },
          omitted: { type: 'array', items: { type: 'string' } },
          matched: { type: 'array', items: { type: 'string' } },
          nextOffset: { type: 'integer' },
          pageCount: { type: 'integer' },
          rows: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, context) => {
      const cwd = locationRoot
      sessionState(context.sessionID).consulted = true
      const found = findMapRoot(cwd)
      if (!found) {
        const bare = cwd ? existsSync(join(cwd, ...MAP_DIR.split('/'))) : false
        return {
          kind: 'absent',
          text: bare
            ? `\`${MAP_DIR}/\` exists here but has no \`index.html\` (or legacy \`README.md\`), so there is no map to read. \`feature_map_init\` writes the index and the page template.`
            : `No \`${MAP_INDEX}\` (or legacy \`${LEGACY_MAP_INDEX}\`) in this project (searched upward from ${
                cwd ?? 'the session directory'
              }). Work from the source, and consider \`feature_map_init\` to start the map.`,
        }
      }
      const index = await readMapIndex(found.root)
      const pages = await listPages(found.root)
      const reply = renderMapReply(found.root, index.text, pages, {
        topic: typeof args?.topic === 'string' ? args.topic : undefined,
        page: typeof args?.page === 'string' ? args.page : undefined,
        section: typeof args?.section === 'string' ? args.section : undefined,
        sub: typeof args?.sub === 'string' ? args.sub : undefined,
        full: args?.full === true,
        skeleton: args?.skeleton === true,
        offset: Number.isFinite(args?.offset) ? args.offset : 0,
        maxBytes: settings.maxBytes,
        sectionsPerTopic: settings.sectionsPerTopic,
        tier: TIER1_SECTIONS,
      })
      return {
        ...reply,
        text: found.legacy ? `${reply.text}\n\n${LEGACY_NOTICE}` : reply.text,
        root: found.root,
        index: found.indexRel,
      }
    },
  }))

  tools.push(toolDef({
    name: 'feature_map_check',
    description:
      'Report where the feature map has drifted: pages that no index row links, index rows whose link goes nowhere, pages with no title, and sections that have outgrown a single read. Run it before relying on the map, and after changing it.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['clean', 'text'],
        properties: {
          clean: { type: 'boolean' },
          text: { type: 'string' },
          root: { type: 'string' },
          rows: { type: 'integer' },
          pages: { type: 'integer' },
          legacy: { type: 'boolean' },
          oversized: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['page', 'heading', 'bytes'],
              properties: {
                page: { type: 'string' },
                heading: { type: 'string' },
                bytes: { type: 'integer' },
                chunks: { type: 'integer' },
                largestChunk: { type: 'integer' },
                addressable: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (_args, context) => {
      const found = findMapRoot(locationRoot)
      if (!found) {
        return { clean: false, legacy: false, text: `No \`${MAP_INDEX}\` (or legacy \`${LEGACY_MAP_INDEX}\`) in this project.` }
      }
      const report = await checkMap(found.root, { maxSectionBytes: settings.maxSectionBytes })
      const drift = [
        ...report.unindexed.map((page) => `- \`${page}\` is not linked from the index`),
        ...report.unresolved.map(
          (row) => `- index row "${row.row}" ${row.reason}${row.doc ? ` (${row.doc})` : ''}`,
        ),
        ...report.untitled.map((page) => `- \`${page}\` has no \`# \` title`),
      ]
      // Size advice is not drift. A map whose index and pages agree is clean
      // even when a section wants splitting, and folding the two together would
      // make `clean` mean one thing to a caller checking its own edit and
      // another to a caller auditing the map.
      const notes = [
        ...report.splits.map(
          (section) =>
            `- \`${section.page}\` → \`## ${section.heading}\` is ${section.bytes} B and its largest chunk is ${section.largestChunk} B — \`feature_map_regen\` splits it, naming what it can from your lead-ins and leaving the rest as visible placeholders`,
        ),
        ...(report.oversized.length - report.splits.length
          ? [
              `- ${report.oversized.length - report.splits.length} oversized section(s) already divide at \`###\` level, so nothing is needed`,
            ]
          : []),
      ]
      const reviewNotes = report.review.map(
        (entry) =>
          `- \`${entry.page}\` has ${entry.fromLanguage} pseudo block(s) converted from code${
            entry.languages.length ? ` (${entry.languages.join(', ')})` : ''
          }${entry.verbatimWithoutWhy ? ` and ${entry.verbatimWithoutWhy} verbatim block(s) with no \`data-why\`` : ''} — review them as prose`,
      )
      const largest = report.largest
        ? ` The largest section is \`${report.largest.heading}\` in \`${report.largest.page}\` at ${report.largest.bytes} B.`
        : ''
      const sizeNote = notes.length ? `\n\nOn size:\n${notes.join('\n')}` : ''
      const codeNote = reviewNotes.length ? `\n\nOn code:\n${reviewNotes.join('\n')}` : ''
      const legacy = report.legacy ? `\n\n${LEGACY_NOTICE}` : ''
      return {
        clean: drift.length === 0,
        legacy: report.legacy,
        root: found.root,
        rows: report.rows.length,
        pages: report.pages.length,
        oversized: report.oversized,
        text: drift.length
          ? `The map has drifted:\n${drift.join('\n')}${sizeNote}${codeNote}${legacy}`
          : `The map agrees with itself: ${report.rows.length} index rows, ${report.pages.length} pages, every page linked and every link resolving.${largest}${sizeNote}${codeNote}${legacy}`,
      }
    },
  }))

  tools.push(toolDef({
    name: 'feature_map_adopt',
    description:
      "Bring an existing project's documentation up to the feature-map workflow. Reports which pages lack the mandated headings, which have no `Read when:` trigger, which index rows do not resolve, which sections are too big to read in one piece — and which of those already divide at `###` level — which `AGENTS.md` blocks are missing, and which documents under `docs/` are not in the map. Read-only by default; `apply: true` writes only files that do not exist and never edits one that does.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: {
          type: 'string',
          description: 'Project root. Defaults to the session working directory.',
        },
        focus: {
          type: 'string',
          description: 'all (default), index, pages, sizes, agents, or candidates.',
        },
        apply: {
          type: 'boolean',
          description:
            'Write the missing files — the index, HANDOFF.md, docs/SPEC.md, AGENTS.md — instead of only returning the plan. An existing file is never touched.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' },
          root: { type: 'string' },
          summary: { type: 'string' },
          wrote: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, context) => {
      const cwd = locationRoot
      const root = resolve(typeof args?.root === 'string' && args.root ? args.root : cwd)
      const focus = ['all', 'index', 'pages', 'sizes', 'agents', 'candidates'].includes(args?.focus)
        ? args.focus
        : 'all'
      const report = await checkMap(root, {
        maxSectionBytes: settings.maxSectionBytes,
        candidates: true,
      })

      const agentsPath = join(root, 'AGENTS.md')
      const agentsExists = existsSync(agentsPath)

      // Nothing to adopt: no map, no docs, and no instruction file either. A
      // project that has an `AGENTS.md` does have something to adopt, even when
      // its map does not exist yet.
      if (report.pages.length === 0 && !existsSync(join(root, 'docs')) && !agentsExists) {
        return {
          root,
          summary: 'no docs',
          wrote: [],
          skipped: [],
          text: `\`${root}\` has no \`docs/\` directory, no map and no \`AGENTS.md\`, so there is nothing to adopt. \`feature_map_init\` is the tool for a project that has nothing: it hands over \`AGENTS.md\`, \`HANDOFF.md\`, \`docs/SPEC.md\` and the map index, and writes them on request.`,
        }
      }

      const agentsText = agentsExists ? await readFileText(agentsPath) : ''
      const templateText = await readTemplate('AGENTS.md.tmpl')
      const agentsMissing = missingBlocks(agentsText, templateText)
      const rows = generateIndexRows(report.pages, { indexPath: report.indexPath })
      const unindexed = new Set(report.unindexed)
      const rowsToAdd = rows.filter((row) => unindexed.has(`${MAP_DIR}/${row.doc}`))
      const withoutHeadings = report.findings.filter((finding) => finding.missingHeadings.length)

      const summary = [
        `${report.pages.length} page(s)`,
        `${report.rows.length} index row(s)`,
        `${report.unindexed.length} unlinked`,
        `${report.pagesWithoutTrigger.length} without a trigger`,
        `${withoutHeadings.length} missing a mandated heading`,
        `${report.oversized.length} oversized (${report.splits.length} need splitting)`,
        `${report.candidates.length} outside the map`,
        agentsText ? `AGENTS.md present (${agentsMissing.length} block(s) missing)` : 'AGENTS.md absent',
      ].join(' · ')

      const want = (name) => focus === 'all' || focus === name
      const blocks = []

      if (want('index')) {
        if (report.pages.length === 0) {
          blocks.push(
            `### Index\n\nNo pages yet, so there is no index to derive. \`feature_map_init\` hands over the index template and the page template to start from.`,
          )
        } else if (!report.indexExists) {
          blocks.push(
            `### Index\n\nNo \`${MAP_INDEX}\`. Generated from the ${report.pages.length} page(s) that exist:\n\n${renderIndexTable(rows)}`,
          )
        } else {
          const lines = [
            ...report.unresolved.map(
              (row) => `- index row "${row.row}" ${row.reason}${row.doc ? ` (${row.doc})` : ''}`,
            ),
            ...report.unindexed.map((page) => `- \`${page}\` is not linked from the index`),
            ...(report.rowsWithoutTrigger
              ? [`- ${report.rowsWithoutTrigger} row(s) carry no \`Read when\` trigger`]
              : []),
          ]
          blocks.push(
            `### Index\n\n${
              lines.length ? lines.join('\n') : 'The index and the pages agree.'
            }${
              rowsToAdd.length
                ? `\n\nRows for the unlinked pages:\n\n${renderIndexTable(rowsToAdd)}`
                : ''
            }`,
          )
        }
      }

      if (want('pages')) {
        const shown = report.findings
          .filter((finding) => finding.missingHeadings.length || !finding.statusLine || !finding.linked)
          .slice(0, 10)
        blocks.push(
          `### Pages\n\n${
            shown.length
              ? shown
                  .map(
                    (finding) =>
                      `- \`${finding.rel}\`${
                        finding.missingHeadings.length
                          ? ` — missing ${finding.missingHeadings.map((h) => `\`## ${h}\``).join(', ')}`
                          : ''
                      }${finding.statusLine ? '' : ' — no `Status: … Read when:` line'}${
                        finding.linked ? '' : ' — not linked from the index'
                      }`,
                  )
                  .join('\n')
              : `All ${report.pages.length} page(s) carry the six headings, a trigger and an index row.`
          }`,
        )
      }

      if (want('sizes')) {
        blocks.push(
          `### Sections\n\n${
            report.oversized.length
              ? report.oversized
                  .map((section) =>
                    section.addressable
                      ? `- \`${section.page}\` → \`## ${section.heading}\` (${section.bytes} B) — ${section.chunks} chunk(s), largest ${section.largestChunk} B: already addressable at \`###\` level`
                      : `- \`${section.page}\` → \`## ${section.heading}\` (${section.bytes} B) — largest chunk ${section.largestChunk} B: needs \`###\` headings`,
                  )
                  .join('\n')
              : 'No section is past the limit.'
          }`,
        )
      }

      if (want('agents')) {
        if (!agentsText) {
          blocks.push(
            `### AGENTS.md\n\nAbsent. The template's blocks are ${agentsMissing
              .map((heading) => `\`## ${heading}\``)
              .join(', ')}.`,
          )
        } else if (agentsMissing.length === 0) {
          blocks.push('### AGENTS.md\n\nEvery template block is present; nothing to add.')
        } else {
          const missingText = splitSections(templateText)
            .sections.filter((section) => agentsMissing.includes(section.heading))
            .map((section) => section.text)
            .join('\n\n')
          const inline = focus === 'agents' || Buffer.byteLength(missingText, 'utf8') < 1500
          blocks.push(
            `### AGENTS.md\n\nPresent, and never edited by this tool. Missing block(s): ${agentsMissing
              .map((heading) => `\`## ${heading}\``)
              .join(', ')}.${inline ? `\n\n${missingText}` : `\n\nAsk again with focus:"agents" for the text to paste.`}`,
          )
        }
      }

      if (want('candidates')) {
        blocks.push(
          `### Outside the map\n\n${
            report.candidates.length
              ? report.candidates
                  .map(
                    (candidate) =>
                      `- \`${candidate.rel}\` — ${candidate.title} (${candidate.bytes} B, ${candidate.sections} section(s))`,
                  )
                  .join('\n')
              : 'Nothing under `docs/` is outside the map.'
          }`,
        )
      }

      const plan = [
        !report.indexExists || rowsToAdd.length
          ? '[deterministic] write the generated index rows into the map index — `feature_map_regen` does it for an index that already exists'
          : undefined,
        report.pagesWithoutTrigger.length
          ? `[judgment] write a \`Read when:\` trigger for ${report.pagesWithoutTrigger.length} page(s) — it is the phrase someone searches for`
          : undefined,
        withoutHeadings.length
          ? `[judgment] fill the headings ${withoutHeadings.length} page(s) are missing — they are the retrieval unit`
          : undefined,
        report.splits.length
          ? `[judgment] split ${report.splits.length} section(s) with \`###\` headings`
          : undefined,
        agentsMissing.length
          ? '[deterministic] paste the missing AGENTS.md blocks into the project instruction file'
          : undefined,
      ].filter(Boolean)

      const tail = plan.length
        ? `\n\nPlan (deterministic items are derived from the files; the rest is judgement):\n${plan
            .map((item, index) => `${index + 1}. ${item}`)
            .join('\n')}\n\nThen run \`feature_map_check\` to confirm.`
        : '\n\nNothing to adopt: the map already meets the workflow.'

      if (args?.apply !== true) {
        return {
          root,
          summary,
          wrote: [],
          skipped: [],
          text: `${summary}\n\n${blocks.join('\n\n')}${tail}`,
        }
      }

      const write = writeThrough()
      const scaffold = await planScaffold({
        root,
        variables: templateVariables({ project: lastSegment(root) }),
      })
      for (const entry of scaffold.entries) {
        if (entry.id === 'feature-map') entry.content = withGeneratedIndex(entry.content, rows)
      }
      // A failed write is named with its reason, never folded into a count:
      // the reply has to say what did not happen for the caller to act on it.
      let applied: any
      try {
        applied = await applyScaffold(scaffold, write)
      } catch (error) {
        return {
          root,
          summary,
          wrote: [],
          skipped: [],
          text: `${summary}\n\nCould not be written: ${error?.message ?? String(error)}\n\n${blocks.join('\n\n')}${tail}`,
        }
      }
      const { written, skipped } = applied
      return {
        root,
        summary,
        wrote: written.map((entry) => entry.target),
        skipped: skipped.map((entry) => entry.target),
        text: `${summary}\n\nWrote ${written.length} file(s) under \`${root}\`:\n${written
          .map((entry) => `- \`${entry.target}\` — ${entry.what}`)
          .join('\n')}${
          skipped.length
            ? `\n\nLeft alone, because they already exist:\n${skipped
                .map((entry) => `- \`${entry.target}\``)
                .join('\n')}`
            : ''
        }\n\n${blocks.join('\n\n')}${tail}`,
      }
    },
  }))

  tools.push(toolDef({
    name: 'feature_map_init',
    description:
      "Scaffold the documentation workflow into a project: AGENTS.md (process and hard rules), HANDOFF.md (session state), docs/SPEC.md (user-visible behavior) and docs/features/README.md (the map index and the page template). Defaults to a plan that returns the finished content for you to write; `write: true` writes the files instead. For documents that already exist, `feature_map_regen` rewrites a map in place and `feature_map_adopt` reports what a project's own docs are missing.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: {
          type: 'string',
          description: 'Project root. Defaults to the session working directory.',
        },
        project: { type: 'string', description: 'Project name, substituted into the documents.' },
        summary: {
          type: 'string',
          description: 'One line on what the project is and what it is built with.',
        },
        write: {
          type: 'boolean',
          description: 'Write the files rather than returning their content. Defaults to false.',
        },
        force: {
          type: 'boolean',
          description: 'Overwrite files that already exist. Defaults to false.',
        },
        only: {
          type: 'array',
          items: { type: 'string' },
          description: 'Template ids to consider: agents, feature-map, spec, handoff.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' },
          root: { type: 'string' },
          wrote: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, context) => {
      const cwd = locationRoot
      const root = resolve(typeof args?.root === 'string' && args.root ? args.root : cwd)
      const plan = await planScaffold({
        root,
        variables: templateVariables({
          project: args?.project ?? lastSegment(root),
          summary: typeof args?.summary === 'string' ? args.summary : undefined,
          date: new Date().toISOString().slice(0, 10),
        }),
        force: args?.force === true,
        only: Array.isArray(args?.only)
          ? args.only.filter((id) => typeof id === 'string')
          : undefined,
      })
      const summaryOf = (entry) =>
        `- \`${entry.target}\` (${entry.what}) — ${entry.status}${entry.exists ? ' (already exists)' : ''}`
      if (args?.write !== true) {
        const body = plan.entries
          .map((entry) => `### ${entry.target}\n\n\`\`\`\`markdown\n${entry.content}\n\`\`\`\``)
          .join('\n\n')
        return {
          root: plan.root,
          text: `Plan for \`${plan.root}\`:\n${plan.entries
            .map(summaryOf)
            .join('\n')}\n\nWrite these with your own file tools, keeping the project's own facts — layout, commands, hard rules — in the places marked for them. Then call \`feature_map_check\`.\n\n${body}`,
          wrote: [],
          skipped: plan.entries.filter((entry) => entry.status === 'exists').map((e) => e.target),
        }
      }
      const write = writeThrough()
      let applied: any
      try {
        applied = await applyScaffold(plan, write)
      } catch (error) {
        return {
          root: plan.root,
          wrote: [],
          skipped: [],
          text: `Could not be written: ${error?.message ?? String(error)} Re-run without \`write\`, and write the returned content with your own file tools.`,
        }
      }
      const { written, skipped } = applied
      return {
        root: plan.root,
        wrote: written.map((entry) => entry.target),
        skipped: skipped.map((entry) => entry.target),
        text: `Wrote ${written.length} file(s) under \`${plan.root}\`:\n${written
          .map(summaryOf)
          .join('\n')}${
          skipped.length
            ? `\n\nLeft alone (already present):\n${skipped.map(summaryOf).join('\n')}`
            : ''
        }\n\nThe placeholders to fill in are marked: the layout, the commands and the hard rules in \`AGENTS.md\`, and the first row of the map index.`,
      }
    },
  }))

  tools.push(toolDef({
    name: 'feature_map_regen',
    description:
      "Rewrite an existing feature map so this plugin can read it one section at a time: every page gets the six template headings and a `Status: … Read when:` line where they are missing, and every section larger than `maxSectionBytes` is divided at boundaries the page already has — paragraphs and bullets — into `###` chunks. A chunk whose first line is a short bold lead-in takes that lead-in as its heading; any other gets a visible `### <!-- chunk 1/2: name this -->` for you to name. It never adds, removes or rewords prose, never moves content between sections, and never touches anything outside `docs/features/`. The index is reconciled with the pages: a row that resolves is left exactly as it is, a row that does not is re-pointed, a page with no row gets one, and a row no page claims is dropped and printed. Read-only by default; `show: true` returns the rewritten text, and `apply: true` writes it through the filesystem seam.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: {
          type: 'string',
          description: 'Project root. Defaults to the session working directory.',
        },
        apply: {
          type: 'boolean',
          description: 'Write the rewritten files rather than only reporting the plan.',
        },
        show: {
          type: 'boolean',
          description:
            'Include the rewritten text of each changed file in the reply, capped at the reply budget and resumable with `offset`.',
        },
        offset: {
          type: 'number',
          description: 'Byte offset to resume a capped `show` reply from.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' },
          root: { type: 'string' },
          wrote: { type: 'array', items: { type: 'string' } },
          unchanged: { type: 'array', items: { type: 'string' } },
          refused: { type: 'array', items: { type: 'string' } },
          splits: { type: 'integer' },
          placeholders: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, context) => {
      const cwd = locationRoot
      const root = resolve(typeof args?.root === 'string' && args.root ? args.root : cwd)
      // A session that rewrote the map has read it, so the guard's one ask is
      // already satisfied — same reason `feature_map` clears it.
      sessionState(context.sessionID).consulted = true
      const plan = await planRegen(root, { maxSectionBytes: settings.maxSectionBytes })

      if (plan.absent) {
        return {
          root: plan.root,
          wrote: [],
          unchanged: [],
          refused: [],
          splits: 0,
          placeholders: 0,
          text: `No \`${MAP_DIR}/\` under \`${plan.root}\`, so there is no map to rewrite. \`feature_map_init\` hands over the documents a project starts from.`,
        }
      }

      const apply = args?.apply === true
      const write = apply ? writeThrough() : undefined

      const result = apply
        ? await applyRegen(plan, write)
        : { written: [], unchanged: plan.entries, failed: [] }
      const wrote = result.written.map((entry) => entry.rel)
      const failed = new Set(result.failed.map((entry) => entry.rel))
      const refused = [
        ...result.failed.map((entry) => `${entry.rel} — ${entry.reason}`),
        ...plan.entries
          .filter((entry) => entry.status === 'refused' && !failed.has(entry.rel))
          .map((entry) => `${entry.rel} — ${entry.reason ?? 'refused'}`),
      ]
      return {
        root: plan.root,
        wrote,
        unchanged: result.unchanged.map((entry) => entry.rel),
        refused,
        splits: plan.counts.splits,
        placeholders: plan.counts.placeholders,
        text: renderRegenText(plan, {
          applied: apply,
          wrote: wrote.length,
          failed: result.failed,
          maxBytes: settings.maxBytes,
          offset: Number.isFinite(args?.offset) ? args.offset : 0,
          show: args?.show === true,
        }),
      }
    },
  }))

  tools.push(toolDef({
    name: 'feature_map_upgrade',
    description:
      "Convert a legacy Markdown feature map to the HTML format: every `.md` page gets an `.html` sibling, `docs/features/README.md` becomes `docs/features/index.html`, and internal `.md` links are rewritten. Both formats stay readable, and the HTML page wins when a stem has both; `.md` files are kept unless `prune: true`. A fenced block with a language becomes pseudocode (the default for a code-shaped block) and is reported for review; a `verbatim` block without a reason gets a visible placeholder. Read-only by default; `apply: true` writes, `force` overwrites existing `.html`.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: {
          type: 'string',
          description: 'Project root. Defaults to the session working directory.',
        },
        apply: {
          type: 'boolean',
          description: 'Write the HTML files instead of only returning the plan.',
        },
        prune: {
          type: 'boolean',
          description: 'Remove each `.md` source after its `.html` sibling is written.',
        },
        force: {
          type: 'boolean',
          description: 'Overwrite an `.html` file that already exists.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' },
          root: { type: 'string' },
          wrote: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
          removed: { type: 'array', items: { type: 'string' } },
          flagged: { type: 'integer' },
          verbatim: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, context) => {
      const cwd = locationRoot
      const root = resolve(typeof args?.root === 'string' && args.root ? args.root : cwd)
      sessionState(context.sessionID).consulted = true
      const plan = await planUpgrade(root, {
        force: args?.force === true,
        prune: args?.prune === true,
      })
      if (plan.absent || plan.counts.writes === 0) {
        return {
          root: plan.root,
          text: renderUpgradeText(plan),
          wrote: [],
          skipped: plan.entries.map((entry) => entry.targetRel),
          removed: [],
          flagged: plan.flagged.length,
          verbatim: plan.verbatim.length,
        }
      }
      if (args?.apply !== true) {
        return {
          root: plan.root,
          text: renderUpgradeText(plan),
          wrote: [],
          skipped: plan.entries.filter((entry) => entry.status === 'exists').map((entry) => entry.targetRel),
          removed: [],
          flagged: plan.flagged.length,
          verbatim: plan.verbatim.length,
        }
      }
      const result = await applyUpgrade(plan, writeThrough())
      return {
        root: plan.root,
        text: renderUpgradeText(plan, result),
        wrote: result.written.map((entry) => entry.targetRel),
        skipped: result.skipped.map((entry) => entry.targetRel),
        removed: result.removed,
        flagged: plan.flagged.length,
        verbatim: plan.verbatim.length,
      }
    },
  }))

  if (settings.mode === 'enforce') {
    // The guard is a permission hook rather than a tool guard: OpenCode routes
    // the `read`, `glob` and `grep` actions through the permission domain, and
    // a hook runs after the configured rules with the power to turn an `allow`
    // or `ask` into a `deny` that carries its reason. It never sees a call
    // whose action is not in `sourceTools`, and a configured `deny` is final
    // before the hook runs — which is the correct precedence: an explicit deny
    // is stricter than this rule, not looser.
    await ctx.permission.hook('evaluate', (event) => {
      if (!settings.sourceTools.includes(event.action)) return
      const state = sessionState(event.sessionID)
      if (state.consulted || state.asked || state.waived) return
      const found = findMapRoot(locationRoot)
      if (!found) {
        state.waived = true
        return
      }
      const target = guardLookup(found.root, event.action, event.resources, settings.exemptPaths)
      if (!target) return
      // Once per session, and the denial is itself the remedy: it names the
      // tool that clears it and says this is the only ask.
      state.asked = true
      event.effect = 'deny'
      event.message = denialText(event.action, target)
    })
  }

  await ctx.tool.transform((editor) => {
    for (const definition of tools) editor.add(definition)
  })

  // The tools, reachable as commands: each command runs the tool behind it
  // with the arguments typed after the command name, and injects the reply as
  // a synthetic message — the same text the tool would have returned, without
  // a model turn.
  await ctx.command.transform((editor) => {
    for (const command of buildCommands(ctx, tools)) editor.add(command)
  })
}

/** The last path segment, used as the default project name. */
function lastSegment(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? 'this project'
}

/**
 * Put the rows derived from the pages where the index template's placeholder
 * row is.
 *
 * String surgery on the *template*, never on a document the project wrote: the
 * placeholder is this plugin's own text, and a project's own index is reported
 * on rather than rewritten.
 */
function withGeneratedIndex(content, rows) {
  const htmlPlaceholder = /<tr[^>]*data-placeholder="row"[^>]*>[\s\S]*?<\/tr>/
  if (htmlPlaceholder.test(content)) {
    return content.replace(htmlPlaceholder, renderIndexHtmlTable(rows))
  }
  const placeholder = /^\| <!-- Feature name -->.*$/m
  return placeholder.test(content) ? content.replace(placeholder, renderIndexTable(rows)) : content
}

/**
 * The write seam for every tool that writes.
 *
 * On OpenCode a plugin runs inside the server, under the authority of the user
 * who installed it, so the seam the DSH port needed does not exist here: a
 * write is a plain filesystem write. What survives from that port is the rule
 * the seam taught — **a write is opt-in, per call, and reports what it could
 * not write**: `write`, `apply` and `force` are explicit arguments, an
 * existing file is never replaced without `force`, and a failure is named per
 * file rather than folded into a count.
 *
 * The bytes matter too: the templates ship byte-for-byte and a section is
 * measured in bytes, so the writer is UTF-8 without a BOM and touches nothing
 * else about the content.
 *
 * @returns a `(path, content) => Promise<void>` writer.
 */
function writeThrough() {
  return async (path, content) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
}

/**
 * Render the regeneration's reply.
 *
 * Four things a caller has to be able to act on: what each file becomes, which
 * headings were left for a person to name, what this tool could not divide at
 * all, and whether anything was written. The placeholders are listed as calls,
 * not as prose, because naming them is the next action.
 */
function renderRegenText(plan, options: Record<string, any> = {}) {
  const index =
    plan.entries.find((entry) => entry.kind === 'index') ??
    plan.entries.find((entry) => entry.rel === plan.indexRel)
  const pages = plan.entries.filter((entry) => entry !== index)
  const changed = pages.filter((entry) => entry.status === 'changed')
  const placeholders = []
  const authors = []
  for (const entry of plan.entries) {
    for (const change of entry.changes ?? []) {
      if (change.kind === 'split') {
        for (const heading of change.placeholders ?? []) {
          placeholders.push(`- \`${entry.rel}\` → \`### ${heading}\``)
        }
      }
      if (change.kind === 'needs-author') {
        authors.push(`- \`${entry.rel}\` → ${change.detail}`)
      }
    }
  }

  const head = `${plan.counts.pages} page(s): ${changed.length} to rewrite, ${
    plan.counts.pages - changed.length
  } already readable; ${plan.counts.splits} section(s) split into ${plan.counts.chunks} chunk(s), ${
    plan.counts.placeholders
  } heading(s) left for you to name.`

  const body = []
  for (const entry of changed) {
    const summary = entry.changes
      .filter((change) => change.kind !== 'needs-author')
      .map((change) => change.detail)
      .join('; ')
    body.push(`- \`${entry.rel}\` — ${summary || 'rewritten'}`)
  }
  if (index && index.status !== 'unchanged' && index.status !== 'absent') {
    const counts = index.counts ?? {}
    const size = index.bytes ? ` (${index.bytes.before} B → ${index.bytes.after} B)` : ''
    body.push(
      index.status === 'refused'
        ? `- \`${index.rel}\` — left alone: ${index.reason}`
        : `- \`${index.rel}\` — ${counts.added ?? 0} row(s) added, ${
            counts.repointed ?? 0
          } re-pointed, ${counts.dropped ?? 0} dropped, ${counts.kept ?? 0} left as they are${size}`,
    )
    // A dropped row is the one thing here that destroys wording, so the line
    // itself travels with the report rather than only its count.
    const dropped = (index.changes ?? []).filter((change) => change.kind === 'dropped')
    for (const change of dropped.slice(0, 10)) {
      body.push(`  dropped${change.reason ? ` (${change.reason})` : ''}: \`${change.line.trim()}\``)
    }
    if (dropped.length > 10) body.push(`  …and ${dropped.length - 10} more dropped row(s)`)
  }
  for (const entry of plan.entries.filter((candidate) => candidate.status === 'absent')) {
    body.push(`- \`${entry.rel}\` — ${entry.reason}`)
  }

  const sections = [
    head,
    body.length ? body.join('\n') : 'Nothing to rewrite: every page is already readable at this size.',
  ]
  if (placeholders.length) {
    sections.push(
      `### Placeholders to name\n\n${placeholders.join(
        '\n',
      )}\n\nEach one is a section this tool divided but could not name; give it the words the page already uses.`,
    )
  }
  if (authors.length) {
    sections.push(`### Needs an author\n\n${authors.join('\n')}`)
  }

  const changedCount = changed.length + (index && ['rewritten', 'inserted'].includes(index.status) ? 1 : 0)
  const failed = options.failed ?? []
  if (failed.length) {
    sections.push(
      `### Could not be written\n\n${failed
        .map((entry) => `- \`${entry.rel}\` — ${entry.reason}`)
        .join('\n')}`,
    )
  }
  sections.push(
    !changedCount
      ? 'Nothing to write: the map already reads at this size.'
      : failed.length
        ? `Wrote ${options.wrote ?? 0} of ${changedCount} file(s) under \`${plan.root}\`; the rest failed above.`
        : options.applied
          ? `Wrote ${options.wrote ?? 0} file(s) under \`${plan.root}\`. Run \`feature_map_check\` to confirm the index and the pages still agree.`
          : `Plan only: nothing was written. Pass \`apply: true\` to write ${changedCount} file(s).`,
  )

  let text = sections.join('\n\n')
  if (options.show) {
    const shown = []
    for (const entry of plan.entries.filter((candidate) => candidate.status !== 'unchanged')) {
      if (!entry.text) continue
      shown.push(`### ${entry.rel}\n\n\`\`\`\`markdown\n${entry.text}\n\`\`\`\``)
    }
    if (shown.length) {
      const capped = capText(shown.join('\n\n'), options.maxBytes, options.offset ?? 0)
      text = `${text}\n\n${capped.text}${
        capped.truncated
          ? `\n\n[budget reached — call feature_map_regen again with offset:${capped.nextOffset} and show:true]`
          : ''
      }`
    }
  }
  return text
}

/** Read a UTF-8 file, or an empty string when it is gone. */
async function readFileText(path) {
  return readFile(path, 'utf8').catch(() => '')
}

/**
 * Adapt a ported tool definition to an OpenCode tool.
 *
 * The five definitions above are written in the shape they were ported in:
 * `parameters` for the JSON Schema, `output.schema` for the reply schema, and
 * an `execute` that returns the structured reply. OpenCode wants `input`, an
 * optional `output` schema, and a `{ content }` result. This adapter is the
 * one place that knows both shapes, so the five tool bodies read the same as
 * they did on the DSH host.
 *
 * The JSON Schema objects are passed through untyped on purpose: OpenCode
 * accepts JSON Schema through its own schema types, and importing those types
 * would put a second package in lockstep with the plugin for no behavioral
 * gain. `additionalProperties: false` and the descriptions are what the model
 * reads, and they are unchanged by the port.
 */
function toolDef(definition) {
  return {
    name: definition.name,
    description: definition.description,
    input: definition.parameters,
    output: definition.output?.schema,
    // A registered tool is not an offered tool. The host's request carries the
    // registry's `codemode: false` entries by name; every other tool is
    // reachable only through the code-mode `execute` wrapper, so a model told
    // to call `feature_map` is answered "no such tool" while the plugin loads,
    // pushes its instruction and fires its guard as usual. Observed, not
    // deduced: a sibling plugin whose tool sets this flag is called by name in
    // the same session, and `@opencode/schema`'s `Options` type makes
    // `codemode?: true` the default branch.
    options: { codemode: false },
    execute: async (args, context) => {
      const reply = await definition.execute(args, context)
      return {
        output: reply,
        content: typeof reply?.text === 'string' ? reply.text : '',
        metadata: { plugin: PLUGIN_ID },
      }
    },
  }
}

/**
 * The argument grammar the five commands share.
 *
 * `key:value` sets a named argument, a bare flag sets a boolean, and anything
 * left over is the topic — the words someone would actually type after
 * `/feature-map`. `summary:` is free text to the end of the line, because a
 * one-line project summary is the one value that is naturally a sentence.
 */
function parseArgs(text) {
  const args: Record<string, any> = {}
  const words: string[] = []
  for (const token of String(text ?? '')
    .split(/\s+/)
    .filter(Boolean)) {
    const named = /^([a-zA-Z]+):(.*)$/.exec(token)
    if (named) {
      const [, key, value] = named
      if (key === 'offset') args.offset = Number(value)
      else if (key === 'only') args.only = value.split(',').filter(Boolean)
      else args[key] = value
      continue
    }
    if (['write', 'force', 'apply', 'show', 'full', 'skeleton'].includes(token)) {
      args[token] = true
      continue
    }
    words.push(token)
  }
  return { args, words }
}

/**
 * The five commands: one per tool, each running the tool behind it.
 *
 * A command is a tool call the user can type: `/feature-map guards` runs the
 * same reader `feature_map` uses and injects its reply, so the map is one
 * keystroke away for a person who does not want to ask the agent for it. The
 * reply arrives as a synthetic message — recorded in the session, so the next
 * user turn can build on it, and without spending a model turn to say it.
 *
 * And a failing tool answers rather than throws: this executor is the last
 * plugin frame before the host, so a rejection here is a 500 that costs the
 * session. The reason is delivered as the reply instead.
 */
function buildCommands(ctx: any, tools: any[]) {
  const byName = new Map<string, any>(tools.map((tool) => [tool.name, tool]))

  /** Call a tool with a hand-made context: no model turn, no tool registry. */
  const run = async (sessionID, name, args) => {
    const tool = byName.get(name)
    if (!tool) throw new Error(`feature-map: no such tool: ${name}`)
    const result = await tool.execute(args, {
      sessionID,
      agent: '',
      messageID: '',
      id: '',
      progress: async () => {},
      signal: new AbortController().signal,
    })
    return result.content
  }

  const deliver = (sessionID, name, text) =>
    ctx.session.synthetic({ sessionID, text, description: `/${name}` })

  const command = (name, description, parse) => ({
    name,
    description,
    execute: async ({ sessionID, prompt }) => {
      try {
        await deliver(sessionID, name, await run(sessionID, toolName(name), parse(prompt?.text ?? '')))
      } catch (error) {
        // A failing tool costs the caller a reply, never the session. This
        // executor is the last frame between the plugin and the host: a
        // throw here is a 500 on the command request, which crashes the
        // session that asked. Observed, not deduced — an unguarded
        // `planScaffold()` ENOENT took three sessions down before this
        // guard existed. The reason travels as the reply so the caller can
        // act on it, the same rule the write seam follows.
        await ctx.session.synthetic({
          sessionID,
          text: `Could not run /${name}: ${error?.message ?? String(error)}`,
          description: `/${name}`,
        })
      }
    },
  })

  // Command names are the tool names with the underscores as dashes, which is
  // what a person types; the reverse maps back to the tool.
  const toolName = (name) => name.replace(/-/g, '_')

  return [
    command(
      'feature-map',
      'Read the project feature map — the index, the sections for a topic, one page, one section, or the whole page. Arguments: a topic, or page:<name> section:<heading> (add sub:<heading>), with full or skeleton.',
      (text) => {
        const { args, words } = parseArgs(text)
        const topic = words.join(' ')
        return { ...args, ...(topic ? { topic } : {}) }
      },
    ),
    command(
      'feature-map-check',
      'Report where the feature map has drifted — pages no index row links, rows whose link goes nowhere — and the sections that have outgrown a single read.',
      () => ({}),
    ),
    command(
      'feature-map-init',
      'Scaffold the documentation workflow into a project: AGENTS.md, HANDOFF.md, docs/SPEC.md and the map index. Plan by default; `write` writes, `force` overwrites, project:<name> and summary:<text…> set the substitutions, only:<ids> narrows the set.',
      (text) => {
        const { args, words } = parseArgs(text)
        const summary = /(?:^|\s)summary:(.*)$/.exec(String(text ?? '').trim())
        if (summary) args.summary = summary[1].trim()
        if (words.length && !args.project) args.project = words.join(' ')
        return args
      },
    ),
    command(
      'feature-map-adopt',
      "Bring an existing project's documentation up to the feature-map workflow: what each page is missing, which index rows do not resolve, which AGENTS.md blocks to paste. Read-only by default; `apply` writes only the files that do not exist. focus:all|index|pages|sizes|agents|candidates narrows the report.",
      (text) => {
        const { args, words } = parseArgs(text)
        if (words.length && !args.focus) args.focus = words[0]
        return args
      },
    ),
    command(
      'feature-map-regen',
      'Rewrite an existing map so it reads one section at a time: the missing headings, a Status line, every oversized section divided into `###` chunks, the index reconciled. Plan by default; `show` returns the rewritten text, `apply` writes it.',
      (text) => parseArgs(text).args,
    ),
    command(
      'feature-map-upgrade',
      'Convert a legacy Markdown map to HTML — one `.html` page per `.md` page, `index.html` for the index, `.md` links rewritten. Plan by default; `apply` writes, `prune` also removes the `.md` sources, `force` overwrites existing HTML.',
      (text) => parseArgs(text).args,
    ),
  ]
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup,
})
