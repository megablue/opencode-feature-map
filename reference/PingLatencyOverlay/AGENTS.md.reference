# AGENTS.md

**Before you grep, glob or open a source file: read `HANDOFF.md`, then
`docs/features/README.md`, then only the feature page(s) for the area you are
about to change. The feature pages name the files, functions and tests you
would otherwise hunt for — the code comes after them, not before.**

PingLatencyOverlay is a Windows-only desktop overlay that shows live network
latency. The native implementation uses **Rust + egui/eframe** for the single
configuration window and native Win32 layered windows for overlays. Probes run
on Tokio tasks and the system tray uses `tray-icon`.

Three kinds of document, and keeping them apart is the point:

- **`docs/SPEC.md` is product behavior** — what the app does and what a user
  sees, readable without knowing the code. Behavior belongs there even when
  the code is where the reason for it lives.
- **`docs/features/` is the feature map** — one page per feature with its
  files, mechanisms, traps and pinning tests. Read the page for the area you
  are about to change; keep it true in the same commit.
- **This file is process and hard rules** — the commands, the workflow and
  the constraints that apply across every feature.

Where a rule has a behavior half and a mechanism half, the behavior half is a
pointer to `docs/SPEC.md` and the mechanism half to its feature page rather
than a second copy: two copies of a default value is one more thing that can
be wrong.

## Read first
`HANDOFF.md` holds the current state; if it is missing, carry on with the
feature map and the code. Then `docs/features/README.md` — the feature map —
and only the feature doc(s) for what you are about to change.
`docs/SPEC.md` is user-visible behavior; this file is process and hard rules;
the feature docs are the map, the mechanism and the traps.

## Layout
- `src-tauri/` — the Cargo workspace; run Cargo commands here. The root
  manifest is both the workspace and the application package; `crates/core`,
  `crates/tray` and `crates/build-support` are the other members.
  - `src/main.rs` — the entry point of `plo-config`, the Config window process,
    and the only thing in the project allowed to depend on eframe.
  - `src/ui.rs` — the egui configuration editor. It was "tray-mode" when the
    tray shared this process; it is now its own process that exits on close.
  - `src/theme.rs` — the Config window's colours, loaded from a file rather
    than compiled in. In the shell, not in `core`: the renderer never reads a
    theme, and `core` is "only what the renderer needs".
  - `crates/tray/` — the `ping-latency-overlay-tray` crate, the tray icon, the
    menu and the bundled artwork. The resident process, and it has no eframe.
    It is the only crate allowed to depend on `tray-icon`.
    - `src/main.rs` — the `plo-tray` entry point: the pipe client and the
      supervision loop that watches the renderer through it.
    - `src/lib.rs` — the icon, the native menu, and the icon-event loop that
      turns a left-click into Config and a right-click into the menu.
    - `src/bin/tray_probe.rs` — a diagnostic binary that is the icon and menu
      path and nothing else. It logs every step and deliberately omits the pipe
      attachment, the storm guard and the Config-window spawn, so a menu that
      never appears can be traced to `tray-icon` or the plumbing rather than to
      any of those. It is not part of the product, and it is behind the
      `tray-probe` feature, so an ordinary build never produces a fourth
      executable; `cargo build -p ping-latency-overlay-tray --features
      tray-probe` builds it when needed.
  - `crates/core/` — the `ping-latency-overlay-core` crate. Everything the
    renderer needs and **no GUI dependency at all**:
    - `src/lib.rs` — module wiring; the entries below are what it exposes.
    - `src/config.rs` — config schema, profiles, persistence, and directory
      migration.
    - `src/probe.rs` — one-shot ICMP or TCP latency measurement.
    - `src/probes.rs` — long-lived Tokio probe tasks and bounded sample buffers.
    - `src/overlay.rs` — native layered HWND creation, DPI/work-area layout, and
      per-window alpha compositing with `UpdateLayeredWindow`.
    - `src/render.rs` — software graph rendering into premultiplied RGBA.
    - `src/border.rs` — runtime border-effect state and software RGB border
      drawing.
    - `src/monitors.rs` — display enumeration and the rule that picks a
      display. The two are separate on purpose: `enumerate` is the only Win32
      in it, and `resolve`/`placement` are pure functions over a list, so the
      multi-monitor behaviour is testable on the one-monitor machine most of
      this is written on.
    - `src/transport.rs` — the pipe: wire format, client, server and the
      single-instance mutexes. Both ends compile from this module, so the two
      processes cannot disagree about the protocol.
    - `src/diagnostics.rs` — the log file and the startup `MessageBox`, which
      together are the only output a `windows_subsystem` process has.
    - `src/bin/renderer.rs` — the `plo-renderer` entry point: the overlay
      windows' message pump, the redraw loop, and the pipe server that answers
      a config, a pause or a shutdown.
- `scripts/gen-icons.mjs` — generates native artwork with no dependencies.
- `crates/build-support/` — the shared half of the three build scripts. It
  owns the `MAJOR.MINOR.(commits since countBase)` derivation and the Windows
  resource that puts the app icon, the version and the copyright notice on each
  executable, so the icon path, the version rule and the notice exist once
  rather than three times. The notice itself is `package.metadata.copyright`
  in the root manifest, which the About page reads through `APP_COPYRIGHT`. A
  build dependency runs on the host at build time and contributes a resource,
  not runtime code; `no_gui_dependencies.rs` still finds no GUI crate under it.
