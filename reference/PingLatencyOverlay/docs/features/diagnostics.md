# Diagnostics — telling a silent failure from a feature that does not exist

Status: shipped (v0.2.x) · Read when: adding a failure path to any process, or
wondering where a process's output goes.

## What it does

- All three processes are `windows_subsystem = "windows"` binaries, so **stdout
  and stderr go nowhere**; diagnostics are the only output any of them has.
- `log_line` appends one line to `pinglatencyoverlay.log` beside the config.
  `fatal` logs *and* puts up a `MessageBox` — the tray's only way to tell a
  user anything, because the tray never draws a window.
- A debug build logs always; a release build logs only when `PLO_LOG` names
  something, so an ordinary install never accumulates a file.
- Writing is best-effort: a failure (read-only config directory) is swallowed,
  so the diagnostics path can never take the app down.

## Map

- `crates/core/src/diagnostics.rs`: `enabled()`, `log_enabled(debug, override)`,
  `log_line(process, message)`, `log_path()`, `fatal(process, message)`,
  `timestamp()` (seconds since the epoch), the `win::MessageBoxW` block and
  `message_box` (Windows only).
- `log_path()` = `config_dir()/pinglatencyoverlay.log`, so `PLO_CONFIG_DIR`
  moves the log with everything else.
- Callers: every process's startup and supervision error paths, the tray
  heartbeat, and the renderer's slow-lookup line
  (`renderer: lookup for {host} took …`).

## How & why

- **Any `return` on a tray error path needs a `log_line` or a `fatal`.** A bare
  return is invisible forever, and from outside a wedged loop and a feature that
  was never written look identical — which is what the tray heartbeat exists to
  separate.
- **In a release build a log line is silent, so anything the user must see has
  to be a `fatal`.** `PLO_LOG=1` is the support switch; it is the same
  `log_enabled` decision a test drives directly.
- The log lives beside the config on purpose: that directory already exists by
  the time anything is worth logging, and a log in `%TEMP%` would be gone before
  anyone could read it.
- The capture session points `PLO_CONFIG_DIR` at a sandbox, so a scripted run
  can never rewrite the user's settings *or* their log.
- The timestamp is a plain epoch number because formatting a clock is not worth
  a date dependency in `crates/core`.
- `fatal` is a `MessageBox` because the tray has no window of its own; the
  consequence is that it is unusable from a build with no attached console —
  which is exactly the build that needs it.

## Config keys / UI

| Key / file | Meaning |
| --- | --- |
| `PLO_LOG` | non-empty enables the log in a release build (debug always logs) |
| `PLO_CONFIG_DIR` | redirects the whole config root, the log included |
| `pinglatencyoverlay.log` | the log, beside the config |

## Tests that pin it

- `the_log_sits_beside_the_config`
- `logging_never_fails_the_caller`
- `the_log_is_off_in_a_release_build_unless_asked`

`log_enabled` is split out so every combination is testable without mutating
the process environment, the same reason `resolve_config_dir` is.

## Related

- runtime.md — the three processes and the error paths that call these.
- config/storage.md — `config_dir()` and `PLO_CONFIG_DIR`.
- probes.md — the slow-lookup line this is the home of.
