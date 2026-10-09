# Runtime & pipe — the three processes and the protocol between them

Status: shipped (0.2.x) · Read when: touching process launch, supervision,
`transport.rs`, or the pipe protocol.

## What it does
- `plo-tray.exe` is what a user launches and the only process that stays
  resident; `plo-config.exe` starts on demand and **exits when closed**;
  `plo-renderer.exe` draws the overlays. Two of the three carry no eframe at
  all — the GL context exists only while the window is open, so close means
  exit, never hide.
- The processes find each other as siblings of their own executable and meet
  over one named pipe; there is no registry, lock file or heartbeat.
- The pipe carries `set_config`, `set_paused`, `set_border_preview`, `ping`
  and `shutdown`; both ends compile the protocol from the same module.
- The tray supervises the renderer through the pipe; the window is a client
  that starts one at launch if nothing else has.
- Appearance edits reach the renderer without a Save; Pause, Exit and the
  border preview travel as messages like everything else.

## Map
- `crates/core/src/transport.rs` — `Message` (`#[serde(tag = "kind")]`),
  `SingleInstance::acquire(Role)`, `sibling_exe`, `LEGACY_EXE_NAMES`, the
  client and the `serve` loop.
- `crates/tray/src/main.rs` — the resident supervision loop: pipe client,
  storm guard (`should_restart(now)`, `forget_expired`), start/stop.
- `src/main.rs`, `src/ui.rs` — the window's client side: launch-once,
  `App::starting` / `finish_starting`, `reconnect_renderer`,
  `toggle_running`, `sync_runtime_config` / `push_config` /
  `persist_current`.
- `crates/core/src/bin/renderer.rs` — the serving side: window message pump,
  redraw loop, answers to a config, a pause or a shutdown.
- `crates/core/src/diagnostics.rs` — the log file and the startup
  `MessageBox` (see **Diagnostics** in the index).
- Tests: `each_role_gets_its_own_versioned_mutex`,
  `an_out_of_range_draft_settles_instead_of_resending`,
  `connecting_with_nothing_listening_fails_quickly`, and the `should_start`
  launch matrix over all nine cells.

## How & why
### The three processes
- **No package may reach a GPU context or an event loop.** That is the
  property the memory win depends on, and
  `crates/core/tests/no_gui_dependencies.rs` checks it with `cargo tree`. The
  deny lists are two-tier because the tray *is* `tray-icon`; the rule is named
  for what it forbids, not for the crates it happens to list. `tray-icon` is a
  GUI crate and belongs to `crates/tray` alone — the application shell once
  depended on it and nothing in `src/` used it, which is how a dead dependency
  hides in a manifest for a release.
- The renderer needs no package of its own — it uses nothing the library does
  not already depend on, and `cargo tree` reports a package's deps across
  every target, so the test guards the binary for free. The tray does need
  one: a `[[bin]]` beside the window would link eframe into the resident
  process.
- The binaries are named tersely on purpose: they sit side by side in the
  install folder and Task Manager, and a name long enough to abbreviate is
  hard to tell from its neighbour. Crates keep descriptive names; the product
  name, installer, Start Menu folder and window title are all still
  PingLatencyOverlay. `LEGACY_EXE_NAMES` in `transport.rs` holds the
  pre-rename names and the installer kills them, because a file cannot be
  deleted while its process holds it open.
- `default-run` is set on the root package; `cargo run` with two binaries is
  ambiguous exactly where a developer starts the app. The window is the
  default because it starts whatever it needs.

### Launching
- **Every process is `windows_subsystem = "windows"`, so `eprintln!` goes
  nowhere.** `diagnostics.rs` is the answer: `log_line` appends to
  `pinglatencyoverlay.log` beside the config, and `fatal` puts up a
  `MessageBox` for the tray's startup failures, the tray being the one process
  that never draws a window. **Any `return` on a tray error path needs one of
  the two** — a bare `return` is invisible forever. The tray also logs a
  heartbeat, because a wedged loop and a feature that was never written look
  identical from outside. **A release build writes nothing unless `PLO_LOG` is
  set** (`log_enabled`; a debug build logs as before), so the "one of the two"
  rule has a release reading: a log line is silent for an ordinary install,
  and anything the user must see has to be a `fatal`.
- The launch matrix is `should_start(me, missing)`, tested over all nine
  cells: a process never starts itself, the renderer starts nothing, the tray
  does not open the window on its own, and everything else missing gets
  started. It is a function because three bugs came from the rule living in
  three places and none agreeing.