- `packaging/nsis/` and `scripts/build-nsis.ps1` — native installer packaging.
- `docs/GAME.md` — design document for the game module, which is **not
  built**. Nothing described there exists in the code. Read it before
  planning anything that draws something other than a latency graph.
- `docs/features/README.md` — the feature map: one page per feature with its
  files, mechanisms and tests, and the rule for keeping it current. Read it
  before exploring, and update the matching page in the same commit as a
  change.
- The pre-egui Tauri/React implementation remains available on `main`. This
  file describes the native branch.

## Commands
Native app (run from `src-tauri/`):
- `cargo run` — development build. Starts the Config window, which brings up
  the tray and renderer if they are not already running.
- `cargo build --release` — optimized standalone executables
- `cargo fmt`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `cargo test --all-features`

`--all-features` is deliberate: it is what keeps the feature-gated
`plo-tray-probe` target compiling. `cargo build --release` stays feature-free
on purpose, because it is the command that must produce exactly the three
executables the installer ships.

Installer (run from the repository root):
- `npm run icons`
- `npm run bundle` — build the x64 NSIS installer from the existing release exe
- `.\scripts\build-nsis.ps1 -Arch arm64` — build the ARM64 installer after
  building the ARM64 release exe

Capture (run from the repository root):
- `.\scripts\capture-app.ps1` — run the app against a sandboxed config and
  photograph the Config window and every overlay; see *Workflow*

## Workflow
- **The features map is part of the change, not the cleanup.** Before staging a
  commit, update the feature doc(s) for whatever you changed
  (`docs/features/`), and add an index row if the doc is new. User-visible
  behavior also updates `docs/SPEC.md` in the same commit. A docs-only
  follow-up commit is the one that gets skipped. Pure refactors with no
  behavior, mechanism, config or test change need no doc edit — do not churn
  the map.
- **Search the map in the same breath as the code.** A grep for a feature, a
  symbol or a behaviour runs over `docs/features/` too: the feature pages name
  the identifiers and the tests, so the page you need is usually one hop from
  the hit.
- **`HANDOFF.md` is refreshed at the end of a session, not per commit.** It
  carries what only the passing session knows — open threads, next steps, the
  last thing delivered — under an `As of` stamp. It is allowed to lag the tip:
  its header says the code wins. Refresh it before you hand the work over.
- **Measure layout, don't deduce it.** Reading the code and checking arithmetic
  against constants shipped three layout bugs in a row. Lay the real thing out
  headlessly with `Context::run_ui` and print the rects; the numbers name the
  bug immediately. Assert both the good and the broken case so each test
  carries its own failure mode.
- **Gate on clippy, not just `cargo test`.** `assertions_on_constants` and
  friends are clippy-only, and `cargo test` compiles and passes with them
  present. The gate is `cargo fmt`, `cargo clippy --all-targets --all-features
  -- -D warnings`, `cargo test --all-features`, `cargo build --release`.
- **The capture script is how the app gets looked at without a person at the
  screen.** `scripts/capture-app.ps1` stops the three exes, runs a session of
  its own (`plo-config` brings up the tray and renderer), photographs the
  Config window with `PrintWindow` and each overlay by `BitBlt`-ing the desktop
  DC with `CAPTUREBLT` (an `UpdateLayeredWindow` window presents nothing to
  `PrintWindow`), and writes PNGs plus `manifest.txt` into `-OutDir`. It points
  `PLO_CONFIG_DIR` at a sandbox copy of the live config by default, so a
  session can never rewrite the user's settings or log.
  `SetProcessDpiAwarenessContext(-4)` comes first so the window rects are
  physical pixels. Two traps are paid for in it: `Graphics.CopyFromScreen`
  returns an all-black image in this environment while the GDI call does not,
  and winit keeps an 18x18 visible helper window beside the real Config window,
  so the script picks that window by title and size rather than by "first
  visible". A `PrintWindow` that comes back flat falls back to the screen copy,
  because a black photograph is worse than an occluded one. Screenshots taken
  this way are worth reading, but nothing can script a real click into the
  running app, so a visual change still gets handed over as a build.
- **The driving tests click through the window's real frame path.**
  `PingApp::for_test` builds an app against a temp root with the tray and
  renderer spawns skipped (`attach: false` in the shared `build` body), and
  `frame_ui` is exactly what the eframe trait method calls, so the `drive` and
  `click_text` helpers run the pass the host would. `text_rects` finds painted
  labels by their galley text — the rail rows and the theme tiles are
  `painter.text` and their hit targets cover the label — so a click is
  addressed by label rather than by coordinates, and `click_text` asserts the
  label is unique so a test cannot silently click the wrong control. Tests
  drive `frame_ui` and deliberately not `frame_logic`: reconnection and the
  `sync_*` methods talk to the machine. The tests module's `use super::{...}`
  is an explicit list, so a new helper or constant a test touches must be added
  to it. **None of this reaches a release binary**: `for_test` is
  `#[cfg(test)]`, so is the tests module, and production only ever calls
  `build` with `attach: true` — the one release-visible piece of the seam is
  that parameter. (The capture script is not shipped either; the installer
  packs the three exes and the LICENSE.)
