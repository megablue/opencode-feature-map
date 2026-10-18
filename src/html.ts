/**
 * The HTML feature map: reading a page back as text, and writing text back as a
 * page.
 *
 * A feature map is written for two readers. An agent needs compact text it can
 * rank, slice and cap by the byte; a person needs to be able to open the same
 * page, follow a link, see a graph and copy a command. HTML serves the second
 * without taking anything from the first, so long as the plugin never hands
 * raw markup to the agent: every page is parsed into a canonical text form
 * (`#`/`##`/`###`, `-` bullets, fenced blocks) and every byte measurement, rank
 * and reply is taken from that text. The markup is on disk; the text is what
 * the reader sees.
 *
 * The format is deliberately small and parser-free — no dependency, no DOM:
 *
 * - `h1`/`h2`/`h3` are the retrieval unit, exactly as the Markdown headings
 *   were, so `splitSections()` did not have to change;
 * - `<pre class="pseudo">` is pseudocode and the default for a converted code
 *   fence — an agent copies the shape, not the exact bytes;
 * - `<pre class="verbatim" data-why="…">` is a block whose exact bytes matter,
 *   and the reason is mandatory because "verbatim" with no reason is how a
 *   pseudocode block escapes review;
 * - `<pre class="mermaid">` keeps the graph source for the browser, and the
 *   reader turns it into an edge list for the agent;
 * - a heading whose text is `<!-- chunk 1/2: name this -->` is written as
 *   `data-placeholder`, so regeneration can mark a chunk without an HTML
 *   comment swallowing the visible heading.
 *
 * `@module opencode-feature-map/html`
 */

/** Is this path an HTML document? */
export function isHtmlFile(path) {
  return /\.html?$/i.test(String(path ?? ''))
}

/** Is this path a Markdown document? */
export function isMarkdownFile(path) {
  return /\.md$/i.test(String(path ?? ''))
}

/** The path with its extension replaced by `.html`. */
export function htmlSibling(path) {
  return String(path ?? '').replace(/\.md$/i, '.html')
}

/** The last path segment, with any known documentation extension removed. */
export function stemOf(path) {
  return String(path ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.(md|html?)$/i, '')
}

/** Escape text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rarr: '→',
  larr: '←',
  harr: '↔',
  times: '×',
  middot: '·',
  copy: '©',
}

/** Decode the entities the writer emits, plus numeric references. */
export function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** A tag, its attributes, and whether it closes. */
function parseAttrs(source): Record<string, string> {
  const attrs = {}
  const pattern = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match
  while ((match = pattern.exec(source))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

/**
 * Split markup into text, tags and comments.
 *
 * A regex over the whole document is enough because the only markup the reader
 * must understand is the small vocabulary above; anything it does not
 * recognise becomes text, which is the tolerant half of "tolerant parser".
 */
function tokenize(html) {
  const source = String(html ?? '')
  const tokens = []
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open < 0) {
      tokens.push({ type: 'text', value: source.slice(index) })
      break
    }
    if (open > index) tokens.push({ type: 'text', value: source.slice(index, open) })
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4)
      const value = source.slice(open + 4, end < 0 ? source.length : end)
      tokens.push({ type: 'comment', value: value.trim() })
      index = end < 0 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9)
      tokens.push({ type: 'text', value: source.slice(open + 9, end < 0 ? source.length : end) })
      index = end < 0 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<!', open) || source.startsWith('<?', open)) {
      const end = source.indexOf('>', open)
      index = end < 0 ? source.length : end + 1
      continue
    }
    const match = /^<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/.exec(source.slice(open))
    if (!match) {
      tokens.push({ type: 'text', value: '<' })
      index = open + 1
      continue
    }
    const name = match[2].toLowerCase()
    const closing = match[1] === '/'
    index = open + match[0].length
    // Raw-text elements are not prose: the stylesheet, the graph loader and the
    // document head would otherwise be read as the page's first paragraph.
    if (!closing && (name === 'head' || name === 'script' || name === 'style' || name === 'title')) {
      const end = source.toLowerCase().indexOf(`</${name}`, index)
      const close = end < 0 ? -1 : source.indexOf('>', end)
      index = close < 0 ? source.length : close + 1
      continue
    }
    tokens.push({
      type: 'tag',
      closing,
      name,
      attrs: parseAttrs(match[3]),
    })
  }
  return tokens
}

