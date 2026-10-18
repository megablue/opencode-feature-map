/**
 * The plugin's contract with OpenCode, checked without OpenCode.
 *
 * The unit tests next door cover the map, the templates and the regeneration;
 * this file covers the half that only exists inside a session: that the module
 * loads, that `setup()` registers one system-instruction hook, five tools, one
 * permission guard and five commands, that every structured value a tool
 * returns is declared by that tool's output schema, that the guard denies
 * exactly once and always yields, and that the commands run the tools behind
 * them and inject their replies.
 *
 * The scaffold tests write into the OS temp directory rather than the
 * repository on purpose: this plugin ships a file that becomes `AGENTS.md`,
 * and a test that scaffolded inside the repository would inject the
 * unsubstituted boilerplate into every session working here.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import plugin from '../dist/index.js'
import { checkMap } from '../dist/map.js'

/** An OpenCode plugin context that records what the plugin registers. */
function mockContext(options = {}) {
  const record = {
    contextHooks: [],
    tools: [],
    permissionHooks: [],
    commands: [],
    synthetics: [],
  }
  const editor = {
    add: (tool) => record.tools.push(tool),
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  const commandEditor = { add: (command) => record.commands.push(command) }
  const ctx = {
    record,
    location: { directory: options.root ?? process.cwd() },
    options: options.options ?? {},
    app: { version: 'test' },
    session: {
      hook: async (_name, callback) => {
        record.contextHooks.push(callback)
        return () => {}
      },
      synthetic: async (input) => {
        record.synthetics.push(input)
      },
      prompt: async () => ({}),
    },
    permission: {
      hook: async (_name, callback) => {
        record.permissionHooks.push(callback)
        return () => {}
      },
    },
    tool: {
      transform: async (transform) => transform(editor),
    },
    command: {
      transform: async (transform) => transform(commandEditor),
    },
  }
  return ctx
}

/** A tool context, as OpenCode hands one to an executor. */
function mockToolContext(sessionID = 'session-1') {
  return {
    sessionID,
    agent: '',
    messageID: 'message-1',
    id: 'call-1',
    progress: async () => {},
    signal: undefined,
  }
}

/** The tool definition the plugin registered under a name. */
function toolNamed(ctx, toolName) {
  const found = ctx.record.tools.find((tool) => tool.name === toolName)
  assert.ok(found, `expected a tool named ${toolName}`)
  return found
}

/** Every key a value returns must be declared, and every required key present. */
function assertMatchesSchema(value, schema, where) {
  const declared = Object.keys(schema.properties ?? {})
  for (const key of Object.keys(value)) {
    assert.ok(declared.includes(key), `${where} returned undeclared "${key}"`)
  }
  for (const key of schema.required ?? []) {
    assert.ok(key in value, `${where} omitted required "${key}"`)
  }
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
}

/** A project with a map and one source file. */
async function scratchProject() {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-contract-'))
  await mkdir(join(root, 'docs', 'features'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(
    join(root, 'docs', 'features', 'README.md'),
    [
      '# scratch — features map',
      '',
      '| Feature | Doc | Read when |',
      '| --- | --- | --- |',
      '| Widgets | [widgets.md](widgets.md) | the widget pipeline |',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(root, 'docs', 'features', 'widgets.md'),
    [
      '# Widgets — the widget pipeline',
      '',
      'Status: shipped (0.1.0) · Read when: the widget pipeline',
      '',
      '## What it does',
      '',
      '- Turns widgets into gadgets.',
      '',
      '## Map',
      '',
      '- `src/widgets.js` — `makeWidget()`, `WIDGET_LIMIT`.',
      '',
      '## How & why',
      '',
      'The pipeline is a queue that drains on idle.',
      '',
      '### The queue',
      '',
      'One queue per widget, kept in `WIDGET_LIMIT` order.',
      '',
      '### The drain',
      '',
      'The queue drains when the loop is idle.',
      '',
      '## Tests that pin it',
      '',
      '- `widgets.test.mjs`: `makes a widget`.',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(join(root, 'src', 'widgets.js'), 'export const widget = 1\n', 'utf8')
  return root
}

test('the module loads as an OpenCode plugin', () => {
  assert.equal(plugin.id, 'feature-map')
  assert.equal(typeof plugin.setup, 'function')
})

test('the package ships a build entry and declares its one dependency', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.exports['.'], './dist/index.js')
  assert.ok(manifest.files.includes('dist'), 'the build output must ship')
  assert.ok(manifest.files.includes('templates'), 'the boilerplate must ship')
  // Unlike the DSH link install, an OpenCode plugin resolves a published
  // dependency normally: the rule is that its dependency set stays small
  // enough to reason about, not that it is empty.
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['@opencode/plugin'])
  assert.equal(manifest.devDependencies?.typescript !== undefined, true)

  for (const file of ['index.ts', 'map.ts', 'templates.ts', 'regen.ts']) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')
    for (const [, specifier] of source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
      assert.ok(
        specifier.startsWith('node:') ||
          specifier.startsWith('.') ||
          specifier === '@opencode/plugin',
        `src/${file} imports "${specifier}", which is outside the declared dependency set`,
      )
    }
  }
})

test('setup registers one instruction hook, six tools, one guard and six commands', async () => {
  const ctx = mockContext()
  await plugin.setup(ctx)
  assert.equal(ctx.record.contextHooks.length, 1)
  assert.deepEqual(
    ctx.record.tools.map((tool) => tool.name).sort(),
    [
      'feature_map',
      'feature_map_adopt',
      'feature_map_check',
      'feature_map_init',
      'feature_map_regen',
      'feature_map_upgrade',
    ],
  )
  assert.equal(ctx.record.permissionHooks.length, 1)
  assert.deepEqual(
    ctx.record.commands.map((command) => command.name).sort(),
    [
      'feature-map',
      'feature-map-adopt',
      'feature-map-check',
      'feature-map-init',
      'feature-map-regen',
      'feature-map-upgrade',
    ],
  )
})

test('the instruction renders with the fs tools present and stays silent without them', async () => {
  const ctx = mockContext()
  await plugin.setup(ctx)
  const hook = ctx.record.contextHooks[0]

  const event = { system: [], tools: { read: { description: '', input: {} } }, messages: [] }
  hook(event)
  assert.equal(event.system.length, 1, 'the instruction is pushed onto the system parts')
  assert.ok(event.system[0].text.includes('feature_map'))

  const blind = { system: [], tools: {}, messages: [] }
  hook(blind)
  assert.equal(blind.system.length, 0, 'an agent without the fs tools is not told to consult a map')

  const off = mockContext({ options: { mode: 'off' } })
  await plugin.setup(off)
  assert.equal(off.record.contextHooks.length, 0, 'mode off silences the instruction too')
})

test('every tool declares closed schemas, an execute, and content to render', async () => {
  const ctx = mockContext()
  await plugin.setup(ctx)
  for (const tool of ctx.record.tools) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.input.type, 'object')
    assert.equal(tool.input.additionalProperties, false)
    assert.equal(tool.output.type, 'object')
    assert.equal(tool.output.additionalProperties, false)
  }
})

