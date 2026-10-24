/**
 * The daily update check, pinned: the arithmetic, the switch, and the toast.
 *
 * Three layers, tested at their own level. `dist/update.js` is pure — a clock
 * and a manifest are arguments, so the version comparison and the repeat rule
 * are hammered without a network. `dist/config.js` reads one file, so every
 * test points `OPENCODE_CONFIG_DIR` at a temporary directory and the real
 * `~/.config` is never opened. `dist/tui.js` is the wrapper: it gets a fake
 * context and a stubbed `fetch`, which is also what keeps the suite off the
 * network.
 *
 * The real manifest is read exactly once, to prove the version this build
 * carries is the one the package ships — a bump that forgets the plugin would
 * toast the user about the version they already have.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { configDir, configPath, parseUpdateCheck, readUpdateCheck } from '../dist/config.js'
import {
  CHECK_INTERVAL_MS,
  EMPTY_UPDATE_STATE,
  announceVersion,
  compareVersions,
  dueForCheck,
  parseManifestVersion,
  readPluginVersion,
  updateAvailable,
  updateMessage,
} from '../dist/update.js'
import tui, { setup as setupTui } from '../dist/tui.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** A config directory in the OS temp area, so no test touches a real home. */
async function scratch() {
  return mkdtemp(join(tmpdir(), 'fm-update-'))
}