/** Collapse paragraph whitespace without touching a `pre`. */
function inlineText(value) {
  return String(value ?? '').replace(/\s+/g, ' ')
}

/** Trim and normalise one completed inline block. */
function clean(value) {
  return inlineText(value).trim()
}

/** Choose a fence that cannot be closed by the code it contains. */
function fenceFor(content) {
  const runs = String(content ?? '').match(/`{3,}/g) ?? []
  const size = Math.max(3, ...runs.map((run) => run.length + 1))
  return '`'.repeat(size)
}

/** Render a code block in the canonical text form. */
function fenced(info, content) {
  const fence = fenceFor(content)
  return `${fence}${info}\n${String(content ?? '').replace(/\s+$/, '')}\n${fence}`
}

/** HTML entities inside a `pre` are decoded; tags are dropped but `<br>` is a line. */
function preText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\r\n?/g, '\n')
}

/** Drop indentation shared by every non-blank line, as a code block has it. */
function dedent(text) {
  const lines = String(text ?? '').split('\n')
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => /^[ \t]*/.exec(line)[0].length)
  const min = indents.length ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(min)).join('\n').replace(/^\n+|\n+$/g, '')
}

/**
 * Turn a Mermaid flow graph into the edge list an agent can use.
 *
 * The source stays in the page for the browser; this is what the reader hands
 * over in its place. It is deliberately lossy: a ranker wants to know that
 * `cluster → pod` exists and how many hops the picture has, not how the nodes
 * were styled. A graph the parser cannot read produces `undefined`, and the
 * caller keeps the source as a code block rather than pretending to understand
 * it.
 *
 * @param source - the text content of a `pre.mermaid`.
 * @returns `{ text, nodes, edges }`, or `undefined` when no edge was found.
 */
export function mermaidToEdges(source) {
  const lines = String(source ?? '').split(/\r?\n/)
  const kind = lines.map((line) => /^\s*(graph|flowchart)\b[^\n]*/i.exec(line)?.[0]?.trim()).find(Boolean)
  const nodes = new Map()
  const edges = []

  const nodeOf = (segment) => {
    const value = String(segment ?? '')
      .replace(/^\s*\|[^|]*\|\s*/, '')
      .trim()
    const match = /^([A-Za-z0-9_][\w.-]*)\s*(?:\(\(([^)]*)\)\)|\(([^)]*)\)|\[\[([^\]]*)\]\]|\[([^\]]*)\]|\{([^}]*)\}|>([^\]]*)\])?/.exec(
      value,
    )
    if (!match) return { id: value, label: value }
    const id = match[1]
    const label = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? '').trim()
    const resolved = label || nodes.get(id) || id
    nodes.set(id, resolved)
    return { id, label: resolved }
  }

  const ARROW = /(-\.->|-{2,3}>|==>|---)/
  const DIRECTIVE = /^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/i
  for (const raw of lines) {
    const line = raw.replace(/%%.*$/, '').trim()
    if (!line) continue
    if (/^(graph|flowchart)\b/i.test(line)) continue
    if (DIRECTIVE.test(line)) continue
    const parts = line.split(ARROW)
    let current = null
    let label = ''
    for (let index = 0; index < parts.length; index += 1) {
      if (index % 2 === 0) {
        const node = nodeOf(parts[index])
        if (current && node.id) {
          edges.push({ from: current.id, to: node.id, label })
          label = ''
        }
        current = node.id ? node : current
      } else {
        // The label belongs to the next segment: `-->|yes| B`.
        const match = /^\|([^|]*)\|/.exec(String(parts[index + 1] ?? '').trim())
        if (match) {
          label = match[1].trim()
          parts[index + 1] = String(parts[index + 1]).trim().slice(match[0].length)
        }
      }
    }
  }

  if (edges.length === 0) return undefined
  const labelOf = (id) => nodes.get(id) ?? id
  const header = `Graph${kind ? ` (${kind.replace(/^graph\s*/i, 'flowchart ')})` : ''}: ${nodes.size} node(s), ${edges.length} edge(s)`
  const body = edges.map((edge) => {
    const via = edge.label ? ` (${edge.label})` : ''
    return `- ${labelOf(edge.from)} → ${labelOf(edge.to)}${via}`
  })
  return {
    nodes: [...nodes.keys()],
    edges,
    text: [header, ...body].join('\n'),
  }
}

