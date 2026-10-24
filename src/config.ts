/**
 * The user's switch for the daily update check: `feature-map.json` beside
 * `opencode.json`.
 *
 * The server half takes its settings from the host (the `options` object), and
 * that is the right place for everything that changes a tool's behaviour. The
 * update check has no host-supplied settings in the TUI process, though, and it
 * is the one thing a user may want to turn off without editing the plugin's
 * config array, so it gets a file of its own:
 *
 * ```json
 * { "updateCheck": false }
 * ```
 *
 * Missing, unreadable and malformed all mean *enabled*: the check is silent,
 * cheap and never blocks a turn, so the failure that costs the user least is
 * 'it ran'. Only an explicit `false` turns it off, which is the same rule the
 * host's own booleans follow.
 *
 * `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME` are honoured so tests never touch
 * a real home directory, and so a user who keeps their config elsewhere is not
 * surprised by a check that ignores it.
 *
 * @module opencode-feature-map/config
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The config file's name, beside `opencode.json(c)`. */
export const CONFIG_FILENAME = 'feature-map.json'

/** Where OpenCode keeps its user configuration, env overridable. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_CONFIG_DIR) return resolve(env.OPENCODE_CONFIG_DIR)
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'opencode')
  return join(homedir(), '.config', 'opencode')
}

/** The config file's full path. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), CONFIG_FILENAME)
}

/**
 * Does this parsed config (or a host `options` object) allow the check?
 *
 * @param value - the parsed file, or whatever the host hands a plugin.
 * @returns `false` only for an explicit `updateCheck: false`;
 *   everything else, including a broken shape, allows the check.
 */
export function parseUpdateCheck(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true
  return (value as { updateCheck?: unknown }).updateCheck !== false
}

/**
 * Read the switch from disk.
 *
 * @param file - the config file, defaulting to {@link configPath}.
 * @returns `false` only when the file is readable JSON with `updateCheck: false`.
 */
export function readUpdateCheck(file: string = configPath()): boolean {
  if (!existsSync(file)) return true
  try {
    return parseUpdateCheck(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return true
  }
}
