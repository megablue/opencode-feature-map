# Tray — the resident process, its icon and the auto-switch engine

Status: shipped (v0.2) · Read when: changing `crates/tray/`, the tray menu,
auto profile switching, or anything the tray supervises.

## What it does

- `plo-tray.exe` is the only resident process and the one a user launches; it
  owns the notification-area icon and its native menu.
- A left-click opens the Config window; a right-click opens the menu
  (Pause/Resume, Exit). Exit is the only thing that ends the app — closing the
  Config window never does.
- It starts whatever is missing when it launches, supervises the renderer
  through the pipe, and restarts it after a crash — but only a process it
  started itself is ever stopped.
- It owns auto profile switching: it re-reads `rules.json`, watches the
  foreground window on a one-second cadence and switches profiles by sending
  the same `SetConfig` a profile load sends.
- One tray per user at a time: `SingleInstance::acquire(Role::Tray)`.

## Map

- `crates/tray/src/lib.rs` — `TrayState`, `create()`, `tray_icon()`,
  `show_menu` / `show_native_menu` (a native `HMENU`), the icon-event loop,
  `wide()`.
- `crates/tray/src/main.rs` — the loop and `App`: `new`, `step`, `on_action`,
  `open_config`, `send`, `renderer_is_gone`, `supervise`, `finish_starting`,
  `auto_switch`, `reload_rules_if_changed`, `apply_auto_profile`,
  `note_auto_error`; helpers `file_stamp`, `read_rules_file`, `forget_expired`.
- `crates/core/src/rules.rs` — the pure half, shared with the Config window:
  `AutoRules`, `Rule`, `Condition`, `CompiledMatcher`, `MatchMode`, `Scope`,
  `Combine`, `Snapshot`, `WindowInfo`, `Decision`, `Engine` (`step`, `resume`,
  `mark_applied`), `Tick`.
- `crates/core/src/winwatch.rs` — the only impure part: foreground and window
  enumeration (`GetWindowTextW`, a Toolhelp process snapshot; tool windows
  (`WS_EX_TOOLWINDOW`) and invisible windows are not candidates).
- `crates/core/src/transport.rs` — `Message` and `SingleInstance` (see
  runtime.md); `crates/tray/src/bin/tray_probe.rs` — the icon/menu-only
  diagnostic, behind the `tray-probe` feature, never shipped.

## How & why

- **The tray owns switching because it is the only process alive while the
  Config window is closed.** No new process and no new pipe message: a switch
  is the `SetConfig` a profile load already sends (runtime.md).
- **`rules.json` is the window→tray channel.** The tray re-reads it on
  `(mtime, len)`; `Store::save_rules` writes atomically so the stamp can be
  trusted. A parse failure keeps the rules already loaded — compiling "no
  rules" would strand the user on the fallback because of a typo — while
  deleting the file means off. Enabled with nothing usable is inert, so a
  half-typed rule cannot mass-apply the fallback.
- **A rule matches a window, not a set of independent facts.** Every condition
  is tested against the same candidate window; first match wins, and the
  fallback applies only when at least one rule can match.
- **The engine pauses while the Config window is open**
  (`role_is_running(Role::Config)`), and `Engine::resume()` runs as it closes
  so one push always goes out afterwards. The window runs an engine of its own
  meanwhile, so in that time the window is the only writer of `activeProfile`.
- **The debounce counts ticks; `Engine::step` has no clock.** Two consecutive
  evaluations of the same decision settle a switch — which is what makes a
  whole flap history testable in microseconds.
- **A decision is edge-triggered**: a settled decision equal to what is applied
  is `Tick::Idle`, so the renderer is not sent a full config every second. A
  failed send is retried, and the retry logs once per distinct failure.
- **A switch writes `activeProfile` only after the renderer took the config**
  (`mark_applied` on success): the Config window loads that pointer at startup
  and pushes what it loaded, so a switch that did not record itself would be
  clobbered the moment the window opened.
- **The tray never retires probes.** Background tracking keeps a departure's
  probes alive, and only the Config window knows which removals are permanent
  (probes.md).
- Titles come from `GetWindowTextW`, which Windows documents not to send
  `WM_GETTEXT` to another process's window and so cannot block on a hung game;
  process names come from a Toolhelp snapshot, which needs no handle into the
  target and works for an elevated game where `OpenProcess` would fail.
- The tray supervises the pipe, not a child handle; its crash guard is
  `should_restart(now)` / `forget_expired` (runtime.md).

## Config keys / UI

- `rules.json`: `enabled`, `fallback` (a profile id), `rules[]` — each rule has
  a `scope` (the foreground window or any visible window), a `combine`
  (`all`/`any`), `when[]` conditions (part: process/title/class, a match mode,
  a value) and a target profile id. An absent field takes its documented
  default.
- The menu: Pause/Resume and Exit.
- A preference that rides every push: `ui.backgroundTracking`
  (config/storage.md).

## Tests that pin it

- Resolution: `every_condition_is_tested_against_the_same_window`,
  `an_any_rule_matches_when_one_condition_does`,
  `any_window_sees_past_the_foreground_and_foreground_does_not`,
  `the_first_matching_rule_wins`,
  `nothing_matching_falls_back_and_a_missing_fallback_is_inert`,
  `enabled_with_no_usable_rules_is_inert_not_always_fallback`,
  `a_broken_rule_disables_itself_and_not_the_file`,
  `switched_off_rules_decide_nothing_even_with_a_match`,
  `a_compiled_matcher_requires_every_condition_it_holds`,
  `a_matcher_that_cannot_mean_anything_matches_nothing`.
- Engine: `the_first_tick_holds_and_the_second_applies`,
  `an_applied_profile_is_not_reapplied`,
  `a_failed_apply_is_retried_until_it_lands`, `a_flap_restarts_the_hold`,
  `switching_off_never_applies_and_resume_forces_one_push`.
- Wiring: `a_crash_loop_is_stopped_and_a_rare_failure_is_not` (the tray's
  supervision test), `the_window_engine_holds_a_switch_until_the_drafts_are_resolved`
  (ui.rs), and the background-tracking quartet listed in probes.md.

## Related

- runtime.md — the three processes, the pipe and supervision.
- probes.md — background tracking and what the tray retires (nothing).
- config/storage.md — profiles, `globalconfig.json`, `rules.json`.
- config/window.md — the window's own engine and its preview.