/**
 * Read one HTML page as the canonical text the rest of the plugin speaks.
 *
 * The result is deliberately plain Markdown: `#`/`##`/`###` headings, bullets,
 * pipe tables and fenced blocks, with every size measured on this text.
 */
export function htmlToMapText(html) {
  const tokens = tokenize(html)
  const blocks = []
  let buffer = ''
  let heading = null
  let pre = null
  let item = null
  const lists = []
  let table = null
  let quote = 0
  let link = null

  const emit = (text) => {
    const value = String(text ?? '').trim()
    if (value) blocks.push(quote > 0 ? value.split('\n').map((line) => `> ${line}`).join('\n') : value)
  }

  const flush = () => {
    const value = clean(buffer)
    if (value) emit(value)
    buffer = ''
  }

  const emitItem = () => {
    if (!item) return
    const value = clean(buffer)
    if (value) {
      const list = lists[lists.length - 1]
      const indent = '  '.repeat(Math.max(0, lists.length - 1))
      blocks.push(`${indent}${list?.ordered ? '1.' : '-'} ${value}`)
    }
    buffer = ''
    item = null
  }

  const emitTable = () => {
    if (!table || table.rows.length === 0) return
    const width = Math.max(...table.rows.map((row) => row.cells.length))
    const cells = (row) => {
      const filled = [...row.cells]
      while (filled.length < width) filled.push('')
      return `| ${filled.map((cell) => String(cell).replace(/\|/g, '\\|')).join(' | ')} |`
    }
    const first = table.rows[0]
    const header = first.header ? first : { cells: new Array(width).fill(''), header: true }
    const body = first.header ? table.rows.slice(1) : table.rows
    blocks.push(
      [cells(header), `| ${new Array(width).fill('---').join(' | ')} |`, ...body.map(cells)].join('\n'),
    )
    table = null
  }

  for (const token of tokens) {
    if (token.type === 'text') {
      if (pre) pre.text += token.value
      else buffer += decodeEntities(token.value)
      continue
    }
    if (token.type === 'comment') {
      if (heading && !clean(buffer)) buffer = `<!-- ${token.value} -->`
      continue
    }

    const { name, closing, attrs } = token

    if (pre) {
      if (name === 'pre' && closing) {
        const klass = String(attrs.class ?? pre.attrs.class ?? '')
        const source = dedent(preText(pre.text))
        if (/\bmermaid\b/.test(klass)) {
          const graph = mermaidToEdges(source)
          if (graph) emit(graph.text)
          else emit(fenced('mermaid', source))
        } else if (/\bverbatim\b/.test(klass)) {
          const why = attrs['data-why'] ?? pre.attrs['data-why']
          emit(fenced(why ? `verbatim why="${why.replace(/"/g, "'")}"` : 'verbatim', source))
        } else {
          const lang = attrs['data-from-lang'] ?? pre.attrs['data-from-lang']
          emit(fenced(lang ? `pseudo ${lang}` : 'pseudo', source))
        }
        pre = null
      } else if (name === 'br') {
        pre.text += '\n'
      }
      continue
    }

    if (name === 'pre' && !closing) {
      flush()
      pre = { text: '', attrs }
      continue
    }

    if (/^h[1-6]$/.test(name)) {
      if (closing) {
        const level = Number(name[1])
        const placeholder = heading?.placeholder
        let text = clean(buffer) || String(placeholder ?? '').trim()
        if (text && placeholder && text === placeholder) text = `<!-- ${text} -->`
        emit(`${'#'.repeat(level)} ${text}`)
        buffer = ''
        heading = null
      } else {
        flush()
        heading = { level: Number(name[1]), placeholder: attrs['data-placeholder'] }
        buffer = ''
      }
      continue
    }

    if (name === 'li') {
      if (closing) {
        emitItem()
      } else {
        emitItem()
        item = true
        buffer = ''
      }
      continue
    }

    if (name === 'ul' || name === 'ol') {
      if (closing) {
        emitItem()
        lists.pop()
        flush()
      } else {
        emitItem()
        flush()
        lists.push({ ordered: name === 'ol' })
      }
      continue
    }

    if (name === 'table') {
      if (closing) {
        emitTable()
      } else {
        flush()
        table = { rows: [] }
      }
      continue
    }

    if (name === 'tr') {
      if (!closing && table) table.rows.push({ cells: [], header: false })
      continue
    }

    if (name === 'th' || name === 'td') {
      if (table && table.rows.length) {
        const row = table.rows[table.rows.length - 1]
        if (closing) {
          row.cells.push(clean(buffer))
          row.header = row.header || name === 'th'
          buffer = ''
        } else {
          buffer = ''
        }
      }
      continue
    }

    if (name === 'blockquote') {
      flush()
      quote += closing ? -1 : 1
      if (quote < 0) quote = 0
      continue
    }

    if (name === 'hr') {
      flush()
      emit('---')
      continue
    }

    if (name === 'br') {
      buffer += '\n'
      continue
    }

    if (name === 'img') {
      if (!closing) buffer += attrs.alt ?? ''
      continue
    }

    if (name === 'a') {
      if (!closing) {
        link = { href: attrs.href ?? '', start: buffer.length }
      } else if (link) {
        const text = buffer.slice(link.start)
        if (link.href) buffer = `${buffer.slice(0, link.start)}[${text}](${link.href})`
        link = null
      }
      continue
    }

    if (name === 'code') {
      buffer += '`'
      continue
    }
    if (name === 'strong' || name === 'b') {
      buffer += '**'
      continue
    }
    if (name === 'em' || name === 'i') {
      buffer += '*'
      continue
    }
    if (name === 'del' || name === 's') {
      buffer += '~~'
      continue
    }
    if (name === 'dt') {
      if (closing) {
        const value = clean(buffer)
        if (value) emit(`**${value}**`)
        buffer = ''
      } else {
        flush()
      }
      continue
    }
    if (name === 'dd') {
      if (closing) {
        const value = clean(buffer)
        if (value) emit(`: ${value}`)
        buffer = ''
      } else {
        flush()
      }
      continue
    }

    // Every other element is a block boundary on open, and invisible on close.
    if (!closing) flush()
  }

  emitItem()
  if (pre) {
    const source = dedent(preText(pre.text))
    emit(/\bmermaid\b/.test(String(pre.attrs.class ?? '')) ? fenced('mermaid', source) : fenced('pseudo', source))
  }
  flush()
  emitTable()

  // Consecutive list items are one block: a blank line between every bullet
  // would spend bytes on nothing and make a three-item list read as three lists.
  const isItem = (line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(String(line ?? ''))
  return blocks
    .reduce((text, block) => {
      if (!text) return block
      const previous = text.split('\n').pop()
      return `${text}${isItem(block) && isItem(previous) ? '\n' : '\n\n'}${block}`
    }, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The first `h1` of an HTML page, or its `<title>`, or `undefined`. */
export function htmlTitle(html) {
  const headings = htmlToMapText(html).split(/\r?\n/)
  const title = headings.find((line) => /^#\s+/.test(line))
  if (title) return title.replace(/^#\s+/, '').trim() || undefined
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''))
  return match ? decodeEntities(match[1]).trim() || undefined : undefined
}

/** The `Status:` line of rendered text, if it has one. */
export function statusOf(text) {
  return /^Status:[^\n]*$/m.exec(String(text ?? ''))?.[0]
}

/**
 * The stylesheet every generated page carries.
 *
 * Inline rather than a sibling file on purpose: a feature page is copied,
 * moved and read on its own, and a stylesheet that did not travel with it would
 * turn the map into a wall of unstyled text in exactly the repository that
 * forgot the file. It is small, and it is the same bytes on every page, so
 * gzip sees one copy.
 */
export const MAP_CSS = `:root{color-scheme:light dark;--fg:#1d2433;--muted:#5b6475;--bg:#fff;--line:#d8dee9;--accent:#0b6e99;--warn:#8a5a00;--code:#f4f6fa}
@media (prefers-color-scheme:dark){:root{--fg:#e6eaf2;--muted:#9aa4b8;--bg:#11151c;--line:#2b3342;--accent:#6cc4e8;--warn:#e0b25c;--code:#1a202a}}
*{box-sizing:border-box}
body{margin:0 auto;max-width:60rem;padding:2rem 1.25rem 4rem;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
h1,h2,h3{line-height:1.25;margin:2rem 0 .75rem}
h1{font-size:1.9rem;border-bottom:2px solid var(--line);padding-bottom:.4rem}
h2{font-size:1.35rem}
h3{font-size:1.08rem;color:var(--muted)}
p,ul,ol,table,pre,blockquote{margin:.75rem 0}
a{color:var(--accent)}
code{background:var(--code);padding:.1em .3em;border-radius:.25rem;font-size:.92em}
pre{background:var(--code);border:1px solid var(--line);border-radius:.4rem;padding:.8rem 1rem;overflow:auto}
pre code{background:none;padding:0}
pre.verbatim{border-left:4px solid var(--warn)}
pre.verbatim::before{content:"verbatim — " attr(data-why);display:block;color:var(--warn);font:600 .78rem/1.4 ui-monospace,monospace;margin-bottom:.5rem;white-space:pre-wrap}
pre.pseudo{border-left:4px solid var(--accent)}
pre.mermaid{background:var(--bg);border:1px dashed var(--line)}
p.status{color:var(--muted);font-size:.92rem}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid var(--line);padding:.4rem .6rem;text-align:left;vertical-align:top}
th{background:var(--code)}
blockquote{margin-left:0;padding-left:1rem;border-left:3px solid var(--line);color:var(--muted)}
hr{border:0;border-top:1px solid var(--line);margin:2rem 0}
.lede{color:var(--muted)}`

const MERMAID_LOADER = `<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
mermaid.initialize({ startOnLoad: true, theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral' })
</script>`

/** A slug for a heading id; kept local so `map.ts` can import this module. */
function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'section'
}

/** Render inline Markdown to HTML, rewriting `.md` links to `.html`. */
export function inlineToHtml(value) {
  let text = escapeHtml(value)
  const codes = []
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  text = text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`)
}

/** Rewrite a link to a map page, and leave every other document alone. */
function mapLink(href) {
  const match = /^([^)\s]+?)\.md((?:#[^)\s]*)?)$/i.exec(String(href ?? ''))
  if (!match) return href
  const target = match[1]
  // A docs file, a root instruction file and an external or parent link all
  // stay Markdown: only a page of the map becomes an HTML sibling.
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|#|\.\.\/|docs\/)/i.test(target)) return href
  if (/^(README|AGENTS|CLAUDE|HANDOFF)$/i.test(target)) return href
  return `${target}.html${match[2]}`
}

/** Apply a link rewrite to Markdown prose, never inside a fence. */
function rewriteProseLinks(markdown, rewrite) {
  let fenced = false
  let fence = ''
  return String(markdown ?? '')
    .split('\n')
    .map((line) => {
      const marker = /^(`{3,})/.exec(line)
      if (marker) {
        if (!fenced) {
          fenced = true
          fence = marker[1]
        } else if (marker[1].length >= fence.length) {
          fenced = false
        }
        return line
      }
      if (fenced) return line
      return line.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
        const next = rewrite(href)
        if (next === href) return whole
        const shown = /\.md(?=$|#)/i.test(label) ? label.replace(/\.md(?=$|#)/i, '.html') : label
        return `[${shown}](${next})`
      })
    })
    .join('\n')
}

