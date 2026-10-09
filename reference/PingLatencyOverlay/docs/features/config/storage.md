# Config storage — profiles, globals and rules on disk

Status: shipped (v0.2.39) · Read when: touching `config.rs`, persistence, migrations, clamps or the rules file.

## What it does

- Everything persistent is `Store` in `crates/core/src/config.rs`, rooted at one
  directory so a test can point it at a temp folder. `PLO_CONFIG_DIR` overrides
  the root; the default lives under the user's profile (`.config/.PingLatencyOverlay`).
- A **profile** is one JSON file in `profiles/`; app-wide preferences are
  `globalconfig.json`; auto-switch rules are `rules.json` — all in the same root.
- What a profile *means* to a user is `docs/SPEC.md`; this page is the map, the
  mechanism and the traps.
- Adding a field is non-breaking for files an older build wrote: every
  preference is `#[serde(default)]`, and legacy keys are read once and rewritten
  in the new shape. Files are written atomically, so `(mtime, len)` stamps can
  be trusted.

## Map

- `crates/core/src/config.rs` — all of it: `Store` (`load`, `list_profiles`,
  `save_profile`, `create_profile`, `rename_profile`, `duplicate_profile`,
  `delete_profile`, `backfill_profile_names`, `save_rules`, `load_rules`,
  `write_global_prefs`), `Config`, `OverlayConfig`, `TargetConfig`,
  `ProfileEntry`, `GlobalPrefs`, `UiPrefs`, `ConfigNotice`,
  `sanitize_profile_name`, `with_postfix`, `Config::normalize`,
  `Config::validate`, `parse_and_validate`, `migrate_probe_into_targets`.
- `crates/core/src/rules.rs` — the pure rule engine shared by the tray and the
  window; the file I/O for `rules.json` stays in `Store`.
- Clamp constants (used by `normalize` and the UI): `MIN_GRAPH_HEIGHT_PX`,
  `DEFAULT_SMOOTH_FPS`, `MAX_SMOOTH_FPS`, `DEFAULT_BG_OPACITY`, line glow
  (`DEFAULT_LINE_GLOW_INTENSITY` 10, 0–100; `DEFAULT_LINE_GLOW_RADIUS_PX` 30,
  2–50), stroke (`DEFAULT_LINE_STROKE_PX` 1.5, 0.5–6), cursor
  (`DEFAULT_SAMPLE_CURSOR_SIZE_PX` 10, 4–20).
- The config tests are the behaviour spec for all of this; see below.

## How & why

### A profile has two names

- The **id** is the file name and the only unique part: a lowercase slug, at
  most 48 characters via `sanitize_profile_name`. The free-form `profileName`
  inside the file is display only and may repeat.
- A collision postfixes the id (`profile_work_2.json`) rather than refusing, and
  `with_postfix` keeps the postfixed id inside the cap so `list_profiles` still
  accepts it. `create_profile`, `rename_profile` and `duplicate_profile` all
  return the resulting `ProfileEntry`.
- `Store::load` builds its candidate list from the stored **file name**, then
  the stored **id**, then `default` — and never scans the directory for a
  substitute. A missing `default` on a first run is the fresh-config case, not a
  `ProfileFallback`; that is why the notice is the thing to test for, not the
  absence of a profile.
- `Store::backfill_profile_names` writes a derived display name into existing
  files at startup and reports it as a `ConfigNotice`. Unreadable files are
  never rewritten. **A test that writes a profile file must include
  `profileName`**, or it will pick up a `ProfileNamesBackfilled` notice it did
  not expect.

### Globals

- `GlobalPrefs` / `UiPrefs`, every field `#[serde(default)]`, which is what makes
  adding a preference a non-breaking change to a file written by an older build.
- `write_global_prefs` replaces only the `ui` key, so the active-profile pointer
  and any key a future version adds survive. Never write that file as a whole
  object.

### Normalize before validate