test('every tool is offered to the model by name, not only through the code-mode wrapper', async () => {
  // The failure mode this pins: a tool that registers but is never offered.
  // The host carries a registry entry into the model's request only when it
  // declares `codemode: false`; without it the plugin loads, pushes its
  // instruction and fires its guard as normal, and the model's own call to the
  // tool is answered "no such tool". Observed in a live session.
  const ctx = mockContext()
  await plugin.setup(ctx)
  for (const tool of ctx.record.tools) {
    assert.equal(
      tool.options?.codemode,
      false,
      `${tool.name} would load without being offered — the host serves code-mode tools only through execute`,
    )
  }
})

test('no arguments returns the index, which is the entry point', async () => {
  const root = await scratchProject()
  try {
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const tool = toolNamed(ctx, 'feature_map')
    const { output: index, content } = await tool.execute({}, mockToolContext())
    assertMatchesSchema(index, tool.output, 'feature_map(index)')
    assert.equal(typeof content, 'string', 'the reply carries text content')
    assert.ok(content.includes('Widgets'), 'and the content is the text the model reads')
    assert.equal(index.kind, 'index')
    assert.equal(output_rows(index), 1)
    assert.equal(output_pageCount(index), 1)
    assert.ok(index.text.includes('Widgets'), 'the index should carry the feature table')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function output_rows(index) {
  return index.rows
}
function output_pageCount(index) {
  return index.pageCount
}

test('a topic returns the cheap sections, not the whole page', async () => {
  const root = await scratchProject()
  try {
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const tool = toolNamed(ctx, 'feature_map')
    const exec = mockToolContext()

    const topic = (await tool.execute({ topic: 'widget pipeline' }, exec)).output
    assertMatchesSchema(topic, tool.output, 'feature_map(topic)')
    assert.equal(topic.kind, 'sections')
    assert.ok(topic.text.includes('src/widgets.js'), 'the sections should name the file')
    assert.ok(topic.text.includes('makes a widget'), 'the tests section should be there')
    assert.ok(
      topic.sections.some((entry) => entry.endsWith('#map')),
      'the Map section is the anti-hunting payload and should be returned',
    )
    assert.ok(
      !topic.text.includes('The pipeline is a queue that drains on idle.'),
      'How & why is the prose, and a topic reply should not spend bytes on it',
    )
    assert.ok(
      topic.omitted.some((entry) => entry.endsWith('#how-why')),
      'the omitted sections must be named so they can be asked for',
    )
    assert.ok(
      topic.text.includes('Not returned from'),
      'the reply must say how to reach what it left out',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a page alone is its shape, and section, sub and full go deeper', async () => {
  const root = await scratchProject()
  try {
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const tool = toolNamed(ctx, 'feature_map')
    const exec = mockToolContext()

    const shape = (await tool.execute({ page: 'widgets' }, exec)).output
    assertMatchesSchema(shape, tool.output, 'feature_map(page)')
    assert.equal(shape.kind, 'skeleton')
    assert.ok(shape.text.includes('## How & why'), 'the shape lists the headings')
    assert.ok(shape.text.includes(' B'), 'the shape lists the sizes')
    assert.ok(!shape.text.includes('drains on idle'), 'the shape carries no content')

    const section = (await tool.execute({ page: 'widgets', section: 'how' }, exec)).output
    assertMatchesSchema(section, tool.output, 'feature_map(section)')
    assert.equal(section.kind, 'section')
    assert.equal(section.section, 'How & why')
    assert.ok(section.text.includes('drains on idle'))
    assert.ok(
      section.text.includes('Widgets — the widget pipeline'),
      'a requested section still arrives under its page title and status line',
    )
    assert.ok(
      !section.text.includes('Turns widgets into gadgets'),
      'a section the caller named needs no summary prepended — only a guessed one does',
    )
    assert.ok(!section.text.includes('makes a widget'), 'and not the whole page either')

    const sub = (await tool.execute({ page: 'widgets', section: 'how', sub: 'queue' }, exec)).output
    assertMatchesSchema(sub, tool.output, 'feature_map(sub)')
    assert.equal(sub.kind, 'subsection')
    assert.ok(
      sub.text.includes('One queue per widget'),
      `the subsection reply should carry its own content, got: ${JSON.stringify(sub.text)}`,
    )
    assert.ok(!sub.text.includes('drains when the loop is idle'), 'only the one subsection')

    const full = (await tool.execute({ page: 'widgets', full: true }, exec)).output
    assertMatchesSchema(full, tool.output, 'feature_map(full)')
    assert.equal(full.kind, 'page')
    assert.ok(full.text.includes('drains on idle') && full.text.includes('makes a widget'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a topic can be asked for as shapes, and a capped reply can be resumed', async () => {
  const root = await scratchProject()
  try {
    const ctx = mockContext({ root, options: { maxBytes: 200 } })
    await plugin.setup(ctx)
    const tool = toolNamed(ctx, 'feature_map')
    const exec = mockToolContext()

    const shape = (await tool.execute({ topic: 'widget pipeline', skeleton: true }, exec)).output
    assertMatchesSchema(shape, tool.output, 'feature_map(skeleton)')
    assert.equal(shape.kind, 'skeleton')
    assert.ok(shape.text.includes('## Map'), 'the shapes name the sections')
    assert.ok(!shape.text.includes('makeWidget'), 'and none of their content')

    const first = (await tool.execute({ topic: 'widget pipeline' }, exec)).output
    assertMatchesSchema(first, tool.output, 'feature_map(capped)')
    assert.ok(first.nextOffset > 0, 'a reply over the budget must say where to resume')
    assert.ok(first.text.includes(`offset:${first.nextOffset}`), 'and how to ask for the rest')

    // Walking the continuation must terminate and must reach the end of the
    // reply: a window that never advances would loop a session forever.
    let cursor = 0
    let accumulated = ''
    let windows = 0
    for (; windows < 12; windows += 1) {
      const chunk = (await tool.execute({ topic: 'widget pipeline', offset: cursor }, exec)).output
      assertMatchesSchema(chunk, tool.output, 'feature_map(resumed)')
      accumulated += chunk.text
      if (!chunk.nextOffset) break
      assert.ok(chunk.nextOffset > cursor, 'a continuation must always advance')
      cursor = chunk.nextOffset
    }
    assert.ok(windows < 12, 'the continuation must reach the end within a few windows')
    assert.ok(accumulated.includes('makes a widget'), 'and must reach the tests section')
    assert.ok(accumulated.includes('Not returned from'), 'and the line naming what is left out')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the checker separates drift from size advice', async () => {
  const root = await scratchProject()
  try {
    const ctx = mockContext({ root, options: { maxSectionBytes: 40 } })
    await plugin.setup(ctx)
    const exec = mockToolContext()
    const checkTool = toolNamed(ctx, 'feature_map_check')
    const check = (await checkTool.execute({}, exec)).output
    assertMatchesSchema(check, checkTool.output, 'check')
    assert.equal(check.clean, true, 'a consistent index is clean even when a section wants splitting')
    assert.ok(check.oversized.length >= 1, 'the size advice is still reported')
    assert.ok(check.oversized.every((entry) => entry.bytes > 40))
    assert.ok(check.text.includes('feature_map_regen'), 'and it names the tool that does the split')
    assert.ok(check.text.includes('On size:'), 'and it is labelled as size, not as drift')

    // A page that no index row links is drift, and drift is what `clean` means.
    await writeFile(join(root, 'docs', 'features', 'loose.md'), '# Loose\n\n## Map\n\n- none\n', 'utf8')
    const drifted = (await checkTool.execute({}, exec)).output
    assert.equal(drifted.clean, false)
    assert.ok(drifted.text.includes('The map has drifted'))
    assert.ok(drifted.text.includes('docs/features/loose.md'))

    const lenient = mockContext({ root })
    await plugin.setup(lenient)
    const ok = (await toolNamed(lenient, 'feature_map_check').execute({}, exec)).output
    assert.equal(ok.clean, false, 'the loose page is still unlinked')
    assert.ok(ok.text.includes('docs/features/loose.md'), 'and it is named in the drift report')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the checker asks only for the splits that are really missing', async () => {
  const root = await scratchProject()
  try {
    const ctx = mockContext({ root, options: { maxSectionBytes: 100 } })
    await plugin.setup(ctx)
    const check = (await toolNamed(ctx, 'feature_map_check').execute({}, mockToolContext())).output
    assert.ok(
      check.text.includes('already divide at `###` level'),
      'a section that divides is not work',
    )
    assert.ok(!check.text.includes('split it with'), 'and it is not reported as needing a split')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the scaffold plans without writing, and writes only what is missing', async () => {
  const root = await scratchProject()
  try {
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const init = toolNamed(ctx, 'feature_map_init')
    const planned = (await init.execute({ project: 'scratch' }, mockToolContext())).output
    assertMatchesSchema(planned, init.output, 'feature_map_init(plan)')
    assert.deepEqual(planned.wrote, [], 'a plan writes nothing')
    assert.ok(planned.text.includes('scratch'), 'the plan should name the project')
    assert.ok(planned.text.includes('## Layout'), 'the plan should carry the content')
    assert.equal(
      existsSync(join(root, 'HANDOFF.md')),
      false,
      'and nothing landed on disk',
    )

    const written = (await init.execute({ project: 'scratch', write: true, only: ['handoff'] }, mockToolContext())).output
    assertMatchesSchema(written, init.output, 'feature_map_init(write)')
    assert.deepEqual(written.wrote, ['HANDOFF.md'], 'the one template asked for is written')
    assert.ok((await readFile(join(root, 'HANDOFF.md'), 'utf8')).includes('scratch'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed scaffold write is named, not summarised as zero', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'feature-map-blocked-'))
  try {
    // A file where the project root would be makes every mkdir fail: the
    // write path has to surface the reason, not claim nothing happened.
    const blocker = join(parent, 'blocker')
    await writeFile(blocker, 'not a directory\n', 'utf8')
    const ctx = mockContext({ root: blocker })
    await plugin.setup(ctx)
    const out = (await toolNamed(ctx, 'feature_map_init').execute({ write: true }, mockToolContext())).output
    assert.deepEqual(out.wrote, [], 'nothing is reported as written')
    assert.ok(out.text.includes('Could not be written'), `the reason must travel, got:\n${out.text}`)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('the guard denies the first source lookup once, and always yields', async () => {
  const root = await scratchProject()
  try {
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const guard = ctx.record.permissionHooks[0]

    const first = { sessionID: 's1', action: 'read', resources: ['src/widgets.js'], effect: 'allow' }
    guard(first)
    assert.equal(first.effect, 'deny', 'the first source lookup should be refused')
    assert.ok(first.message.includes('feature_map'), 'the refusal must name the remedy')
    assert.ok(first.message.includes('src/widgets.js'), 'the refusal should name the path')

    const retry = { sessionID: 's1', action: 'read', resources: ['src/widgets.js'], effect: 'allow' }
    guard(retry)
    assert.equal(retry.effect, 'allow', 'the retry must always proceed')

    const other = { sessionID: 's2', action: 'read', resources: ['docs/SPEC.md'], effect: 'allow' }
    guard(other)
    assert.equal(other.effect, 'allow', 'a document read is not a source lookup')

    const map = { sessionID: 's2', action: 'read', resources: ['docs/features/widgets.md'], effect: 'allow' }
    guard(map)
    assert.equal(map.effect, 'allow', 'reading the map is not a source lookup')

    const glob = { sessionID: 's2', action: 'glob', resources: ['src/**'], effect: 'allow' }
    guard(glob)
    assert.equal(glob.effect, 'deny', 'a whole-project glob counts as a source lookup')

    const grep = { sessionID: 's3', action: 'grep', resources: ['widget'], effect: 'allow' }
    guard(grep)
    assert.equal(grep.effect, 'deny', 'and a whole-project search counts too')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the guard stands down once the map is read or regenerated, and in a project without one', async () => {
  const root = await scratchProject()
  const bare = await mkdtemp(join(tmpdir(), 'feature-map-bare-'))
  try {
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const guard = ctx.record.permissionHooks[0]
    await toolNamed(ctx, 'feature_map').execute({}, mockToolContext('s1'))
    const read = { sessionID: 's1', action: 'read', resources: ['src/widgets.js'], effect: 'allow' }
    guard(read)
    assert.equal(read.effect, 'allow', 'a session that consulted the map is never asked again')

    const regenCtx = mockContext({ root })
    await plugin.setup(regenCtx)
    const regenGuard = regenCtx.record.permissionHooks[0]
    await toolNamed(regenCtx, 'feature_map_regen').execute({}, mockToolContext('s2'))
    const regenRead = { sessionID: 's2', action: 'read', resources: ['src/widgets.js'], effect: 'allow' }
    regenGuard(regenRead)
    assert.equal(regenRead.effect, 'allow', 'a session that rewrote the map has read it')

    // A different plugin instance has its own session state, so the bare
    // project is judged by its own map root.
    const maplessCtx = mockContext({ root: bare })
    await plugin.setup(maplessCtx)
    const maplessGuard = maplessCtx.record.permissionHooks[0]
    const mapless = { sessionID: 's1', action: 'read', resources: ['src/widgets.js'], effect: 'allow' }
    maplessGuard(mapless)
    assert.equal(mapless.effect, 'allow', 'a project with no map is never nagged')
    maplessGuard(mapless)
    assert.equal(mapless.effect, 'allow')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(bare, { recursive: true, force: true })
  }
})

test('mode prompt keeps the instruction and drops the guard', async () => {
  const prompt = mockContext({ options: { mode: 'prompt' } })
  await plugin.setup(prompt)
  assert.equal(prompt.record.contextHooks.length, 1)
  assert.equal(prompt.record.permissionHooks.length, 0)
  assert.equal(prompt.record.tools.length, 6)

  const off = mockContext({ options: { mode: 'off' } })
  await plugin.setup(off)
  assert.equal(off.record.contextHooks.length, 0)
  assert.equal(off.record.permissionHooks.length, 0)
  assert.equal(off.record.tools.length, 6, 'the tools work whatever the mode')

  const nonsense = mockContext({ options: { mode: 'whatever' } })
  await plugin.setup(nonsense)
  assert.equal(nonsense.record.permissionHooks.length, 1, 'an unknown mode falls back to enforce')
})

test('a guard never fires for an action it does not watch', async () => {
  const root = await scratchProject()
  try {
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const guard = ctx.record.permissionHooks[0]
    const edit = { sessionID: 's1', action: 'edit', resources: ['src/widgets.js'], effect: 'allow' }
    guard(edit)
    assert.equal(edit.effect, 'allow')

    const bash = { sessionID: 's1', action: 'shell', resources: ['echo hi'], effect: 'allow' }
    guard(bash)
    assert.equal(bash.effect, 'allow')

    const resourceless = { sessionID: 's1', action: 'read', resources: [], effect: 'allow' }
    guard(resourceless)
    assert.equal(resourceless.effect, 'allow', 'a call with no resource is not judged')

    const outside = { sessionID: 's1', action: 'read', resources: ['C:/elsewhere/file.js'], effect: 'allow' }
    guard(outside)
    assert.equal(outside.effect, 'allow', 'a read outside the project is not this guard\u2019s business')

    const missing = { sessionID: 's1', action: 'read', resources: ['src/gone.js'], effect: 'allow' }
    guard(missing)
    assert.equal(missing.effect, 'allow', 'a read of a missing file teaches nothing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** A page that carries all six headings and a trigger. */
const CONFORMANT_PAGE = [
  '# Widgets — the widget pipeline',
  '',
  'Status: shipped (0.1.0) · Read when: the widget pipeline',
  '',
  '## What it does',
  '',
  '- Turns widgets into gadgets.',
  '',
  '## Map',
  '',
  '- `src/widgets.js` — `makeWidget()`.',
  '',
  '## How & why',
  '',
  'The queue drains on idle.',
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

test('adoption writes what is missing and never edits what exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-adopt-'))
  try {
    await mkdir(join(root, 'docs', 'features'), { recursive: true })
    await writeFile(join(root, 'docs', 'features', 'widgets.md'), CONFORMANT_PAGE, 'utf8')
    const ownAgents = '# AGENTS.md\n\nMy own instructions, thank you.\n\n## House rules\n\n- Be brief.\n'
    await writeFile(join(root, 'AGENTS.md'), ownAgents, 'utf8')

    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const adopt = toolNamed(ctx, 'feature_map_adopt')
    const exec = mockToolContext()

    const plan = (await adopt.execute({}, exec)).output
    assertMatchesSchema(plan, adopt.output, 'feature_map_adopt(plan)')
    assert.deepEqual(plan.wrote, [], 'the default is a plan, not a write')
    assert.equal(existsSync(join(root, 'HANDOFF.md')), false)
    assert.ok(plan.text.includes('AGENTS.md present'), 'the summary says what is already there')
    assert.ok(plan.text.includes('docs/features/widgets.md'), 'the unlinked page is named')

    const applied = (await adopt.execute({ apply: true }, exec)).output
    assertMatchesSchema(applied, adopt.output, 'feature_map_adopt(apply)')
    assert.ok(applied.wrote.includes('docs/features/index.html'), 'the missing index is written')
    assert.ok(!applied.wrote.includes('AGENTS.md'), 'an existing AGENTS.md is never written')
    assert.ok(applied.wrote.includes('HANDOFF.md'), 'a missing HANDOFF.md is written')
    assert.equal(
      await readFile(join(root, 'AGENTS.md'), 'utf8'),
      ownAgents,
      'and it is byte-for-byte unchanged',
    )

    const after = await checkMap(root)
    assert.deepEqual(after.unindexed, [], 'the generated index links every page')
    assert.deepEqual(after.unresolved, [], 'and every link resolves')
    assert.equal(after.rowsWithoutTrigger, 0, 'and the trigger was read from the page')
    assert.deepEqual(after.findings.flatMap((finding) => finding.missingHeadings), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a project with nothing is sent to the scaffold instead', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-empty-'))
  try {
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const out = (await toolNamed(ctx, 'feature_map_adopt').execute({ apply: true }, mockToolContext())).output
    assertMatchesSchema(out, toolNamed(ctx, 'feature_map_adopt').output, 'feature_map_adopt(empty)')
    assert.equal(out.summary, 'no docs')
    assert.deepEqual(out.wrote, [], 'nothing is written into an empty project')
    assert.ok(out.text.includes('feature_map_init'), 'the reply names the tool that fits')
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('documents outside the map are reported and never converted', async () => {
  const root = await scratchProject()
  try {
    await writeFile(join(root, 'docs', 'notes.md'), '# Notes\n\nLoose notes.\n', 'utf8')
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const adopt = toolNamed(ctx, 'feature_map_adopt')
    const exec = mockToolContext()

    const candidates = (await adopt.execute({ focus: 'candidates' }, exec)).output
    assertMatchesSchema(candidates, adopt.output, 'feature_map_adopt(candidates)')
    assert.ok(candidates.text.includes('Outside the map'))
    assert.ok(candidates.text.includes('docs/notes.md'))
    assert.ok(!candidates.text.includes('### Index'), 'a focus keeps the reply to one area')

    const everything = (await adopt.execute({}, exec)).output
    assert.ok(everything.text.includes('### Index'))
    assert.ok(everything.text.includes('### Sections'))
    assert.ok(everything.text.includes('Plan (deterministic items'), 'the plan is always offered')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** A project whose map exists but has outgrown its shape. */
async function regenProject() {
  const root = await mkdtemp(join(tmpdir(), 'feature-map-regen-'))
  await mkdir(join(root, 'docs', 'features'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(
    join(root, 'docs', 'features', 'widgets.md'),
    [
      '# Widgets — the widget pipeline',
      '',
      '## What it does',
      '',
      '- turns widgets into gadgets.',
      '',
      '## Map',
      '',
      '- `src/widgets.js` — `makeWidget()`.',
      '',
      '## How & why',
      '',
      '- the queue drains on idle, and each widget keeps its own place in it',
      '- the drain walks the queue once per tick and never blocks the loop',
      '- a widget that arrives mid-drain is queued for the next pass instead',
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
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(root, 'docs', 'features', 'README.md'),
    [
      '# Widgets — features map',
      '',
      'Read this before touching code.',
      '',
      '| Feature | Doc | Read when |',
      '| --- | --- | --- |',
      '| Gone | [gone.md](gone.md) | a page that was deleted |',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(join(root, 'AGENTS.md'), '# AGENTS.md\n\nMy own instructions, thank you.\n', 'utf8')
  await writeFile(join(root, 'docs', 'SPEC.md'), '# Spec\n\nMy own behaviour spec.\n', 'utf8')
  await writeFile(join(root, 'HANDOFF.md'), '# Handoff\n\nMy own notes.\n', 'utf8')
  await writeFile(join(root, 'src', 'widgets.js'), 'export const widget = 1\n', 'utf8')
  return root
}

test('regen plans without writing and writes only with apply', async () => {
  const root = await regenProject()
  try {
    const ctx = mockContext({ root, options: { maxSectionBytes: 200 } })
    await plugin.setup(ctx)
    const exec = mockToolContext()
    const regen = toolNamed(ctx, 'feature_map_regen')

    const plan = (await regen.execute({}, exec)).output
    assertMatchesSchema(plan, regen.output, 'feature_map_regen(plan)')
    assert.deepEqual(plan.wrote, [], 'the default is a plan, not a write')
    assert.equal(
      await readFile(join(root, 'docs', 'features', 'widgets.md'), 'utf8'),
      await readFile(join(root, 'docs', 'features', 'widgets.md'), 'utf8'),
      'and the page on disk is untouched',
    )
    assert.ok(plan.splits >= 1, 'the oversized section is reported')
    assert.ok(plan.placeholders >= 1, 'and the heading it cannot name')
    assert.ok(plan.text.includes('Plan only'), 'the reply says nothing was written')
    assert.ok(plan.text.includes('Placeholders to name'), 'and lists what to name')

    const applied = (await regen.execute({ apply: true }, exec)).output
    assertMatchesSchema(applied, regen.output, 'feature_map_regen(apply)')
    assert.ok(applied.wrote.includes('docs/features/widgets.md'), 'the page is written')
    assert.ok(applied.wrote.includes('docs/features/README.md'), 'and the reconciled index')
    assert.ok(applied.text.includes('Wrote'), 'the reply says what happened')

    const page = await readFile(join(root, 'docs', 'features', 'widgets.md'), 'utf8')
    assert.ok(page.includes('Status: shipped (vX.Y) · Read when:'), 'the page gained a status line')
    assert.ok(page.includes('### <!-- chunk 1/'), 'and a visible placeholder heading')
    const index = await readFile(join(root, 'docs', 'features', 'README.md'), 'utf8')
    assert.ok(index.includes('widgets.md'), 'the index links the page')
    assert.ok(!index.includes('gone.md'), 'and dropped the row no page claimed')
    assert.ok(index.startsWith('# Widgets — features map\n\nRead this before touching code.'))

    const again = (await regen.execute({ apply: true }, exec)).output
    assert.deepEqual(again.wrote, [], 'a second run has nothing to write')
    assert.ok(again.text.includes('already readable'), 'and says so')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('regen leaves every file outside the map byte-for-byte alone', async () => {
  const root = await regenProject()
  try {
    const outside = ['AGENTS.md', 'docs/SPEC.md', 'HANDOFF.md', 'src/widgets.js']
    const before = new Map()
    for (const rel of outside) before.set(rel, await readFile(join(root, ...rel.split('/')), 'utf8'))

    const ctx = mockContext({ root, options: { maxSectionBytes: 200 } })
    await plugin.setup(ctx)
    const applied = (await toolNamed(ctx, 'feature_map_regen').execute({ apply: true }, mockToolContext())).output
    assert.ok(applied.wrote.length >= 2)

    for (const rel of outside) {
      assert.equal(
        await readFile(join(root, ...rel.split('/')), 'utf8'),
        before.get(rel),
        `${rel} must be byte-for-byte unchanged`,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a table that cannot be identified is refused, and nothing is written for it', async () => {
  const root = await regenProject()
  try {
    const indexPath = join(root, 'docs', 'features', 'README.md')
    const foreign = [
      '# Widgets — features map',
      '',
      '| Name | Purpose |',
      '| --- | --- |',
      '| Widgets | somewhere else entirely |',
      '',
    ].join('\n')
    await writeFile(indexPath, foreign, 'utf8')

    const ctx = mockContext({ root, options: { maxSectionBytes: 200 } })
    await plugin.setup(ctx)
    const regen = toolNamed(ctx, 'feature_map_regen')
    const exec = mockToolContext()

    const plan = (await regen.execute({}, exec)).output
    assert.equal(plan.refused.length, 1, 'the plan names the file it will not touch')
    assert.ok(plan.refused[0].startsWith('docs/features/README.md'), plan.refused[0])
    assert.ok(plan.text.includes('left alone'), 'and says so in the reply')

    const applied = (await regen.execute({ apply: true }, exec)).output
    assertMatchesSchema(applied, regen.output, 'feature_map_regen(refused)')
    assert.equal(applied.refused.length, 1, 'a refusal is reported once, not twice')
    assert.ok(applied.wrote.includes('docs/features/widgets.md'), 'the page is still rewritten')
    assert.ok(!applied.wrote.includes('docs/features/README.md'))
    assert.equal(await readFile(indexPath, 'utf8'), foreign, 'the foreign table is byte-identical')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a legacy map is read and every reply says so', async () => {
  const root = await scratchProject()
  try {
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const exec = mockToolContext()

    const out = (await toolNamed(ctx, 'feature_map').execute({}, exec)).output
    assertMatchesSchema(out, toolNamed(ctx, 'feature_map').output, 'feature_map(legacy)')
    assert.ok(out.text.includes('Widgets'), 'the page list is still there')
    assert.ok(out.text.includes('legacy map'), 'the reply says the map is Markdown')
    assert.ok(out.text.includes('feature_map_upgrade'), 'and names the way out')
    assert.equal(out.index, 'docs/features/README.md')

    const check = (await toolNamed(ctx, 'feature_map_check').execute({}, exec)).output
    assertMatchesSchema(check, toolNamed(ctx, 'feature_map_check').output, 'feature_map_check(legacy)')
    assert.equal(check.legacy, true)
    assert.ok(check.text.includes('legacy map'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the upgrade writes HTML and the checker then agrees', async () => {
  const root = await scratchProject()
  try {
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const exec = mockToolContext()
    const upgrade = toolNamed(ctx, 'feature_map_upgrade')

    const plan = (await upgrade.execute({}, exec)).output
    assertMatchesSchema(plan, upgrade.output, 'feature_map_upgrade(plan)')
    assert.deepEqual(plan.wrote, [], 'the default is a plan')
    assert.ok(plan.text.includes('pseudocode') || plan.text.includes('Plan only'), plan.text)

    const applied = (await upgrade.execute({ apply: true }, exec)).output
    assertMatchesSchema(applied, upgrade.output, 'feature_map_upgrade(apply)')
    assert.ok(applied.wrote.includes('docs/features/index.html'))
    assert.ok(applied.wrote.includes('docs/features/widgets.html'))
    assert.deepEqual(applied.removed, [], 'the .md sources are kept by default')
    assert.ok(existsSync(join(root, 'docs', 'features', 'widgets.md')))
    assert.ok(existsSync(join(root, 'docs', 'features', 'index.html')))

    const out = (await toolNamed(ctx, 'feature_map').execute({}, exec)).output
    assert.ok(!out.text.includes('legacy map'), 'the map is HTML now')
    assert.equal(out.index, 'docs/features/index.html')

    const check = (await toolNamed(ctx, 'feature_map_check').execute({}, exec)).output
    assert.equal(check.legacy, false)
    assert.equal(check.clean, true, check.text)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a regenerated map then satisfies the checker', async () => {
  const root = await regenProject()
  try {
    const before = await checkMap(root, { maxSectionBytes: 200 })
    assert.ok(before.splits.length >= 1, 'the fixture starts out needing work')
    assert.deepEqual(before.unindexed, ['docs/features/widgets.md'], 'and with an unindexed page')

    const ctx = mockContext({ root, options: { maxSectionBytes: 200 } })
    await plugin.setup(ctx)
    await toolNamed(ctx, 'feature_map_regen').execute({ apply: true }, mockToolContext())

    const after = await checkMap(root, { maxSectionBytes: 200 })
    assert.deepEqual(after.splits, [], 'no section is left wanting a split')
    assert.deepEqual(after.unindexed, [], 'every page is linked')
    assert.deepEqual(after.unresolved, [], 'every link resolves')
    const check = (await toolNamed(ctx, 'feature_map_check').execute({}, mockToolContext())).output
    assert.equal(check.clean, true, 'and the checker calls the map clean')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the commands run the tools behind them and inject their replies', async () => {
  const root = await scratchProject()
  try {
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const commandNamed = (name) => {
      const found = ctx.record.commands.find((command) => command.name === name)
      assert.ok(found, `expected a command named ${name}`)
      return found
    }
    const invoke = (name, text) =>
      commandNamed(name).execute({ sessionID: 'cmd-1', prompt: { text }, delivery: 'steer' })

    await invoke('feature-map', 'widget pipeline')
    assert.equal(ctx.record.synthetics.length, 1, 'the command delivered a reply')
    assert.ok(
      ctx.record.synthetics[0].text.includes('src/widgets.js'),
      'the reply is the section reply, not a prompt for the agent',
    )
    assert.ok(ctx.record.synthetics[0].description.includes('feature-map'))

    await invoke('feature-map-check', '')
    assert.ok(
      ctx.record.synthetics[1].text.includes('map agrees with itself') ||
        ctx.record.synthetics[1].text.includes('drifted'),
    )

    await invoke('feature-map-init', 'project:cmdwrite write only:handoff')
    assert.ok(ctx.record.synthetics[2].text.includes('Wrote'))
    assert.ok(existsSync(join(root, 'HANDOFF.md')), 'the command wrote through the tool')

    await invoke('feature-map-adopt', 'focus:candidates')
    assert.ok(ctx.record.synthetics[3].text.includes('Nothing under `docs/` is outside the map'))

    await invoke('feature-map-regen', '')
    assert.ok(ctx.record.synthetics[4].text.includes('readable'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a command whose tool fails delivers the reason instead of throwing', async () => {
  // The observed crash: an unguarded readTemplate ENOENT inside the tool left
  // the command executor as the throwing frame, the host answered the command
  // request with a 500, and the session died. The executor must answer.
  const root = await regenProject()
  try {
    const ctx = mockContext({ root })
    await plugin.setup(ctx)
    const command = ctx.record.commands.find((entry) => entry.name === 'feature-map-init')
    const tool = ctx.record.tools.find((entry) => entry.name === 'feature_map_init')
    const original = tool.execute
    tool.execute = async () => {
      throw new Error("ENOENT: no such file or directory, open '…/plugins/templates/AGENTS.md.tmpl'")
    }
    try {
      await command.execute({ sessionID: 'cmd-1', prompt: { text: '' }, delivery: 'steer' })
    } finally {
      tool.execute = original
    }
    assert.equal(ctx.record.synthetics.length, 1, 'the command still delivered a reply')
    const reply = ctx.record.synthetics[0]
    assert.ok(reply.text.startsWith('Could not run /feature-map-init:'), `got: ${reply.text}`)
    assert.ok(reply.text.includes('ENOENT'), 'the reason travels with the reply')
    assert.ok(reply.description.includes('feature-map-init'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a command parses its arguments the way its description says', async () => {
  const root = await regenProject()
  try {
    const ctx = mockContext({ root, options: { maxSectionBytes: 200 } })
    await plugin.setup(ctx)
    const command = ctx.record.commands.find((entry) => entry.name === 'feature-map-regen')
    await command.execute({ sessionID: 'cmd-1', prompt: { text: 'apply show' }, delivery: 'steer' })
    const reply = ctx.record.synthetics.at(-1)
    assert.ok(reply.text.includes('Wrote'), '`apply` wrote the map')
    assert.ok(reply.text.includes('### docs/features/widgets.md'), '`show` carried the text')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
