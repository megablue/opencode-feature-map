# Packaging — the version rule, the icons and the NSIS installer

Status: shipped · Read when: changing the version rule, the icons, the NSIS
script, or an executable name.

## What it does

- `cargo build --release` produces exactly the three shipped executables
  (`plo-tray.exe`, `plo-config.exe`, `plo-renderer.exe`) into one directory:
  the installer packs them as siblings, which is how the processes find each
  other.
- The version is derived from git, never edited in a file:
  `MAJOR.MINOR.(commits since countBase)`.
- `npm run icons` regenerates the artwork; `npm run bundle` turns the built
  executables into `PingLatencyOverlay_<version>_x64-setup.exe`.
- The installer offers a Start Menu shortcut and a desktop shortcut, stops any
  running copy before replacing files, and never touches settings.

## Map

- `src-tauri/Cargo.toml` — `[package.metadata.build] countBase`;
  `[package.metadata.copyright]` is what the About page shows through
  `APP_COPYRIGHT`.
- `crates/build-support/` — the shared half of the three build scripts: the
  version derivation and the Windows resource (icon, version, copyright) that
  every executable carries. A build dependency: it runs on the host and
  contributes a resource, never runtime code.
- `scripts/gen-icons.mjs` — dependency-free artwork generator (`npm run icons`).
- `packaging/nsis/installer.nsi` — the hand-written installer.
- `scripts/build-nsis.ps1` — the driver; `-Arch arm64` builds the ARM64
  installer.
- `crates/core/src/transport.rs` — `LEGACY_EXE_NAMES`, hand-copied into the
  NSIS script because an `.nsi` cannot import a Rust constant.

## How & why

- **One version number, two readers.** Both `crates/build-support` (what the
  app reports and each executable's version resource) and
  `scripts/build-nsis.ps1` (the installer's file name) read `countBase` from
  `[package.metadata.build]`, so the two cannot drift apart. Raise the minor
  and the base together, in the same commit.
- **Bundle after committing, never before.** The version is the commit count,
  so bundling first yields the previous commit's number and an installer that
  disagrees with the executable inside it.
  `the_installer_and_the_app_agree_on_the_version` runs the script and compares
  it with the version compiled into the binary.
- `cargo build --release` stays feature-free on purpose: it is the command
  that must produce exactly the three executables the installer ships.
  `--all-features` is for the gate; it additionally builds the feature-gated
  `plo-tray-probe` diagnostic binary, which is never shipped.
- The executables are named tersely on purpose: they sit side by side in the
  install folder and Task Manager, where long names are hard to tell apart.
  The product name, installer, Start Menu folder and window title are still
  PingLatencyOverlay.
- **Killing before replacing.** Windows will not delete a file its process
  holds open. The installer stops the three current executables
  unconditionally (a developer's copy may be running from `target\debug`),
  and the four pre-rename names through `KILL_IF_INSTALLED`, which checks
  `$INSTDIR` first so a current install spawns three `taskkill`s, not seven.
- **`nsExec` for `taskkill`, `ExecWait` for the old uninstaller.** `ExecWait`
  of a console program gives it a console and the user sees one flash per
  call; `SW_HIDE` is an `ExecShell` flag and makensis rejects it on
  `ExecWait`, so `nsExec::ExecToStack` (CREATE_NO_WINDOW) is used for the
  kills. The previous uninstaller is a windowed program with no console to
  flash, so it stays on `ExecWait`.
- **MUI's finish page has exactly two checkbox slots.** The desktop shortcut
  reuses `MUI_FINISHPAGE_SHOWREADME` with a custom `_FUNCTION`; the macro name
  is misleading, which the script says at the definition.
- **NSIS traps that cost time here.** `MUI_PAGE_CUSTOMFUNCTION_*` are not
  page-scoped (`Pages.nsh` `!undef`s them after the first page that reaches
  the insertion point, so they never fire on the finish page); warning 6010
  means an unreferenced callback was zeroed out — treat it as a hard failure;
  `${If} ${Silent}` is a LogicLib condition, never `== 1`.
- **The uninstall section deletes only its own artifacts** — the binaries, the
  LICENSE, both shortcuts and its registry key. Settings live outside
  `$INSTDIR` and are never touched.

## Config keys / UI

| Command | Does |
|---|---|
| `npm run icons` | Regenerate the artwork. |
| `npm run bundle` | Build the x64 installer from the existing release executables. |
| `.\scripts\build-nsis.ps1 -Arch arm64` | Build the ARM64 installer (after the ARM64 release build). |

## Tests that pin it

- `the_installer_and_the_app_agree_on_the_version`

## Related

- [runtime.md](runtime.md) — the processes the executables launch.
- [diagnostics.md](diagnostics.md) — where the log lives beside the config.