- `parse_and_validate` normalizes **before** it validates, and the order is
  load-bearing: validating first rejects every existing user's file, because a
  pre-grouping profile has no `targets` key at all, and the error would describe
  the migration rather than anything the user did.
- Normalization is where editor-out-of-range values settle: window seconds,
  scale, smooth fps, prefill/border animation seconds, margins, graph height,
  latency ceiling, background opacity, glow intensity/radius, stroke width,
  cursor size, orientation validity. It also consumes the legacy keys:
  `probe`/`timeoutMs`/`lineColor`/`timeoutColor` fold into one target,
  `marginPx` is mapped per anchor so a migrated overlay keeps its screen
  position, and `wallpaperMode` folds into `DisplayMode::Wallpaper` only when
  the file names no mode of its own.
- `validate` rejects what normalize must not invent: an overlay with no host
  would otherwise put `1.1.1.1` on someone's screen they never asked to ping.

### rules.json

- It is its own file, and the tray re-reads it on `(mtime, len)`.
  `Store::save_rules` goes through `write_atomic`, so noticing a change can
  never mean reading half a file.
- A parse failure **keeps the rules already loaded** — compiling "no rules"
  would strand the user on the fallback because of a typo — while deleting the
  file means off. A rules Save is the explicit permission to replace an
  unparseable file.

## Config keys / UI

| Where | Key | Notes |
|---|---|---|
| `globalconfig.json` | `activeProfile` | file-name pointer; written on switch and Save |
| `globalconfig.json` | `ui.theme` | `system` / `light` / `dark` |
| `globalconfig.json` | `ui.showVersionInTitle` | window title suffix |
| `globalconfig.json` | `ui.railCollapsed` | navigation rail |
| `globalconfig.json` | `ui.selectionBorderAnimation` | preview border on selection |
| `globalconfig.json` | `ui.backgroundTracking` | keep departed probes alive |
| env | `PLO_CONFIG_DIR` | config root override (all three processes) |
| env | `PLO_LOG` | release builds log only when set |

Profile schema (overlays, targets, appearance keys) is documented per feature:
see `overlays/*.md`.

## Tests that pin it

`the_config_dir_override_applies_only_when_it_names_a_path`,
`a_rooted_load_reads_the_sandbox_it_was_given`,
`the_active_profile_is_remembered_across_loads`,
`the_stored_file_name_finds_the_profile_without_an_id`,
`a_postfixed_profile_id_round_trips_through_the_stored_file_name`,
`a_deleted_stored_profile_falls_back_to_the_default_not_to_another_one`,
`a_stored_file_name_that_is_not_a_profile_file_falls_back`,
`an_unusable_active_profile_falls_back_to_the_default`,
`a_missing_active_profile_falls_back_and_corrects_the_stored_key`,
`a_profile_can_be_duplicated`,
`a_fresh_install_creates_an_empty_default_profile_and_global_config`,
`an_existing_default_profile_keeps_the_old_config_file`,
`a_profile_without_a_monitor_field_loads_and_follows_the_primary`,
`a_legacy_wallpaper_key_still_turns_wallpaper_mode_on`,
`a_pre_targets_profile_becomes_one_target`,
`a_migrated_profile_no_longer_writes_the_legacy_keys`,
`a_profile_that_already_has_targets_gains_none`,
`an_overlay_with_no_hosts_is_refused_rather_than_given_one`,
`a_zero_timeout_is_repaired_on_every_host`,
`an_added_host_does_not_inherit_its_neighbours_colour`,
`a_missing_rules_file_loads_as_inert_defaults`,
`a_broken_rules_file_is_an_error_and_is_left_alone`,
`the_title_version_preference_defaults_to_off_and_round_trips`,
`the_selection_border_animation_defaults_on_and_round_trips`,
`the_background_tracking_preference_defaults_on_and_round_trips`.

## Related

- [runtime.md](../runtime.md) — how a loaded config reaches the renderer.
- `config/window.md` — the editor that stages and saves these files.
- `overlays/*.md` — the profile schema per overlay feature.