- **A manifest that is both a workspace root and a package narrows plain
  `cargo test` to that package alone.** The split into `crates/core` made
  `cargo test` report 35 passed against a 94-test suite and exit 0, silently
  skipping every test in `core`. `default-members` in the root manifest is what
  makes the ordinary command cover the workspace, and it is load-bearing: it
  lists `.`, `crates/core`, `crates/tray` and `crates/build-support`, and
  dropping any of them quietly narrows the suite. If the test count ever drops
  without a deletion, suspect this before suspecting a filter. The same numbers
  appear in that manifest's comment; they are historical, so if you correct
  one, correct both.
- **Commit messages go through a file.** Write the message to a scratch file
  (this session uses `%LOCALAPPDATA%\Temp\opencode\plo-commit-msg.txt`) and run
  `git commit -F <path>`; a PowerShell here-string gets its terminator mangled
  by the shell tool.
- **No AI attribution in a commit message, ever, without being asked.** No
  `Co-Authored-By` trailer, no `Generated with` footer, nothing that reads as
  crediting a model or tool. These commits are the user's. This is enforced, not
  merely preferred: a machine-wide `commit-msg` hook
  (`core.hooksPath` = `C:/Users/mega/.githooks`) rejects the commit outright,
  and it blocks human co-authors too, so the only ways past it are `--no-verify`
  or `ALLOW_COAUTHOR=1`. **Use neither without the user asking in that
  conversation.** If the hook blocks something, report it and stop; do not
  reword the message to slip a trailer past the pattern.
- **Bundle after committing.** The version is
  `MAJOR.MINOR.(commits since countBase)`, not the raw commit count, so a new
  minor restarts at `.1`. `countBase` is in `[package.metadata.build]` in
  `src-tauri/Cargo.toml` and **both** readers take it from there —
  `crates/build-support`, which the three build scripts call (it sets what the
  app reports and what each exe's version resource says), and
  `scripts/build-nsis.ps1` (which names the installer) — so a constant in each
  file cannot drift from the other.
  Raise the minor and the base together, in the same commit.
  `the_installer_and_the_app_agree_on_the_version` runs the script and
  compares it with the version compiled into the binary, because an app that
  says `0.2.3` inside `0.1.77-setup.exe` is the kind of drift nobody notices
  until a user reports it. So **bundle after committing**; bundling first
  yields the previous commit's number.
- **Do not commit before the user has looked at it.** Hand visual changes over
  as a build and wait for confirmation.

## Where the working knowledge lives

The per-feature working knowledge — storage, profile switching, the Config
window and its theme, egui layout traps, the processes and the pipe, overlay
rendering (glow, smooth rendering, the cursor, display modes), probes,
packaging and diagnostics — lives in `docs/features/`; its `README.md` is the
index. This file keeps the process rules and the hard rules that apply across
features; the feature pages keep the maps, mechanisms and traps.

## Hard rules
- **`crates/core` must never gain a GUI dependency.** The renderer process is
  built from it precisely so that it can never create a GPU context or run an
  event loop; that is a property of the dependency graph, and graph properties
  decay silently. No `eframe`, `egui`, `glow`, `winit`, `accesskit`, `wgpu` or
  `tray-icon`, directly or transitively, and no `windows-sys` either (the
  layered-window code declares its own `extern "system"` blocks).
  `crates/core/tests/no_gui_dependencies.rs` runs `cargo tree` and fails the
  suite if one appears, so do not "fix" a deny-list entry instead of the
  dependency. That tree includes build-dependencies, and they are allowed:
  `crates/build-support` runs on the host and contributes a resource to the
  exe, never runtime code, and its `winresource` subgraph is `toml`,
  `serde_core`, `winnow` and `version_check` — no GUI crate and no
  `windows-sys`. The application shell is the only thing allowed a GUI stack,
  and `tray-icon` belongs to `crates/tray` alone.
- Do not replace `UpdateLayeredWindow` with egui/GPU child viewports. The old
  multi-viewport renderer was the source of the white-background and excessive
  memory problems.
- `src-tauri/Cargo.toml` uses eframe with the `glow` renderer for the one config
  window and `tiny-skia` only for software overlay pixels. Do not add WebView2
  or Tauri back into the native branch.
- Windows-only: MSVC toolchain (`x86_64-pc-windows-msvc` or
  `aarch64-pc-windows-msvc`) + MSVC Build Tools. No WebView2 runtime is needed.
- ICMP uses the `ping-rs` crate (Win32 `IcmpSendEcho2`) and does not require
  Administrator. `src/probe.rs` resolves ICMP targets to IPv4; TCP supports
  hostname resolution through Tokio.
- The README is for users. Implementation detail belongs in `docs/SPEC.md` for
  behavior and here for working knowledge, and the user must be consulted before
  technical detail is added to the README.
