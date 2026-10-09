# Theming — the Config window's palette, and nothing else

Status: shipped (v0.2.x) · Read when: changing `src/theme.rs`, the theme tiles,
`ui.theme`, or anything that reads a colour in the Config window.

## What it does

- The Config window is painted from one of two embedded palettes (Dark / Light)
  or an edited copy in the config directory's `themes/` folder; `System`
  follows the Windows app theme.
- A theme is the window's own colours — the overlay graphs keep their
  per-overlay settings, the tray menu is a native `HMENU` Windows paints, and
  the tray icon and About logo are brand artwork. None of them are themed.
- Missing or partial theme files are repaired or filled from the built-in for
  the mode; a file that parses is honoured in place, so editing one is a real
  thing to do.

## Map

- `src-tauri/src/theme.rs`: `Mode`, `ThemeMode` (`file_name()`), `Palette`,
  `ColorsFile` (`Option<String>` per key), `Theme`, `windows_app_mode()`,
  `resolve(preference, system)`, `parse_theme_file`, `embedded`, `builtin`,
  `load_builtin`, `ensure_builtin_file`, `safe_asset_name`, `contrast_report`,
  `apply(ctx, theme)`, `visuals_for`, `relative_luminance`, `contrast_ratio`,
  `readable_pairs`.
- `src-tauri/src/ui.rs`: `theme_choices`, `theme_tiles` (painted squares),
  `theme_tile_side`, `choose_theme`, `draw_theme_icon`, `sync_theme` (method
  and free function).
- `config.rs`: `ui.theme` in `GlobalPrefs`.
- The 15 `UI_*()` accessors are thread-local palette readers used across
  `ui.rs`; a test needing a palette must set it (single UI thread, one palette
  per frame).

## How & why

- `Visuals::light()` and `Visuals::dark()` are not one palette with the ends
  swapped; much widget drawing (ticks, scrollbars, selections) derives from the
  base. `visuals_for` switches the base and then applies the palette
  (`the_mode_really_switches_the_egui_base`).
- A theme change has to reach egui's widgets: `Context::set_visuals` writes
  whichever slot egui currently considers active (its `theme_preference`
  defaults to `System` and is re-read every pass). `theme::apply` fills **both**
  `Options::dark_style` and `Options::light_style` and then calls `set_theme`
  (`a_theme_change_reaches_the_widgets_after_egui_switches_slots`,
  `both_egui_theme_slots_get_the_palette`).
- The painted half reads the thread-local palette (immediate); the widget half
  reads `Visuals`. A theme bug can therefore look partial — check a button,
  not the background.
- "Immutable" means repaired, not overwritten: built-ins are `include_str!`
  and written only when missing or unparseable
  (`a_missing_theme_file_is_restored_and_an_edit_is_kept`).
- `ColorsFile` holds `Option<String>` per key so a missing colour inherits the
  built-in for the mode being loaded; a `Default` cannot know the mode
  (`a_missing_colour_falls_back_to_the_built_in_for_that_mode`).
- Asset names are user-writable, so `safe_asset_name` keeps only a bare file
  name; the worst case for anything else is a missing picture and a built-in
  fallback (`an_asset_cannot_point_outside_the_theme_directory`,
  `assets_are_optional_and_absent_means_draw_it`).
- A theme can be unreadable and still load perfectly — `contrast_report` runs
  on the way in and the built-ins are held to WCAG AA in a test
  (`both_builtin_themes_are_readable`,
  `an_unreadable_theme_loads_and_is_only_caught_by_contrast`).
- `choose_theme` writes the live `prefs` **and** `prefs_draft`, because
  `sync_theme` re-reads the saved preference every pass; a draft-only write is
  applied then silently undone. Discard restores `prefs` and the same pass puts
  the theme back (`choosing_a_theme_changes_it_and_survives_the_next_pass`,
  `clicking_a_theme_tile_stages_and_saves`).
- `sync_theme` runs every pass on a cheap registry read, because Windows can
  change `System` with no message; the comparison is on the **mode**, not the
  theme (`the_theme_is_reloaded_only_when_the_mode_moves`,
  `the_system_setting_chooses_the_mode`).
- The mode tiles are painted squares using `Style::interact_selectable`
  visuals, with painted glyphs — no artwork, no light/dark variants. The moon's
  bite is exact only over its own tile; do not reuse the glyph over another
  surface (`the_theme_glyphs_stay_inside_their_boxes`,
  `the_theme_tiles_fit_their_pane`).
- A test must not depend on the machine's Windows theme: pin an explicit
  `Light`/`Dark`.

## Config keys / UI

| Key / file | Meaning |
|---|---|
| `ui.theme` | `system` (default) / `light` / `dark` |
| `<config dir>/themes/` | the editable built-in files (`Mode::file_name`), plus asset pictures |
| theme file keys | the palette colours; a missing key inherits the built-in for that mode |
| asset names | bare file names only; resolved inside the themes directory |

## Tests that pin it

`both_embedded_themes_parse`, `the_dark_builtin_is_the_palette_the_app_has_shipped`,
`both_builtin_themes_are_readable`, `an_unreadable_theme_loads_and_is_only_caught_by_contrast`,
`a_missing_colour_falls_back_to_the_built_in_for_that_mode`,
`contrast_is_symmetric_and_bounded`, `an_asset_cannot_point_outside_the_theme_directory`,
`assets_are_optional_and_absent_means_draw_it`,
`a_missing_theme_file_is_restored_and_an_edit_is_kept`,
`a_theme_change_reaches_the_widgets_after_egui_switches_slots`,
`both_egui_theme_slots_get_the_palette`, `the_system_setting_chooses_the_mode`,
`the_preference_resolves_against_the_system`,
`the_mode_really_switches_the_egui_base`,
`the_theme_is_reloaded_only_when_the_mode_moves`,
`choosing_a_theme_changes_it_and_survives_the_next_pass`,
`the_theme_choice_labels_and_hints_say_what_the_tiles_cannot`,
`the_theme_glyphs_stay_inside_their_boxes`, `the_theme_tiles_fit_their_pane`,
`clicking_a_theme_tile_stages_and_saves`.

## Related

`config/window.md` (where the tiles live), `config/storage.md` (`ui.theme`),
`runtime.md` (the shell vs `core` split).
