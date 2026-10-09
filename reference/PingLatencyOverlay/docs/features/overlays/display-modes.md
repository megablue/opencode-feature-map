# Display modes — global, sticky and wallpaper placement

Status: shipped (v0.2.x) · Read when: changing where an overlay sits, how it
follows a window, or how a display is pinned.

## What it does

- Each overlay has a `displayMode`: **global** (anchored in a monitor's work
  area), **sticky** (follows a matched window), or **wallpaper** (sits above
  the wallpaper and icons, below every normal window and the taskbar).
- A sticky overlay tracks its target's client rect and never shows over a
  minimized, hidden or unmatched window.
- A pinned display that is unplugged hides the overlay; a sticky target that
  goes away hides it too. Both come back with their series history — the
  graph is kept, not rebuilt.
- `displayMode` replaced two independent booleans (which could express
  "wallpaper and sticky"); the legacy `wallpaperMode` key is folded in one way
  during normalization, and switching back to global restores the monitor the
  user had pinned.

## Map

- `config.rs`: `DisplayMode`, `display_mode`, `sticky_target: Vec<Condition>`,
  `sticky_z_order`, `monitor_device: Option<String>`, `legacy_wallpaper_mode`
  (skip-serializing, folded by `normalize`), `Condition`.
- `overlay.rs`: `layout_in_rect` / `position_for_anchor`, `follow_sticky`
  (sticky poll), `reassert_topmost`, `OverlayManager::apply` (placement),
  window creation (WS_EX_LAYERED, no WS_EX_TOPMOST), `overlay_wnd_proc`
  (refuses `SC_MINIMIZE`), `OverlayWindow::hidden`.
- `sticky.rs`: `resolve` (pure over `&[WindowShape]`), `StickyZOrder`,
  `CompiledMatcher`.
- `monitors.rs`: `enumerate` (the only Win32) vs `resolve` / `placement`
  (pure over a list).
- `winwatch.rs`: `shapes()` — Toolhelp process names + `GetWindowTextW`
  titles; tool windows and invisible windows are not candidates.

## How & why

- **Sticky is followed by the renderer's own poll**, on every loop tick (16 ms)
  — not by a Win32 hook and not by the tray. The per-tick checks are
  window-manager getters that cannot block on the target process
  (`IsWindow`/`IsIconic`/`IsWindowVisible`/`GetClientRect`/`ClientToScreen`);
  only when the handle is missing does it sweep `winwatch::shapes()`, at most
  once a second. It returns whether anything changed, which pulls the next
  layout pass forward — that is the whole follow latency.
- **A target is placeable only while neither minimized nor hidden.** Steam
  closing to the tray hides its window instead of destroying it, so "the
  handle exists" alone would keep an overlay on a window nobody can see.
- **`sticky::resolve` is pure** (focused match first, else topmost; a
  minimized window is never a target) and uses the same `CompiledMatcher` the
  auto-switch rules do — "chrome.exe and a title mentioning GitHub" cannot
  mean one thing to a rule and another to a target. A matcher that cannot mean
  anything (empty, blank value, bad regex) matches nothing.
- **`StickyZOrder::FollowWindow` owns the overlay** (`GWLP_HWNDPARENT` =
  target) and drops `WS_EX_TOPMOST`, so Windows keeps it in the owner's
  z-order band — and destroys it when the owner is destroyed. That is
  expected: `apply` notices the dead window and the ordinary creation path
  rebuilds it. The once-a-second re-assert skips this mode; re-setting topmost
  would break it.
- **Wallpaper mode is a measured decision.** A layered child of the shell's
  desktop presents nothing on current Windows builds, and the only other way
  to live in that layer is a GPU present path the renderer deliberately does
  not have. So the overlay stays an ordinary top-level layered window and is
  placed with `SetWindowPos(hwnd, GetShellWindow(), …)` — directly above the
  desktop and icon layer, below every normal window and the taskbar. The
  absent topmost bit is the mode's flag. The re-assert is checked
  (`GetWindow(hwnd, GW_HWNDNEXT) == host`), not unconditional, because
  re-placing a window already in the right spot flickers; if the shell window
  cannot be found it simply re-checks the next second. `SC_MINIMIZE` is
  refused so Show Desktop cannot take it away.
- **`hidden` is one flag for two causes** — "the pinned display is gone" and
  "the sticky target is gone" — because the consequences are the same three:
  do not repaint on the prefill and border clocks, do not re-assert topmost,
  and keep the series so the graph returns with its history.
- **The picker's list must agree with the profile.** A pinned display that is
  unplugged is still an entry and still the selected one, so a hidden overlay
  has a visible reason; an egui combo whose entries do not contain the
  selected value falls back to its first row, and a save would re-pin a
  different monitor.

## Config keys / UI

| Key | Meaning | UI |
|---|---|---|
| `displayMode` | `global` / `sticky` / `wallpaper` | Display Mode section |
| `monitorDevice` | display device name; empty/absent = primary | Position → display combo |
| `stickyTarget` | condition list, ANDed: process exact, title contains (regex), class exact | Sticky target rows + crosshair picker |
| `stickyZOrder` | follow-window (owned by the target) / stay-on-top | Sticky section |
| `horizontalMarginPx` / `verticalMarginPx` | work-area offsets for the chosen anchor | Position section |
| `legacyWallpaperMode` | read-only legacy fold into `displayMode` | — |

## Tests that pin it

- `sticky.rs`: `the_focused_match_wins_over_the_topmost_one`,
  `the_topmost_match_wins_when_none_is_focused`,
  `a_minimized_window_is_not_a_target`,
  `a_desktop_without_a_match_resolves_to_nothing`.
- `monitors.rs`: `no_request_follows_the_primary`,
  `a_disconnected_pin_resolves_to_nothing_rather_than_falling_back`,
  `a_pin_returns_to_the_same_place_when_the_monitor_comes_back`,
  `no_monitors_at_all_hides_the_overlay`,
  `scale_comes_from_the_display_not_the_system`,
  `placement_names_every_direction`,
  `a_monitor_only_half_aligned_is_aligned_on_that_axis`.
- Picker: `a_picked_window_fills_process_and_class_but_not_the_title`.

## Related

[rendering.md](rendering.md) · [../config/storage.md](../config/storage.md) ·
[../config/window.md](../config/window.md) · [../runtime.md](../runtime.md)
