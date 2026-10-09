# Overlay rendering — layered windows, the draw order, and the reserves

Status: shipped (v0.2.39) · Read when: changing `overlay.rs` or `render.rs`, the window layout, the draw order, or any reserve.

## What it does

- Every overlay is a native `WS_EX_LAYERED` popup drawn with `UpdateLayeredWindow`: true per-pixel alpha, no DWM frame, no taskbar button, no focus, and mouse passthrough.
- One overlay draws the optional background fill, one line per host, per-host timeout marks (Stick / Stub / Gap), the startup prefill, the underglow, the sample cursor, and the selection/preview border.
- Orientation (0/90/180/270) and mirror decide how the graph maps into the window; an anchor plus margins place the window in the work area.
- Where the window lives (normal, sticky to a window, wallpaper) is a display mode — see [display-modes.md](display-modes.md).

## Map

`crates/core/src/overlay.rs`

- `OverlayManager` — owns the windows; `apply` pushes each new config/samples; `follow_sticky`; `reassert_topmost`; the repaint intervals.
- `OverlayWindow` — `hwnd`, `config`, `series: Vec<WindowSeries>`, `prefill`, `prefill_points`, `border`, `pixels`, `sample_generation`, `size`, `position`, `hidden`, `dirty`, `last_rendered`, the layered surface.
- `WindowSeries` — per target: `target_id`, `samples`, `generation`, `history`, `cursor`.
- `layout_in_rect` / `position_for_anchor` — the window rect for a `MonitorInfo`.
- `render_window` — builds the `Series` slice and calls the renderer; `rebuild_history`; `sync_series`.
- `overlay_wnd_proc` — `WM_CLOSE | WM_QUERYENDSESSION` set `quit_requested` instead of falling through to the default handler.

`crates/core/src/render.rs`

