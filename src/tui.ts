/**
 * The TUI half of the plugin: one daily check for a newer published version,
 * reported as a toast in the terminal.
 *
 * Why a second entrypoint at all: the server half's context has no toast, no
 * client and no notification channel, so nothing about the plugin can be put in
 * front of the user from there. The TUI context can, and this file uses exactly
 * that slice — `options`, `storage`, `ui.toast` and `data.on`. Nothing here
 * touches a request: no payload, no policy, no tokens.
 *
 * The host resolves `<plugin-root>/tui` for the TUI side the way it resolves
 * `<plugin-root>/server` for the server side, and `package.json` exports
 * `./tui` for a by-name install. `define` in the host is the identity function,
 * so a bare `{ id, setup }` object is a complete definition; skipping that
 * import keeps this module free of the TUI peers (`@opentui/*`, `solid-js`),
 * which is what lets a plugin load its TUI half on a host that has none.
 *
 * The rules live in `update.ts`; this file is the thin wrapper that knows about
 * a clock, a fetch and a toast. A failed check is not news: the attempt is
 * stamped and retried tomorrow rather than on every idle turn.
 *
 * @module opencode-feature-map/tui
 */

import { parseUpdateCheck, readUpdateCheck } from './config.js'
import {
  EMPTY_UPDATE_STATE,
  UPDATE_MANIFEST_URL,
  announceVersion,
  dueForCheck,
  parseManifestVersion,
  readPluginVersion,
  updateMessage,
  type UpdateState,
} from './update.js'

export const id = 'feature-map'

/** Key of the durable store, namespaced by the host per plugin. */
const STORE_KEY = 'update'

/** The network may hang; a toast is never worth waiting long for. */
const FETCH_TIMEOUT_MS = 4_000

/** Long enough to read, short enough not to sit over the prompt. */
const TOAST_DURATION_MS = 10_000

const TOAST_TITLE = 'feature map update'

type ToastVariant = 'info' | 'success' | 'warning' | 'error'

interface ToastOptions {
  readonly title?: string
  readonly message: string
  readonly variant?: ToastVariant
  readonly duration?: number
}

/**
 * The slice of the TUI context this file reads, declared locally.
 *
 * The host's own `Context` type would drag `@opentui/core`, `@opentui/solid`
 * and `@opencode/client` into the typecheck as peers. The runtime contract used
 * here is three small members, so it is restated instead.
 */
export interface TuiContext {
  readonly options?: Readonly<Record<string, unknown>>
  readonly storage?: {
    store<Value extends object>(
      key: string,
      options: { readonly initial: Value },
    ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>]
  }
  readonly ui?: {
    readonly toast?: { show(options: ToastOptions): void }
  }
  readonly data?: {
    on(type: 'session.idle', handler: (event: unknown) => void): () => void
  }
}

/** Durable state, plus a writer that cannot throw. */
interface UpdateRecord {
  readonly state: UpdateState
  readonly write: (mutation: (draft: UpdateState) => void) => Promise<void>
}

/**
 * The durable record, or an in-memory stand-in when the host has no storage.
 *
 * Storage is the host's: a TUI that cannot provide it still gets the check, it
 * just repeats the toast on the next start instead of remembering that it said
 * so. That is the right way to fail — the check is the feature, the record only
 * keeps it quiet.
 */
function updateRecord(context: TuiContext): UpdateRecord {
  try {
    const [state, write] = context.storage!.store<UpdateState>(STORE_KEY, {
      initial: { ...EMPTY_UPDATE_STATE },
    })
    return { state, write }
  } catch {
    const state = { ...EMPTY_UPDATE_STATE }
    return {
      state,
      write: async (mutation) => {
        mutation(state)
      },
    }
  }
}

/**
 * One check: due?, fetch the manifest, record it, toast the newest once.
 *
 * @param context - the TUI context, for the toast.
 * @param record - the durable state and its writer.
 */
async function check(context: TuiContext, record: UpdateRecord): Promise<void> {
  const now = Date.now()
  if (!dueForCheck(record.state.checkedAt, now)) return
  const installed = readPluginVersion()
  let latest: string | undefined
  try {
    // No `cache: "no-store"`: the host's fetch typing has no RequestInit.cache.
    // GitHub serves raw files with a five-minute max-age, which a daily check
    // cannot notice.
    const response = await fetch(UPDATE_MANIFEST_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (response.ok) latest = parseManifestVersion(await response.text())
  } catch {
    // A dead network is not news: the attempt is stamped below and retried
    // tomorrow rather than on every idle turn.
  }
  const announce = announceVersion(installed, latest, record.state.notified)
  try {
    await record.write((draft) => {
      draft.checkedAt = now
      if (latest !== undefined) draft.latest = latest
      if (announce !== undefined) draft.notified = announce
    })
  } catch {
    // Losing the record only means one extra check next time.
  }
  // `announceVersion` only answers when both sides are known, so this also
  // narrows `installed` for the message.
  if (announce === undefined || installed === undefined) return
  try {
    context.ui?.toast?.show({
      title: TOAST_TITLE,
      message: updateMessage(installed, announce),
      variant: 'info',
      duration: TOAST_DURATION_MS,
    })
  } catch {
    // A toast that cannot be drawn must not take the TUI with it.
  }
}

/**
 * The TUI entry: check once now, then on every idle turn (the check itself
 * decides whether a day has passed).
 *
 * @param context - the TUI context.
 * @returns a teardown that removes the listener.
 */
export async function setup(context: TuiContext): Promise<() => void> {
  // Read at setup, once: `updateCheck: false` in `feature-map.json` (or in the
  // plugin's own options) must stop the network request, not only the toast.
  if (!readUpdateCheck() || !parseUpdateCheck(context.options ?? {})) return () => {}

  const record = updateRecord(context)
  // One check in flight at a time: a burst of idle events must not fan out into
  // parallel requests for the same answer.
  let running = false
  const run = (): void => {
    if (running) return
    running = true
    void check(context, record).finally(() => {
      running = false
    })
  }

  run()
  let stop: (() => void) | undefined
  try {
    stop = context.data?.on('session.idle', run)
  } catch {
    // A host without events still gets the check at setup.
  }

  return () => {
    try {
      stop?.()
    } catch {
      // Teardown must not throw into the host.
    }
  }
}

export default { id, setup }