/** A heading's visible text, or its `data-placeholder`, as the writer needs it. */
function headingHtml(level, text) {
  const value = String(text ?? '').trim()
  const placeholder = /^<!--\s*(chunk\s+[^>]*?)\s*-->$/.exec(value)
  if (placeholder) {
    const label = placeholder[1].replace(/\s+/g, ' ').trim()
    const visible = /^chunk\s+([\d/]+)\s*:?\s*(.*)$/.exec(label)
    const shown = visible ? `chunk ${visible[1]}: ${visible[2] || 'name this'}` : label
    return `<h${level} data-placeholder="${escapeHtml(label)}">${escapeHtml(shown)}</h${level}>`
  }
  return `<h${level}>${inlineToHtml(value)}</h${level}>`
}

/** A `|` table block, as Markdown lines, to an HTML table. */
function tableToHtml(lines) {
  const rows = lines.map((line) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim()),
  )
  const separator = rows.findIndex((cells) => cells.every((cell) => /^:?-{2,}:?$/.test(cell)))
  const header = separator > 0 ? rows[separator - 1] : undefined
  const body = rows.filter((cells, index) => index !== separator && (index !== separator - 1 || !header))
  const render = (cells, tag) => `<tr>${cells.map((cell) => `<${tag}>${inlineToHtml(cell)}</${tag}>`).join('')}</tr>`
  return [
    '<table>',
    header ? `<thead>${render(header, 'th')}</thead>` : '',
    `<tbody>${body.map((cells) => render(cells, 'td')).join('')}</tbody>`,
    '</table>',
  ]
    .filter(Boolean)
    .join('')
}