- `render_graph_into_with_border` / `render_series_into_with_border` → `render_graph_into_internal`.
- `Series`, `SamplePoint`; `draw_series` (one host's polyline), `draw_sample_cursor`, `line_y_at_x`, `stroke_run`, `LinePass`; `TimeoutIndicator`, `TIMEOUT_STUB_HEIGHT`.
- `map_x` / `map_y` / `visible`; `transform_point` / `rotation` / `glow_direction`; `parse_hex_color`; the prefill generators.
- Reserves: `line_glow_reserve_px`, `stroke_pad`, `sample_cursor_reserve_px`, `sample_cursor_room_px`; `SMOOTH_REVEAL_DELAY`, `SAMPLE_INTERVAL`.

`crates/core/src/border.rs` — `BorderAnimator`, `draw_border`, the manual premultiplied `blend_pixel`, `border_frame_interval`.

`crates/core/src/monitors.rs` — `enumerate` (the only Win32 in it) vs `resolve`/`placement` (pure over a list, so the multi-monitor rules are testable).

`crates/core/src/bin/renderer.rs` — the message pump (`pump_messages`), `repaint_interval`, `wait_before`, `MESSAGE_POLL_INTERVAL` / `REPAINT_INTERVAL`.

## How & why

- **The pixels are premultiplied RGBA until the DIB.** `render.rs` writes premultiplied RGBA; `overlay.rs` swaps R/B to premultiplied BGRA for the 32-bit DIB. `bgOpacity = 0` leaves alpha at zero; a positive value fills the panel first.
- **The draw order is one order: casts, markers, cores, cursor, border.** With the glow on, every series casts first (`LinePass::Glow`), then every timeout marker, then every core. A `Stick` marker spans the canvas even through the glow's reserved band, so a cast can never tint a marker into the glow, and a core still lands on top of a marker it crosses. The cursor draws over the cores; the border last.
- **A reserve is one number read by both the box and the drawing.** `line_glow_reserve_px` = `ceil(reach + 0.5)` grows the window's short dimension and insets the graph's `bottom`, where the reach is `glow_reach_px` — the radius at full intensity, scaled by its square root, so a fainter glow takes less room; `stroke_pad` = `(width / 2 + 0.5).max(2)` keeps a thick line from being sliced at a pixmap edge; `sample_cursor_reserve_px` is a constant 2px gutter on the long axis; `sample_cursor_room_px` pads the ceiling end of the short axis and shares the zero-line end with the glow reserve, which keeps `max(reserve, cursor_room)` there rather than their sum. Layout and renderer must never disagree, which is why each is a single function.
- **The axis keeps the size the config names.** `graphHeightPx` survives the glow reserve and the cursor room because the box grows first; `axis_long = long_px - cursor_reserve` keeps the time axis at its configured length.
- **`transform_point` owns orientation and mirror.** 90/270 swap the long and short axes; the graph's own +Y direction (toward the zero line) is `glow_direction`, which shares `rotation` with `transform_point`, so a rotated overlay's cast rotates with it.
- **The graph uses the actual physical window size.** The layout multiplies by the monitor's DPI; `layout_for` takes a `&MonitorInfo` so a DPI number and a work area cannot disagree.
- **An overlay is N hosts, not an overlay per host.** One overlay owns one line per target; `sync_series` matches by target id so a reorder or removal does not reset the lines below it. The startup prefill is seeded per target id and fed through the same `draw_series` as real samples.
- **The line breaks where nothing was measured.** `sample_gap_threshold(timeout_ms)` = timeout + one interval + slack; every `None` sample draws the overlay's configured mark (`timeout_indicator`): a full-height `Stick` (the default), a two-pixel `Stub` resting on the canvas bottom, or a `Gap` for nothing at all. The next valued sample resumes with a vertical stub from the carried value. The user-visible rules are in `docs/SPEC.md`.
- **A hidden window is one flag with three consequences.** `hidden` (pinned display unplugged, or sticky target minimized/closed/matchless) skips the prefill and border repaint clocks, skips the topmost re-assert, and keeps the series so the graph returns with its history.
- **The border is drawn last and animates on its own clock** (`border_frame_interval`, ~60fps) through a manual premultiplied blend; the selection preview and the per-overlay startup border effect are separate settings (SPEC).
- **In pixel tests, unpremultiply the alpha before comparing colours.** A 1.5px antialiased stroke stores roughly half the colour at its edges; matching raw bytes finds only the fully covered middle.

## Config keys / UI

| Key | Default | Range / clamp | Control |
|---|---|---|---|
| `orientation` | 0 | 0 / 90 / 180 / 270 | combo |
| `mirrored` | false | — | toggles |
| `windowSeconds` | 60 | — | slider |
| `scale` | 2 | — | slider |
| `graphHeightPx` | 60 | `MIN_GRAPH_HEIGHT_PX` | DragValue |
| `maxYMs` | 1000 | — | DragValue |
| `timeoutIndicator` | stick | stick / stub / gap | combo |
| `bgColor` / `bgOpacity` | `#0f172a` / 0 | opacity 0–100 | colour + slider |
| `lineStrokePx` | 1.5 | 0.5–6 | slider |
| `horizontalMarginPx` / `verticalMarginPx` | 0 | — | sliders |
| `monitorDevice` | primary | — | combo (unplugged pin stays listed) |
| `lineGlow*`, `sampleCursor*` | — | — | see [glow.md](glow.md), [sample-cursor.md](sample-cursor.md) |

## Tests that pin it

- `a_host_is_drawn_where_it_would_be_drawn_alone`
- `a_data_gap_is_not_interpolated_in_smooth_mode`, `a_data_gap_is_not_interpolated_in_index_mode`
- `a_one_second_cadence_is_not_a_gap`
- `the_cosmetic_prefill_is_jagged_rather_than_a_curve`, `the_cosmetic_prefill_rests_at_a_healthy_latency`
- `a_timeout_marker_reaches_through_the_underglow_reserve`
- `the_timeout_stub_marks_only_the_canvas_bottom`, `the_timeout_gap_draws_no_marker`
- `the_stroke_pad_keeps_the_default_and_grows_with_the_stroke`, `a_thick_stroke_at_the_axis_edges_is_not_sliced`
- `the_underglow_reserves_room_on_the_short_side`, `the_sample_cursor_reserves_room_on_both_axes`

## Related

- [smooth-rendering.md](smooth-rendering.md) — the reveal hold and the x mapping
- [glow.md](glow.md) — the underglow's sweep and reserve
- [sample-cursor.md](sample-cursor.md) — cursor geometry, easing, its reserves
- [display-modes.md](display-modes.md) — global / sticky / wallpaper
- [../probes.md](../probes.md) — where the samples come from
- [../runtime.md](../runtime.md) — the process that pumps the renderer loop