- **The pipe is the rendezvous**, with no registry, lock file or heartbeat,
  which is what makes "run without the tray, bring one later" free.
  `SingleInstance::acquire(Role)` uses a per-**role** mutex so the tray can
  exit while the window stays open and a crashed renderer is replaceable;
  three roles means three pairs, and `each_role_gets_its_own_versioned_mutex`
  checks all of them, because comparing only two lets the third share one.
  `Ok(None)` means somebody else holds it — the ordinary "ran it twice"
  answer, not an error.

### The pipe
- `transport.rs` owns the wire format and **both ends are compiled from the
  same crate**, so the two processes cannot disagree without a compile error.
  Messages are `set_config`, `set_paused`, `set_border_preview`, `ping` and
  `shutdown`, tagged `#[serde(tag = "kind")]` so an unknown kind is
  **rejected rather than silently ignored**. `ping` is a no-op and nothing may
  act on it; borrowing `set_paused` for a probe would resume the probes
  whenever the sender's mirror was stale.
- **Framing is one JSON object per line, and the newline is not optional.** A
  pipe is a byte stream, a length prefix is the usual source of off-by-one
  bugs, and JSON escapes its own newlines.
- **The server serves several clients at once** — `serve` spawns two
  `instance_loop`s, each holding one instance and making the next when it
  finishes with a client, so a spare is always waiting. A rendezvous designed
  for one caller and handed two is a defect, not a configuration.
- **A fresh instance per connection.** Windows returns a stale
  `ERROR_PIPE_CONNECTED` (a success to tokio) rather than blocking on an
  instance a client has disconnected from, so reusing one spins at 8% CPU
  with no sleep on any leg. Only the first instance may claim
  `first_pipe_instance`; the renderer mutex, not that flag, is what guarantees
  one renderer. **No test can catch this** — only the OS shows you a spin.
- Each process finds the others as **siblings of its own executable**
  (`sibling_exe`), so all three must be installed into one directory and
  `build-nsis.ps1` checks all three exist before packaging.
- A client handle is opened `GENERIC_READ | GENERIC_WRITE`, and a liveness
  check must not be able to block. `PeekNamedPipe` queries rather than
  transfers, but it **needs read access**: a write-only handle answers every
  query with `ERROR_ACCESS_DENIED`, which reads as "the renderer is gone".
  Before adding a query here, check the handle can answer it.
- `ERROR_FILE_NOT_FOUND` maps to `io::ErrorKind::NotFound`, distinct from
  every other failure, because it is the answer that says *start one*.
  Lumping the ordinary answer in with a fault is what makes a working system
  look broken.

### Live edits
- **An overlay edit reaches the renderer without a Save.** Before the renderer
  was its own process, `logic()` called `sync_overlays()` on **every frame**
  and the in-process overlay manager re-read `self.config`, so any staged
  change was on screen immediately. `a2e0404` turned that per-frame call into
  a pipe message and put the message only on the save paths — so every
  appearance edit silently became save-only, and the only edit that stayed
  live was the list pane's enable toggle, because `ac58523` had added an
  explicit call for that one action. **The regression was silent**: the
  overlay still appeared on Save, so nothing failed and the app just stopped
  feeling live. If live updating ever looks broken, check
  `sync_runtime_config` is still called from `logic()` before suspecting the
  pipe.
- **`sync_runtime_config` normalizes the draft IN PLACE before comparing, and
  that order is load-bearing twice over.** Compared the other way — a
  normalized `last_pushed` against an un-normalized draft — the two never
  match, so the window sends the whole configuration on **every frame** for
  as long as it stays open. That is not slow enough to look wrong: it is a
  pipe write and a full config parse ten times a second, forever, with no
  symptom. It also makes the drag story right, since a clamped value is what
  Save would write anyway. `an_out_of_range_draft_settles_instead_of_resending`
  counts sends over 20 frames, which is the only way that bug is visible —
  there is nothing to assert against except the count.
- **The comparison is the affordability argument, so do not "simplify" it
  into an unconditional push.** `Config` derives `PartialEq`, so an unchanged
  frame costs a field comparison and *no clone*; the clone only happens when
  there is something to send.
- **`last_pushed` must be updated by every path that sends a config**, and
  `persist_current` is the exception that proves it: it sends directly rather
  than through `push_config` because it has to tell "written to disk" from
  "renderer told" apart, and it updates the record **only on success** so a
  failed send leaves `sync_runtime_config` still wanting to try.

