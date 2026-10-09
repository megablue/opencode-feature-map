# The Config window — the egui editor for profiles and preferences

Status: shipped (v0.2.x) · Read when: changing `src/ui.rs`, its pages, drafts,
pickers or the driving tests.

## What it does

- The single eframe window the application is configured from (`plo-config.exe`).
  Three panes plus a status bar: a navigation rail, a list pane, a detail pane.
- Pages: **Overlays** (enable/delete overlay rows; the profile switcher heads the
  list), **Profiles** (create/rename/duplicate/delete/switch) and **Global**
  (app-wide preferences and the auto-switch rules editor).
- Detail panes stage edits into one of three drafts — profile, preferences,
  rules — and the sticky footer saves or discards all pending ones.
- Settings that something else re-reads every frame apply immediately where the
  user is meant to watch them (enable toggles, pause, rail collapse, theme,
  background tracking, the selection-border animation).
- Window close hides it; only tray Exit quits the app.

## Map

`src/ui.rs`

- Entry: `PingApp`; `frame_ui` is exactly what eframe calls, `logic()` runs
  before the panes are drawn, and `config_ui` lays out the three panes:
  `show_rail`, `show_list_pane`, `show_detail_pane`, `show_status_bar`.
- Page structure: `Page` / `PAGES`; `page_has_list_pane`,
  `page_has_detail_footer`; `rail_width`, `list_pane_column`,
  `list_pane_row_height`, `DETAIL_FOOTER_HEIGHT`.
- Drafts: `dirty` (profile), `prefs_dirty` (preferences), `rules_dirty`
  (auto-switch rules); `has_pending_edits` / `pending_edits`; `save_edits`,
  `persist_current`, `save_prefs`, `persist_rules`, `discard_edits`.
- Selection: `selected_id` (overlay, view-only), `selected_target` (host,
  view-only), `selected_target_in`, `toggled_selection`,
  `selected_overlay_for_border`.
- Profiles: `show_profile_switcher`, `show_profile_detail`,
  `show_profile_dialog`; `switch_profile`, `refresh_profiles`, `sync_profiles`,
  `sync_profile_cache`, `profile_overlay_counts`; `profile_row_contents`,
  `overlay_count_label`.
- Live pushes: `sync_runtime_config`, `push_config`, `last_pushed`;
  `sync_border_preview` / `release_border_preview`; `sync_theme`,
  `choose_theme`, `draw_theme_icon`; `sync_window_title`; `sync_monitors`;
  `sync_auto_preview_text`.
- Overlay editors: `edit_overlay` (General / selected-host editor / Position /
  Display Mode / Graph / Colors / Startup Behaviors), `edit_target`,
  `edit_target_colors`.
- Sticky picker: `StickyPicker` (`displace` / `restore_displaced`, `poll`,
  `pick_step`, `fill_sticky_target`, `own_capture_window`, `pick_cursor`,
  `draw_crosshair_icon`), `PICK_BUTTON_WIDTH`, `winwatch::shapes`.
- Links and glyphs: `requested_url` / `open_requested_urls` /
  `open_url_in_browser`; `GLOBAL_ICON_ROWS`; `about_page_column`,
  `empty_editor`; layout helpers `row_inner`, `right_anchored`,
  `list_pane_row_width_for`.
- Preference writers: `set_background_tracking`,
  `set_selection_border_animation`, `choose_theme`.
- Tests: `PingApp::for_test` (temp root; the tray and renderer spawns are
  skipped by `attach: false` in the shared `build` body), `frame_ui` versus
  `frame_logic` (driving tests never call the latter), `drive` / `drive_tall`,
  `text_rects`, `click_text` (asserts the label is unique). The tests module's
  `use super::{...}` is an explicit list.

## How & why

- **`for_test` is the only release-visible piece of the seam**, and production
  only ever calls `build(attach: true)`; everything else is `#[cfg(test)]`.
- **One draft per source, one footer for all three.** The footer is enabled
  while any of `dirty` / `prefs_dirty` / `rules_dirty` is set; the two-flag
  version shipped and made every Global preference unsaveable.
- **Every draft writer has the same guard.** `save_prefs` returns early when
  `!prefs_dirty`, `persist_current` when clean, `persist_rules` likewise: a
  Save for one draft must never rewrite a file whose draft is clean.
- **A setting something else re-reads every frame is written live and to the
  draft** (`set_background_tracking`, `set_selection_border_animation`,
  `choose_theme`): a draft-only write is silently undone by the next pass.
