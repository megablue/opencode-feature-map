/**
 * The update check's arithmetic, and the version this build carries.
 *
 * Which version is newer, whether a check is due, and whether this version is
 * worth announcing are all pure functions: no clock, no network, no host. The
 * check itself lives in `tui.ts`, because the server half's context has no
 * toast — a notice about the plugin cannot come from the half that builds the
 * payload. Keeping the decision here means the network path stays a thin
 * wrapper over rules the suite can hammer.
 *
 * The manifest is the one on the default branch: a raw file read of
 * `package.json`, so there is no release feed, no API key and no parsing of
 * anything but a version string.
 *
 * @module opencode-feature-map/update
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The manifest on the default branch, the newest number anyone has published. */
export const UPDATE_MANIFEST_URL =
  'https://raw.githubusercontent.com/megablue/opencode-feature-map/main/package.json'

/** How often the check may reach the network, in milliseconds. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** The durable piece of TUI state: when we last looked, what we saw, what we said. */
export interface UpdateState {
  /** Wall-clock milliseconds of the last completed attempt (0 = never). */
  checkedAt: number
  /** The newest version seen so far, or "" before the first successful read. */
  latest: string
  /** The version already toasted, so one release nags once. */
  notified: string
}

/** The state a fresh store starts from. */
export const EMPTY_UPDATE_STATE: UpdateState = { checkedAt: 0, latest: '', notified: '' }

/**
 * The installed copy's own `package.json`, one level above this file.
 *
 * `src/update.ts` builds to `dist/update.js` in the repository and the same
 * relative layout is what `scripts/install.mjs` copies, so the path holds in
 * both places. It is read, never derived: an installed copy has no git history,
 * and the host must not run git to answer "which version is loaded".
 */
export const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url))

function segments(version: string): number[] {
  return String(version)
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => {
      const value = Number.parseInt(part, 10)
      return Number.isFinite(value) && value > 0 ? value : 0
    })
}

/**
 * Compare two `MAJOR.MINOR.PATCH` strings numerically, segment by segment.
 *
 * Numeric comparison is the point: `0.2.9` is older than `0.2.10`, which a
 * string compare gets backwards. A missing or unparsable segment counts as 0,
 * so a malformed manifest can never look newer than a real version.
 *
 * @returns a negative number when `a` is older, positive when newer, 0 when equal.
 */
export function compareVersions(a: string, b: string): number {
  const left = segments(a)
  const right = segments(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Is `latest` a newer version than `installed`? */
export function updateAvailable(installed: string, latest: string): boolean {
  return compareVersions(latest, installed) > 0
}

/** True when no check has run, or the last one is at least {@link CHECK_INTERVAL_MS} old. */
export function dueForCheck(lastAttempt: number, now: number): boolean {
  if (!Number.isFinite(lastAttempt) || lastAttempt <= 0) return true
  return now - lastAttempt >= CHECK_INTERVAL_MS
}

/** The `version` field of a manifest body, or `undefined` when the text is not one. */
export function parseManifestVersion(body: string): string | undefined {
  try {
    const manifest = JSON.parse(body) as { version?: unknown }
    const version = manifest?.version
    return typeof version === 'string' && version.trim().length > 0 ? version.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * The version worth a toast, or `undefined` for silence.
 *
 * Three silences: nothing installed, nothing fetched, and "not newer". The
 * fourth is the repeat rule — a version already announced stays quiet until a
 * newer one appears, so skipping several releases still produces one toast.
 */
export function announceVersion(
  installed: string | undefined,
  latest: string | undefined,
  notified: string,
): string | undefined {
  if (installed === undefined || latest === undefined) return undefined
  if (!updateAvailable(installed, latest)) return undefined
  return latest === notified ? undefined : latest
}

/** The one-line toast body: what is available, what is loaded, how to update. */
export function updateMessage(installed: string, latest: string): string {
  return `${latest} is available (installed ${installed}) - git pull && npm run plugin:install`
}

/** The manifest's `version` of a given `package.json`, or `undefined` when unreadable. */
export function readPackageVersion(file = PACKAGE_PATH): string | undefined {
  if (!existsSync(file)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
    const version = manifest?.version
    return typeof version === 'string' && version.length > 0 ? version : undefined
  } catch {
    return undefined
  }
}

/** The version this build carries: the shipped manifest's, never git's. */
export function readPluginVersion(): string | undefined {
  return readPackageVersion()
}