/**
 * Render canonical map text as the body of an HTML document.
 *
 * The inverse of {@link htmlToMapText} for everything the plugin itself writes:
 * headings become sections, fenced blocks become `pre` with the class that says
 * how they may be read, and a pipe table becomes a table.
 *
 * @param text - canonical text (`#`, `##`, bullets, fences).
 * @param options - `level` shifts headings (used for the index, which is `h1`-led).
 * @returns HTML for the page body, without the document wrapper.
 */
export function mapTextToHtmlBody(text, options = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let sectionOpen = false
  let paragraph = []
  let list = null
  let fence = null
  let fenceInfo = ''
  let fenceBody = []
  let table = []
  let index = 0

  const flushParagraph = () => {
    const value = paragraph.join(' ').trim()
    if (!value) {
      paragraph = []
      return
    }
    const klass = /^Status:/i.test(value) ? ' class="status"' : ''
    out.push(`<p${klass}>${inlineToHtml(value)}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    out.push(
      `<${list.tag}>${list.items.map((entry) => `<li>${entry}</li>`).join('')}</${list.tag}>`,
    )
    list = null
  }
  const flushTable = () => {
    if (!table.length) return
    out.push(tableToHtml(table))
    table = []
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushTable()
  }
  const closeSection = () => {
    if (sectionOpen) {
      out.push('</section>')
      sectionOpen = false
    }
  }

  while (index < lines.length) {
    const line = lines[index]
    const fenceStart = /^(`{3,})[ \t]*(.*)$/.exec(line)
    if (fence) {
      if (fenceStart && fenceStart[1].length >= fence.length && !fenceStart[2].trim()) {
        const source = fenceBody.join('\n').replace(/\s+$/, '')
        const words = fenceInfo.trim().split(/\s+/)
        const kind = (words[0] ?? '').toLowerCase()
        if (kind === 'mermaid') {
          out.push(`<pre class="mermaid">${escapeHtml(source)}</pre>`)
        } else if (kind === 'verbatim') {
          const why = /why="([^"]*)"/.exec(fenceInfo)?.[1] ?? ''
          const reason = why || 'TODO: why must these bytes be exact?'
          out.push(`<pre class="verbatim" data-why="${escapeHtml(reason)}">${escapeHtml(source)}</pre>`)
        } else {
          const from = kind === 'pseudo' ? words[1] : kind || ''
          out.push(
            `<pre class="pseudo"${from ? ` data-from-lang="${escapeHtml(from)}"` : ''}>${escapeHtml(source)}</pre>`,
          )
        }
        fence = null
        fenceInfo = ''
        fenceBody = []
        index += 1
        continue
      }
      fenceBody.push(line)
      index += 1
      continue
    }
    if (fenceStart) {
      flushAll()
      fence = fenceStart[1]
      fenceInfo = fenceStart[2] ?? ''
      fenceBody = []
      index += 1
      continue
    }

    if (!line.trim()) {
      flushAll()
      index += 1
      continue
    }

    if (/^<!--[\s\S]*-->\s*$/.test(line.trim())) {
      flushAll()
      out.push(line.trim())
      index += 1
      continue
    }

    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(line)
    if (heading) {
      flushAll()
      const level = heading[1].length
      if (level <= 2) closeSection()
      if (level === 2) {
        const id = slug(heading[2].replace(/<!--.*?-->/g, ''))
        out.push(`<section id="${escapeHtml(id)}">`)
        sectionOpen = true
      }
      out.push(headingHtml(level, heading[2]))
      index += 1
      continue
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph()
      flushList()
      table.push(line)
      index += 1
      continue
    }
    flushTable()

    const bullet = /^(\s*)[-*+][ \t]+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      if (!list || list.tag !== 'ul' || list.indent !== bullet[1].length) {
        flushList()
        list = { tag: 'ul', indent: bullet[1].length, items: [] }
      }
      list.items.push(inlineToHtml(bullet[2]))
      index += 1
      continue
    }
    const ordered = /^(\s*)\d+[.)][ \t]+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      if (!list || list.tag !== 'ol' || list.indent !== ordered[1].length) {
        flushList()
        list = { tag: 'ol', indent: ordered[1].length, items: [] }
      }
      list.items.push(inlineToHtml(ordered[2]))
      index += 1
      continue
    }

    // A wrapped bullet is still part of its item: the continuation line is
    // indented under the marker, and appending it here is what keeps one list
    // item from arriving as a bullet, a paragraph and another bullet.
    if (list && /^\s+/.test(line)) {
      list.items[list.items.length - 1] += ` ${inlineToHtml(line.trim())}`
      index += 1
      continue
    }

    const quote = /^>[ \t]?(.*)$/.exec(line)
    if (quote) {
      flushParagraph()
      flushList()
      out.push(`<blockquote><p>${inlineToHtml(quote[1])}</p></blockquote>`)
      index += 1
      continue
    }

    if (/^---+$/.test(line.trim())) {
      flushAll()
      out.push('<hr>')
      index += 1
      continue
    }

    if (/^(?: {4}|\t)/.test(line)) {
      flushAll()
      const body = []
      while (index < lines.length && (/^(?: {4}|\t)/.test(lines[index]) || !lines[index].trim())) {
        body.push(lines[index].replace(/^(?: {4}|\t)/, ''))
        index += 1
      }
      const source = body.join('\n').replace(/\s+$/, '')
      out.push(`<pre class="verbatim" data-why="the scaffolding is copied byte for byte">${escapeHtml(source)}</pre>`)
      continue
    }

    paragraph.push(line.trim())
    index += 1
  }

  if (fence) {
    // An unclosed fence still has content, and dropping it would lose prose the
    // author wrote. It is rendered as a pseudo block and the checker names the
    // page for review.
    out.push(`<pre class="pseudo">${escapeHtml(fenceBody.join('\n').replace(/\s+$/, ''))}</pre>`)
  }
  flushAll()
  closeSection()
  return out.filter(Boolean).join('\n')
}