### Supervision
- **The tray supervises the pipe, not the child handle.** A lost pipe is a
  better signal than a child, because a hung renderer still holds its mutex
  while answering nothing.
- **Only stop a process you spawned.** `renderer_process` is set only when
  this process started the renderer, which also governs the `Shutdown` on
  `Drop` and the tray's `Exit`. A blanket kill takes an overlay set the user
  still wants off their screen.
- **A client is not a supervisor, and the restart half must not travel with
  the start half.** The window starts the renderer once at launch if nothing
  else has; the tray owns it from then on. When the window also gained a
  restart path they fought and neither could win. The window's
  `reconnect_renderer` reconnects and never spawns, and carries no storm guard
  — a storm guard stops a crash loop, and this is not the process that would
  be looping.
- **Bringing a renderer up and noticing a crash are two different states, and
  only the second costs an attempt.** `App::starting` is an `Option<Instant>`;
  while set, `finish_starting` retries the pipe and the config push and
  nothing counts against the guard. `START_TIMEOUT` (10s) ends the grace
  period.
- **Never discard a send error.** Both fire-and-forget pushes used
  `let _ = self.send(..)`, so a command that never left the process looked
  exactly like one that was obeyed. `finish_starting` retries the config push
  until it lands; `toggle_running` logs both halves.
- **The storm guard's clock is a parameter.** `should_restart(now)` takes an
  `Instant` so a test can drive a whole crash history in microseconds, and
  `forget_expired` is split out so forgetting is a statement about the list.
  The tray owns the guard; a renderer with no tray is not restarted.
- **Say what actually happened.** Writing the profile and telling the renderer
  can fail separately, so `persist_current` reports "Saved, but the overlays
  were not updated" rather than a confident "Saved."
- Neither the tray nor the window has a `ProbeManager` or `OverlayManager`, or
  a tokio runtime. Anything the renderer needs travels over the pipe —
  **including the animated border preview**, which used to be a direct call
  and is now `set_border_preview`, sent only when it changes, and cleared by
  `release_border_preview` on close.

### Windows
- **Any thread in ANY of our processes that creates a window must pump that
  thread's messages.** A tray icon is a window too. Windows delivers a window
  message only to a thread that pumps its queue, so a thread that sleeps
  receives *nothing* and the symptom is a window that looks perfect and is
  completely dead. `tray-icon` documents this ("an event loop must be running
  on the thread") and spawns no pump on Windows, so the caller must;
  `pump_messages()` is ours. **This shipped twice, once per process** — so
  grep for `windows_subsystem = "windows"` before assuming a new process is
  exempt. A rule that names one caller is a rule the next caller will not
  find.
- **The repaint cap and the liveness cap are different decisions.**
  `MESSAGE_POLL_INTERVAL` (16ms) is independent of `REPAINT_INTERVAL` (100ms);
  tying them together would mean a slow redraw is also an unresponsive
  process. The wait is `min(deadline, cap)` via `wait_before`, and a pipe
  command resets the deadline. Only a user can confirm Windows stops calling
  the process hung.
- **Letting the default handler run can be worse than ignoring the message.**
  `DefWindowProcW` on `WM_CLOSE` *destroys* the window and the loop rebuilds
  it, so Task Manager's "End task" concludes its graceful close worked and
  never escalates. `overlay_wnd_proc` handles `WM_CLOSE | WM_QUERYENDSESSION`
  by setting a flag and returning `0` without calling the default, and the
  loop checks `quit_requested()` right after `pump_messages`. The flag is a
  static because a window procedure cannot stop the loop that called it. Any
  `WM_*` we do not handle must be checked against this: the default is not a
  safe place to land.

## Config keys / UI
No UI. Environment variables read by the processes:

| Variable | Effect |
| --- | --- |
| `PLO_CONFIG_DIR` | overrides the config root the process reads and writes |
| `PLO_LOG` | enables the release build's log output |

## Tests that pin it
- `each_role_gets_its_own_versioned_mutex` — all three role mutexes distinct.
- `an_out_of_range_draft_settles_instead_of_resending` — the send count.
- `connecting_with_nothing_listening_fails_quickly` — the NotFound answer.
- The `should_start` matrix (all nine cells) — who starts whom.

## Related
- Tray — the resident process, its menu and the rules engine.
- Diagnostics — the log file, `PLO_LOG` and the fatal box.
- Overlays — rendering — what the renderer draws and how the box is sized.
- See `README.md` for the full index.
