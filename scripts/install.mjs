/**
 * Install (or uninstall) this plugin into an OpenCode plugins directory.
 *
 * OpenCode loads a plugin either from the `plugins` array in `opencode.json(c)`
 * or from the discovery layout — `.opencode/plugins/` for a project and
 * `~/.config/opencode/plugins/` globally. This script installs into the
 * discovery layout, because on Windows the path specifiers the config array
 * accepts (`file:///…`, `/absolute/path`, a `../`-relative path) are silently
 * dropped by the loader in the versions this plugin was verified against
 * (2.0.26), while the discovery directory works everywhere.
 *
 * The installed copy is the built package: `dist/`, `templates/` and
 * `package.json` — exactly what `files` in `package.json` ships, so what runs
 * here is what an `npm pack` consumer gets. It is a copy, not a link: a
 * junction or symlink into the checkout resolves to the link's real path on
 * Windows, which the loader then treats as outside the plugins directory.
 *
 * Usage:
 *   node scripts/install.mjs                 # global: ~/.config/opencode/plugins/feature-map
 *   node scripts/install.mjs --project       # this project: .opencode/plugins/feature-map
 *   node scripts/install.mjs --target <dir>  # an explicit plugins directory
 *   node scripts/install.mjs --remove        # uninstall from that target
 *
 * Exits non-zero on a failed install, so a shell chain stops rather than
 * reporting success with nothing installed.
 *
 * @module install
 */

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

/** This package's name, which an installed copy must carry. */
const PACKAGE_NAME = 'opencode-feature-map'

/** What a copy consists of: the built output, the shipped data, and the manifest. */
const PARTS = ['package.json', 'dist', 'templates']

/**
 * The entry file the discovery loader reads.
 *
 * OpenCode resolves an immediate plugin package directory to its root
 * `index.js`/`index.ts`, **not** to the manifest's `main` or `exports` —
 * observed, not deduced: the same package installed with `dist/` intact and
 * no root entry did not load at all (`opencode plugin list` dropped it
 * without a log line), while a root `index.js` loaded. The installed copy
 * therefore keeps the shipped `dist/` layout and gains a one-line re-export
 * at the root: the shim is the entire bridge, and the built files are what
 * actually run.
 */
const ENTRY_SHIM = "export { default } from './dist/index.js'\n"

/** The repository this script lives in. */
const REPO_ROOT = resolve(import.meta.dirname, '..')

/**
 * The default OpenCode config directory, overridable for tests and for a user
 * whose config lives elsewhere (`XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR`).
 *
 * @returns the directory that holds `opencode.json(c)` and `plugins/`.
 */
export function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return resolve(process.env.OPENCODE_CONFIG_DIR)
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'opencode')
  return join(homedir(), '.config', 'opencode')
}

/**
 * The plugin directory inside a plugins directory.
 *
 * @param pluginsDir - a plugins directory (global or project `.opencode/plugins`).
 * @returns the `feature-map` package directory inside it.
 */
export function pluginDir(pluginsDir) {
  return join(resolve(pluginsDir), 'feature-map')
}

/**
 * Copy one file or one directory tree, creating parents as needed.
 *
 * @param from - source path.
 * @param to - destination path.
 */
async function copyTree(from, to) {
  const info = await stat(from).catch(() => null)
  if (!info) throw new Error(`missing ${from} — run \`npm run build\` first`)
  if (info.isDirectory()) {
    await mkdir(to, { recursive: true })
    for (const entry of await readdir(from)) {
      await copyTree(join(from, entry), join(to, entry))
    }
  } else {
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }
}

/**
 * Install the built package into a plugins directory.
 *
 * The target is replaced rather than merged into: a previous install that
 * laid the built files out differently (a flattened root `index.js` beside a
 * `dist/`) would keep those files, and the host resolves a plugin entry to
 * whichever it finds first. Wiping first makes the installed copy exactly
 * what this package's `files` ships, so upgrading repairs as well as updates.
 *
 * @param pluginsDir - the plugins directory to install into.
 * @returns the installed plugin directory.
 */
export async function install(pluginsDir) {
  const target = pluginDir(pluginsDir)
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const part of PARTS) {
    await copyTree(join(REPO_ROOT, part), join(target, part))
  }
  await writeFile(join(target, 'index.js'), ENTRY_SHIM, 'utf8')
  return target
}

/**
 * Uninstall, but only a copy of *this* package.
 *
 * A directory in the plugins path that is not this package — a hand-placed
 * plugin, another tool's global install — is named and left alone. Deleting
 * someone else's plugin directory is not what `--remove` is for.
 *
 * @param pluginsDir - the plugins directory to remove from.
 * @returns what happened, for the caller to print.
 */
export async function remove(pluginsDir) {
  const target = pluginDir(pluginsDir)
  if (!existsSync(target)) return { state: 'absent', target }
  const manifest = join(target, 'package.json')
  let name = null
  try {
    name = JSON.parse(await readFile(manifest, 'utf8')).name
  } catch {
    name = null
  }
  if (name !== PACKAGE_NAME) {
    return { state: 'foreign', target, name }
  }
  await rm(target, { recursive: true, force: true })
  return { state: 'removed', target }
}

/**
 * Command-line entry.
 *
 * @param argv - arguments after the script name.
 * @returns the process exit code.
 */
export async function main(argv = process.argv.slice(2)) {
  const uninstall = argv.includes('--remove')
  let pluginsDir
  if (argv.includes('--project')) pluginsDir = join(process.cwd(), '.opencode', 'plugins')
  else if (argv.includes('--target')) pluginsDir = argv[argv.indexOf('--target') + 1]
  else pluginsDir = join(configDir(), 'plugins')
  if (!pluginsDir) {
    process.stderr.write('install: --target needs a directory\n')
    return 2
  }

  try {
    if (uninstall) {
      const result = await remove(pluginsDir)
      if (result.state === 'absent') {
        process.stdout.write(`Not installed: ${result.target} does not exist.\n`)
      } else if (result.state === 'foreign') {
        process.stderr.write(
          `Refused: ${result.target} is package "${result.name ?? 'unnamed'}", not ${PACKAGE_NAME}.\n`,
        )
        return 1
      } else {
        process.stdout.write(`Removed ${result.target}\n`)
      }
      return 0
    }

    const target = await install(pluginsDir)
    process.stdout.write(`Installed ${target}\n`)
    process.stdout.write(
      'A running server picks this up from the plugins directory; if it does not, run `opencode service restart`.\n',
    )
    return 0
  } catch (error) {
    process.stderr.write(`install failed: ${error?.message ?? String(error)}\n`)
    return 1
  }
}

// Running as a script, not imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code))
}