/**
 * Wrap a page body in the document shell.
 *
 * @param input - `title`, canonical `text`, and optional `kind` (`index` adds a
 * class the stylesheet can use) and `source` (a complete body to use instead of
 * rendering the text).
 * @returns a complete HTML document.
 */
export function renderMapDocument(input: any) {
  const title = String(input.title ?? '').replace(/\s+/g, ' ').trim() || 'Feature map'
  const body = input.source ?? mapTextToHtmlBody(input.text ?? '')
  const kind = input.kind ? ` ${String(input.kind)}` : ''
  const graphs = /class="mermaid"/.test(body)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="opencode-feature-map">
<title>${escapeHtml(title)} — feature map</title>
<style>
${MAP_CSS}
</style>
</head>
<body>
<article class="map${kind}">
${body}
</article>
${graphs ? MERMAID_LOADER : ''}
</body>
</html>
`
}

/**
 * Convert one Markdown document (a legacy map page, or the index) to HTML.
 *
 * The code-fence policy is the part worth naming: a fence with a language is
 * converted to **pseudocode by default**, tagged `data-from-lang` so a reviewer
 * can see what it came from, and reported as `flagged` — a copied block of real
 * code is prose with unfamiliar syntax in a feature doc, not a spec. A fence
 * already marked `pseudo` is left as pseudocode. A fence marked `verbatim`, or
 * one whose language is `text`/`plain`, keeps its bytes and must carry `why=`;
 * when it does not, the conversion adds a visible placeholder reason and the
 * caller reports it for an author to fill in.
 *
 * @param markdown - the document as written.
 * @param options - `title` falls back to the first `#` heading.
 * @returns `{ html, flagged, verbatim, title }`.
 */
export function markdownToHtmlDocument(markdown, options: any = {}) {
  const source = String(markdown ?? '')
  const flagged = []
  const verbatim = []
  let converted = source
  converted = source.replace(/^(`{3,})[ \t]*([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm, (whole, fence, info, body, offset) => {
    const lineNumber = String(source.slice(0, offset)).split('\n').length
    const words = String(info ?? '').trim().split(/\s+/)
    const kind = (words[0] ?? '').toLowerCase()
    const lang = words.slice(1).join(' ')
    if (kind === 'mermaid') return whole
    if (kind === 'verbatim') {
      if (!/why\s*=/.test(info)) verbatim.push({ line: lineNumber, preview: firstLine(body) })
      return whole
    }
    if (['text', 'plain', 'txt', 'raw'].includes(kind)) {
      if (!/why\s*=/.test(info)) verbatim.push({ line: lineNumber, preview: firstLine(body) })
      return `${fence}verbatim${/why\s*=/.test(info) ? info.slice(kind.length) : ''}\n${body}${fence}`
    }
    if (kind === 'pseudo') return whole
    flagged.push({ line: lineNumber, lang: kind || '(none)', preview: firstLine(body) })
    return `${fence}pseudo${kind ? ` ${kind}` : ''}\n${body}${fence}`
  })
  const title = options.title ?? /^#[ \t]+(.+)$/m.exec(source)?.[1]?.trim() ?? 'Feature map'
  const linked = rewriteProseLinks(converted, options.rewriteLink ?? mapLink)
  return {
    html: renderMapDocument({ title, text: linked }),
    title,
    flagged,
    verbatim,
  }
}

/** The first non-blank line of a block, shortened for a report. */
function firstLine(value) {
  const line = String(value ?? '').split(/\r?\n/).find((entry) => entry.trim()) ?? ''
  return line.trim().slice(0, 80)
}

/**
 * Report the HTML a reviewer should look at without reading every byte.
 *
 * @param html - one page's markup.
 * @returns the `verbatim` blocks with no reason, the pseudo blocks converted
 * from a language, and the number of graphs.
 */
export function scanHtml(html) {
  const report = { verbatimWithoutWhy: [], fromLanguage: [], graphs: 0, sections: 0 }
  const pattern = /<pre\b([^>]*)>/gi
  let match
  while ((match = pattern.exec(String(html ?? '')))) {
    const attrs = parseAttrs(match[1])
    const klass = String(attrs.class ?? '')
    const why = String(attrs['data-why'] ?? '').trim()
    if (/\bverbatim\b/.test(klass) && (!why || /^TODO\b/i.test(why))) {
      report.verbatimWithoutWhy.push(attrs.id || '(unnamed pre)')
    }
    if (attrs['data-from-lang']) report.fromLanguage.push(attrs['data-from-lang'])
    if (/\bmermaid\b/.test(klass)) report.graphs += 1
  }
  report.sections = (String(html ?? '').match(/<h2\b/gi) ?? []).length
  return report
}
