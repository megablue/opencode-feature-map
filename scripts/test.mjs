/**
 * The test entry point.
 *
 * `node --test` cannot be used here: it spawns one child process per test file
 * with piped stdio, and the file sandbox denies the pipe with `EPERM`. Running
 * every test file in one process is the same suite without the child process.
 *
 * Usage: node scripts/test.mjs
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = fileURLToPath(new URL('../test/', import.meta.url))
const files = (await readdir(testDir)).filter((file) => file.endsWith('.test.mjs')).sort()

for (const file of files) {
  await import(pathToFileURL(join(testDir, file)).href)
}
