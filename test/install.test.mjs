/**
 * The install/uninstall surface, pinned.
 *
 * A copy install is the only route that works on every platform the loader
 * supports (see scripts/install.mjs for why the config-array path specifiers
 * are not), so the two destructive operations it performs — overwriting a
 * previous copy, and deleting a directory — are tested rather than trusted.
 *
 * Every test runs against a temporary plugins directory; the real one is
 * never touched.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, before, after } from 'node:test'

import { install, remove, pluginDir, configDir } from '../scripts/install.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** A plugins directory in the OS temp area. */
async function scratch() {
  return mkdtemp(join(tmpdir(), 'fm-install-'))
}

describe('the install script', () => {
  let plugins

  before(async () => {
    plugins = await scratch()
  })

  after(async () => {
    await rm(plugins, { recursive: true, force: true })
  })

  it('installs the built package: the manifest, the built output and the data', async () => {
    const target = await install(plugins)
    assert.equal(target, pluginDir(plugins))
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'opencode-feature-map')
    assert.equal(manifest.exports['.'], './dist/index.js')
    for (const part of ['dist/index.js', 'dist/map.js', 'dist/regen.js', 'dist/templates.js']) {
      assert.ok(existsSync(join(target, part)), `installed ${part}`)
    }
    assert.ok(existsSync(join(target, 'templates', 'AGENTS.md.tmpl')), 'the templates shipped')
    // The installed bytes are the built bytes, not a stale edit.
    const built = await readFile(join(repoRoot, 'dist', 'map.js'), 'utf8')
    const copied = await readFile(join(target, 'dist', 'map.js'), 'utf8')
    assert.equal(copied, built)
  })

  it('reinstalls over a previous copy, so upgrading is the same command', async () => {
    const target = pluginDir(plugins)
    await writeFile(join(target, 'dist', 'stale.mjs'), 'stale')
    await install(plugins)
    assert.ok(existsSync(join(target, 'package.json')), 'the manifest survived the reinstall')
    assert.ok(existsSync(join(target, 'dist', 'index.js')), 'the build survived the reinstall')
  })

  it('wipes the target first, so a stale flattened install cannot outlive it', async () => {
    // A previous install that laid the built files at the package root (a
    // flattened index.js beside a dist/) would otherwise keep those files,
    // and the host resolves a plugin entry to the root index.js first.
    const target = await install(plugins)
    await writeFile(join(target, 'templates.js'), 'stale flattened module')
    await install(plugins)
    const entry = await readFile(join(target, 'index.js'), 'utf8')
    assert.match(entry, /export \{ default \} from '\.\/dist\/index\.js'/, 'the entry is the shim')
    assert.ok(!existsSync(join(target, 'templates.js')), 'no stale root modules remain')
    assert.ok(!existsSync(join(target, 'map.js')), 'no stale root modules remain')
    assert.ok(existsSync(join(target, 'dist', 'index.js')), 'the package layout is intact')
  })

  it('removes its own copy, and says so when there is none', async () => {
    const result = await remove(plugins)
    assert.equal(result.state, 'removed')
    assert.ok(!existsSync(pluginDir(plugins)), 'the copy is gone')
    const again = await remove(plugins)
    assert.equal(again.state, 'absent', 'removing what is not installed is not an error')
  })

  it('refuses to remove a directory that is not this package', async () => {
    const target = pluginDir(plugins)
    await mkdir(join(target, 'dist'), { recursive: true })
    await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'someone-elses-plugin' }), 'utf8')
    const result = await remove(plugins)
    assert.equal(result.state, 'foreign')
    assert.equal(result.name, 'someone-elses-plugin')
    assert.ok(existsSync(join(target, 'package.json')), 'the foreign plugin was left alone')
    await rm(plugins, { recursive: true, force: true })
  })

  it('resolves the config directory from the environment, not from the machine', () => {
    const previous = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = join(tmpdir(), 'elsewhere')
    try {
      assert.equal(configDir(), join(tmpdir(), 'elsewhere'))
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
    }
  })
})
