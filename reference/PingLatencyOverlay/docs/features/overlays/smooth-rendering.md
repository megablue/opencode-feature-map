# Smooth rendering — the reveal hold and the x mapping

Status: shipped (v0.2.39) · Read when: changing `map_x`, `visible`, the reveal cut in `draw_series`/`line_y_at_x`, or smooth-mode tests.

## What it does

- With `smoothRendering` on (the default), the graph scrolls continuously between samples: every point is positioned by its real age instead of by a fixed slot, so the whole line moves as one surface.
- Smooth mode presents the line three sample intervals behind live, and the time window is shifted by the same hold, so the newest revealed instant sits at the leading edge. An incoming sample is revealed over its own interval — the tip walks the segment instead of the segment appearing whole.
- Index (immediate) mode is untouched by all of this: it steps one slot per sample and has no live edge to hold back.

## Map

- `SMOOTH_REVEAL_DELAY` (render.rs) = 3 × `SAMPLE_INTERVAL` (1s); `SAMPLE_INTERVAL`.
- `render_graph_into_internal`: `let reveal = (smooth && config.smooth_rendering).then(|| now - SMOOTH_REVEAL_DELAY);` then `map_x`, `visible`, the `draw_lines` closure, the marker loop, the cursor pass.
- `draw_series` takes `reveal` and draws the partial tip; `line_y_at_x` takes the same cut.
- Overlay side: `smooth_due` in `OverlayWindow::apply` via `smooth_frame_interval(smooth_fps)`; `render_window`'s `render_smooth`/`smooth` flags; `bin/renderer.rs::repaint_interval`.
- The cursor's own easing and timeout-blink repaints are separate clocks; the
  blink deliberately reads the raw samples rather than the reveal cut — see
  [sample-cursor.md](sample-cursor.md).

## How & why

- **Position by age, not index.** Smooth: `x = axis_long * (1 - (age - D) / window)`; index: `x = (index + 0.5) * step` with `step = axis_long / windowSeconds`. Ages inside the hold (age < D) map past the axis end; only the partial tip's interpolation reads them — nothing newer than D is ever stroked.
- **One instant owns the cut.** The frame is drawn to `now - D`: `draw_series` stops at the first sample newer than the cut and draws a partial segment up to it (never while a new run is starting); the marker loop skips samples newer than it; `line_y_at_x` stops at the same instant. The whole frame agrees on where "now" ends.
- **The axis ends at the newest revealed instant.** `map_x` discards a sample only when `age > window + D`, and `visible` crops at the same threshold — the oldest point shown is window + hold old.
- **The line pass keeps one sample older than the cut** (`visible(..., keep_older: true)`): its x is negative, so the departing segment is clipped by the canvas edge instead of the polyline starting at the oldest on-screen vertex. The marker loop and the cursor keep the tight crop. `map_x` never returns `None` — a negative x is exactly what the line pass wants.
- **Index mode passes `None`** for the reveal: it has no live edge, so nothing is withheld.
- **The reveal applies during the startup prefill too** (cosmetic; it self-resolves as the reveal catches up).
- **The cadence is its own decision.** Smooth mode repaints at `smooth_frame_interval(smooth_fps)` (default 60, up to 1000), gated by `running && smoothRendering && (sample_generation > 0 || prefill completed)`. Index mode has no frame clock of its own.

## Config keys / UI

| Key | Default | Range | Control |
|---|---|---|---|
| `smoothRendering` | true | — | checkbox |
| `smoothFps` | 60 | …–1000 | DragValue, enabled with smooth only |

## Tests that pin it

- `smooth_mode_stops_at_a_delayed_reveal_time`
- `the_reveal_tip_walks_the_segment_as_time_passes`
- `the_line_reaches_the_left_edge_through_one_older_sample`
- `a_one_second_cadence_is_not_a_gap`
- `a_data_gap_is_not_interpolated_in_smooth_mode`
- `smooth_rendering_uses_timestamp_positions`
- `a_data_gap_is_not_interpolated_in_index_mode` — the index counterpart

## Related

- [rendering.md](rendering.md) — the draw order, reserves and transforms
- [sample-cursor.md](sample-cursor.md) — the eased cursor that rides this mapping
- [../probes.md](../probes.md) — the sample cadence the hold is measured in
- `docs/SPEC.md` — the X-axis section describes the user-visible behavior