- **Selections are view-only.** `selected_id` and `selected_target` never hold
  staged edits, so clearing them is free. `selected_target` is cleared wherever
  `selected_id` changes and resolved by `selected_target_in`, which looks up by
  id and returns `None` for anything that is not one of this overlay's hosts —
  a stale selection shows no editor rather than another host's fields.
- **No startup auto-selection** of an overlay: it animated a border the moment
  the window opened. Only explicit actions (a row click, delete, a profile
  switch) set the selection.
- `selected_overlay_for_border` encodes four conditions — window open, Overlays
  page showing, something selected, animation enabled — and is itself the
  tested mechanism, because `sync_border_preview` compares against the last
  sent value and sends only changes.
- **A cache needs both triggers.** `profile_overlay_counts` is filled by the
  profile mutations and by arriving on the Profiles page (`sync_profiles`
  watching `last_page`); a count absent from the map draws nothing, never
  `unwrap_or(0)`.
- **Rows are painted, not widgets** (`allocate_exact_size`, `rect_filled`,
  `new_child`), so a label can sit beside a control. A painted row is
  allocated at `list_pane_row_height`, never at its content height.
- **The deselect strip is `ui.interact`, never an allocated widget**: a real
  widget of the leftover height conjured a scrollbar on a list that fitted.
- Columns are centred with `with_layout`, never `vertical_centered`; a child
  that does not fill its box can report a min rect larger than that box and
  move everything laid out after it.
- Pane switching is never guarded; only profile switching is. A pane that draws
  itself through `new_child` is invisible to the parent layout, so `config_ui`
  advances the cursor after `show_list_pane`.
- eframe's native runner ignores `OpenUrl`, so `open_requested_urls` drains the
  command at the end of the UI pass and `open_url_in_browser` calls
  `ShellExecuteW`, reporting either outcome in the status bar.
- The sticky picker holds the mouse capture and polls rather than installing a
  hook; it displaces the window instead of hiding it, and commits on the
  release edge before re-taking the capture. A pick fills process and class,
  never the title.
- **The window has to fit**: pinned by
  `the_window_fits_the_rail_the_list_and_the_detail_pane` and
  `the_detail_pane_keeps_its_scrolling_area_above_the_footer`.

## Config keys / UI

| Key | Default | Edited on |
|---|---|---|
| `activeProfile` | `default` | Profiles page / the switcher |
| `ui.theme` | `system` | Global → Appearance (mode tiles) |
| `ui.railCollapsed` | `false` | the rail's collapse control |
| `ui.showVersionInTitle` | `false` | Global |
| `ui.selectionBorderAnimation` | `true` | Global |
| `ui.backgroundTracking` | `true` | Global |

## Tests that pin it

`the_footer_follows_every_draft`, `the_background_tracking_toggle_is_staged_and_live`,
`the_selection_border_toggle_is_staged_and_live`,
`the_border_preview_only_runs_on_the_overlays_page`,
`the_deselect_strip_does_not_disturb_the_scroll_content`,
`a_pane_that_draws_itself_keeps_its_place`,
`the_detail_footer_stays_under_the_detail_pane`,
`a_painted_row_carries_its_margin`,
`a_list_pane_row_puts_its_contents_inside_its_own_fill`,
`a_profile_row_fits_its_pane`, `an_overlay_row_fits_its_pane`,
`the_list_pane_column_is_centred_in_its_pane`,
`arriving_on_the_profiles_page_re_reads_the_counts`,
`coming_back_to_the_profiles_page_reads_again`,
`the_global_glyph_is_centred_and_stays_inside_its_box`,
`the_theme_glyphs_stay_inside_their_boxes`, `the_theme_tiles_fit_their_pane`,
`choosing_a_theme_changes_it_and_survives_the_next_pass`,
`a_link_click_becomes_a_url_to_open`,
`a_pick_commits_on_the_release_after_its_press`,
`a_picked_window_fills_process_and_class_but_not_the_title`,
`the_pick_glyph_stays_inside_its_box`,
`the_window_fits_the_rail_the_list_and_the_detail_pane`,
`the_detail_pane_keeps_its_scrolling_area_above_the_footer`.

## Related

- `theming.md` — the window's palette and its files.
- `config/storage.md` — what the drafts become on disk.
- `runtime.md` — the config window's process and pipe role.