/** Run `body` with `OPENCODE_CONFIG_DIR` pointed at `dir`. */
async function withConfigDir(dir, body) {
  const before = {
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  process.env.OPENCODE_CONFIG_DIR = dir
  delete process.env.XDG_CONFIG_HOME
  try {
    return await body()
  } finally {
    if (before.OPENCODE_CONFIG_DIR === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = before.OPENCODE_CONFIG_DIR
    if (before.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = before.XDG_CONFIG_HOME
  }
}

/**
 * A fake TUI context: one durable store (shared across `setups` when the same
 * record is passed), one toast list, one idle listener.
 */
function fakeContext(overrides = {}) {
  const record =
    overrides.record ?? { toasts: [], listeners: [], state: { ...EMPTY_UPDATE_STATE } }
  const context = {
    options: overrides.options ?? {},
    storage: {
      store: (_key, { initial }) => {
        // The durable value wins over the initial one, as the host's store does.
        record.state = { ...initial, ...record.state }
        return [
          record.state,
          async (mutation) => {
            mutation(record.state)
          },
        ]
      },
    },
    ui: { toast: { show: (options) => record.toasts.push(options) } },
    data: {
      on: (type, handler) => {
        record.listeners.push({ type, handler })
        return () => {
          record.listeners = record.listeners.filter((entry) => entry.handler !== handler)
        }
      },
    },
    record,
  }
  return context
}

/** Let the fire-and-forget check finish. Every stub here resolves in microtasks. */
async function settle() {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

/** Replace `fetch` for the duration of `body`, restoring it afterwards. */
async function withFetch(implementation, body) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return implementation(url, init)
  }
  try {
    return await body(calls)
  } finally {
    globalThis.fetch = original
  }
}

/** A manifest response carrying `version`. */
function manifest(version) {
  return { ok: true, text: async () => JSON.stringify({ name: 'opencode-feature-map', version }) }
}

test('the config file sits beside opencode.json, and the environment can move it', () => {
  assert.equal(configDir({}).endsWith(join('.config', 'opencode')), true, 'the default is ~/.config/opencode')
  assert.equal(
    configDir({ OPENCODE_CONFIG_DIR: 'C:\\elsewhere\\opencode', XDG_CONFIG_HOME: 'C:\\xdg' }).endsWith(join('elsewhere', 'opencode')),
    true,
    'OPENCODE_CONFIG_DIR wins',
  )
  assert.equal(
    configDir({ XDG_CONFIG_HOME: join('C:', 'xdg') }).endsWith(join('xdg', 'opencode')),
    true,
    'XDG_CONFIG_HOME is the second choice',
  )
  assert.match(configPath({}), /feature-map\.json$/)
  assert.equal(configPath({ OPENCODE_CONFIG_DIR: 'C:\\elsewhere\\opencode' }), 'C:\\elsewhere\\opencode\\feature-map.json')
})

test('only an explicit updateCheck:false turns the check off', () => {
  for (const value of [undefined, null, {}, 'yes', 0, [], { updateCheck: true }, { updateCheck: 'false' }]) {
    assert.equal(parseUpdateCheck(value), true, `${JSON.stringify(value)} allows the check`)
  }
  assert.equal(parseUpdateCheck({ updateCheck: false }), false)
})

test('a missing, empty or malformed file leaves the check on', async () => {
  const dir = await scratch()
  try {
    await withConfigDir(dir, async () => {
      assert.equal(readUpdateCheck(), true, 'no file')
      await writeFile(join(dir, 'feature-map.json'), '')
      assert.equal(readUpdateCheck(), true, 'empty file')
      await writeFile(join(dir, 'feature-map.json'), '{ not json')
      assert.equal(readUpdateCheck(), true, 'malformed file')
      await writeFile(join(dir, 'feature-map.json'), '{"updateCheck": false}')
      assert.equal(readUpdateCheck(), false, 'the switch reads')
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('versions compare numerically, segment by segment', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.2.9', '0.2.10') < 0, true, 'nine is older than ten')
  assert.equal(compareVersions('0.10.0', '0.9.9') > 0, true, 'ten is newer than nine')
  assert.equal(compareVersions('v0.3.0', '0.3.0'), 0, 'a v prefix is not a segment')
  assert.equal(compareVersions('1.0', '1.0.1') < 0, true, 'a missing segment is zero')
  assert.equal(compareVersions('garbage', '0.0.1') < 0, true, 'a malformed version never looks newer')
  assert.equal(updateAvailable('0.2.0', '0.2.1'), true)
  assert.equal(updateAvailable('0.2.1', '0.2.1'), false)
  assert.equal(updateAvailable('0.2.2', '0.2.1'), false)
})

test('a check is due once a day, and after a failed one', () => {
  const now = Date.UTC(2026, 9, 24)
  assert.equal(dueForCheck(0, now), true, 'never checked')
  assert.equal(dueForCheck(Number.NaN, now), true, 'a lost stamp is not a reason to stay quiet')
  assert.equal(dueForCheck(now - 1000, now), false, 'checked a moment ago')
  assert.equal(dueForCheck(now - CHECK_INTERVAL_MS, now), true, 'a day later')
  assert.equal(dueForCheck(now - CHECK_INTERVAL_MS + 1, now), false, 'a millisecond short')
})

test('a manifest body yields its version or nothing', () => {
  assert.equal(parseManifestVersion('{"version":"1.2.3"}'), '1.2.3')
  assert.equal(parseManifestVersion('{"version":" 1.2.3 "}'), '1.2.3')
  assert.equal(parseManifestVersion('{"version":""}'), undefined)
  assert.equal(parseManifestVersion('{"version":12}'), undefined)
  assert.equal(parseManifestVersion('{"name":"x"}'), undefined)
  assert.equal(parseManifestVersion('not json'), undefined)
  assert.equal(parseManifestVersion('null'), undefined)
})

test('one toast per release, and none for the version already installed', () => {
  assert.equal(announceVersion(undefined, '0.3.0', ''), undefined, 'nothing installed')
  assert.equal(announceVersion('0.2.0', undefined, ''), undefined, 'nothing fetched')
  assert.equal(announceVersion('0.3.0', '0.3.0', ''), undefined, 'already current')
  assert.equal(announceVersion('0.3.0', '0.2.0', ''), undefined, 'older than installed')
  assert.equal(announceVersion('0.2.0', '0.3.0', ''), '0.3.0')
  assert.equal(announceVersion('0.2.0', '0.3.0', '0.3.0'), undefined, 'already announced')
  assert.equal(announceVersion('0.2.0', '0.3.1', '0.3.0'), '0.3.1', 'a newer release is announced again')
})

test('the toast says what is available, what is loaded and how to update', () => {
  assert.equal(
    updateMessage('0.2.0', '0.3.0'),
    '0.3.0 is available (installed 0.2.0) - git pull && npm run plugin:install',
  )
})

test('the version this build carries is the version the package ships', async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(readPluginVersion(), manifest.version, 'a bump touches package.json only, and this reads it')
})

test('the TUI half toasts a newer version once, and remembers that it did', async () => {
  const dir = await scratch()
  try {
    await withConfigDir(dir, async () => {
      await withFetch(
        () => manifest('9.9.9'),
        async (calls) => {
          const context = fakeContext()
          const stop = await tui.setup(context)
          await settle()

          assert.equal(calls.length, 1, 'one request for the daily check')
          assert.match(calls[0].url, /^https:\/\/raw\.githubusercontent\.com\/megablue\/opencode-feature-map\//)
          assert.equal(context.record.toasts.length, 1, 'one toast')
          const toast = context.record.toasts[0]
          assert.equal(toast.title, 'feature map update')
          assert.match(toast.message, /^9\.9\.9 is available \(installed \d+\.\d+\.\d+\)/)
          assert.equal(toast.variant, 'info')
          assert.equal(toast.duration, 10_000)

          assert.equal(context.record.state.latest, '9.9.9', 'the newest seen is recorded')
          assert.equal(context.record.state.notified, '9.9.9', 'the announced version is recorded')
          assert.ok(context.record.state.checkedAt > 0, 'the attempt is stamped')

          // The same durable state, a second TUI start: yesterday's answer is
          // not re-fetched and not re-toasted.
          const before = context.record.toasts.length
          const next = fakeContext({ record: context.record })
          const stopAgain = await tui.setup(next)
          await settle()
          assert.equal(calls.length, 1, 'a check within the day does not reach the network')
          assert.equal(next.record.toasts.length, before, 'and does not toast again')
          stop()
          stopAgain()
        },
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an idle turn runs the same check, and the teardown removes it', async () => {
  const dir = await scratch()
  try {
    await withConfigDir(dir, async () => {
      await withFetch(
        () => manifest('9.9.9'),
        async (calls) => {
          const context = fakeContext()
          const stop = await tui.setup(context)
          await settle()
          assert.equal(context.record.listeners.length, 1, 'one idle listener')
          assert.equal(context.record.listeners[0].type, 'session.idle')

          // A day has passed: the idle event is what notices. The release was
          // already announced, so the request repeats and the toast does not.
          context.record.state.checkedAt = Date.now() - CHECK_INTERVAL_MS - 1
          context.record.listeners[0].handler({ data: { sessionID: 'ses_x' } })
          await settle()
          assert.equal(calls.length, 2, 'the idle turn re-checks after a day')
          assert.equal(context.record.toasts.length, 1, 'but one release nags once')

          stop()
          assert.equal(context.record.listeners.length, 0, 'the teardown unsubscribes')
        },
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the check stays silent when there is nothing newer', async () => {
  const dir = await scratch()
  try {
    await withConfigDir(dir, async () => {
      await withFetch(
        () => manifest(readPluginVersion()),
        async () => {
          const context = fakeContext()
          await tui.setup(context)
          await settle()
          assert.equal(context.record.toasts.length, 0, 'the version already installed is not news')
          assert.equal(context.record.state.latest, readPluginVersion(), 'it is still recorded')
          assert.equal(context.record.state.notified, '', 'and not marked announced')
        },
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('updateCheck:false means no request and no toast', async () => {
  const dir = await scratch()
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'feature-map.json'), '{"updateCheck": false}\n')
    await withConfigDir(dir, async () => {
      await withFetch(
        () => manifest('9.9.9'),
        async (calls) => {
          const context = fakeContext()
          const stop = await tui.setup(context)
          await settle()
          assert.equal(calls.length, 0, 'the network is never asked')
          assert.equal(context.record.toasts.length, 0, 'and nothing is shown')
          assert.equal(context.record.listeners.length, 0, 'no listener is registered either')
          stop()
        },
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed fetch is not news: it is stamped, silent, and retried tomorrow', async () => {
  const dir = await scratch()
  try {
    await withConfigDir(dir, async () => {
      await withFetch(
        () => {
          throw new Error('offline')
        },
        async () => {
          const context = fakeContext()
          await tui.setup(context)
          await settle()
          assert.equal(context.record.toasts.length, 0, 'a dead network shows nothing')
          assert.ok(context.record.state.checkedAt > 0, 'but the attempt is stamped, so it waits a day')
          assert.equal(context.record.state.latest, '', 'nothing is recorded as seen')
        },
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a malformed manifest body is treated as no answer', async () => {
  const dir = await scratch()
  try {
    await withConfigDir(dir, async () => {
      await withFetch(
        () => ({ ok: true, text: async () => '<html>rate limited</html>' }),
        async () => {
          const context = fakeContext()
          await tui.setup(context)
          await settle()
          assert.equal(context.record.toasts.length, 0)
          assert.equal(context.record.state.latest, '')
        },
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the TUI half is a complete definition on its own, and its switch also reads options', async () => {
  assert.equal(tui.id, 'feature-map', 'the id is the plugin id')
  assert.equal(typeof tui.setup, 'function')
  assert.equal(tui.setup, setupTui, 'named and default exports are the same function')

  const dir = await scratch()
  try {
    await withConfigDir(dir, async () => {
      await withFetch(
        () => manifest('9.9.9'),
        async (calls) => {
          const context = fakeContext({ options: { updateCheck: false } })
          const stop = await tui.setup(context)
          await settle()
          assert.equal(calls.length, 0, 'the host-supplied switch works too')
          stop()
        },
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a host without storage or a toast still checks and does not throw', async () => {
  const dir = await scratch()
  try {
    await withConfigDir(dir, async () => {
      await withFetch(
        () => manifest('9.9.9'),
        async () => {
          const stop = await tui.setup({})
          await settle()
          stop()
        },
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
