# Sample cursor — a per-host triangle that points at the head of each line

Status: shipped (v0.2.37) · Read when: changing `draw_sample_cursor`,
`line_y_at_x`, `CursorAnimation`, the cursor reserves, or the Colors rows.

## What it does
- One white triangle with a dark rim per host line, anchored to the leading
  edge of the graph. The base sits flush at the edge; the apex points back
  along the line, one size behind the edge.
- The apex sits on the **drawn** line at that x — interpolated between
  samples (a spike's flank, the resume jog after a timeout) — not on the
  nearest sample's value.
- It eases (~150 ms) to a new value instead of jumping, and asks for repaints
  while it moves, so it animates in index mode too.
- Through a timeout it holds the last drawn value; during the startup prefill
  it rides the prefill head.
- Default on, including a profile written before the setting existed (absent
  key = on), unlike the underglow.
- With the timeout blink on, the cursor pulses in its own colour while the
  newest sample is a failure: dim → bright → dim every 2 s, starting the
  moment the failure is probed rather than when smooth rendering reveals it,
  and back to white the moment a value arrives.

## Map
- `render.rs`: `draw_sample_cursor` (with `CursorLook`), `line_y_at_x` (with
  its `cover` helper), `CursorAnimation { y, at, active }` + `advance(now,
  target)` / `is_active`, `Series.cursor: Option<&'a mut CursorAnimation>`,
  the cursor pass in `render_graph_into_internal`, `SAMPLE_CURSOR_FILL` /
  `SAMPLE_CURSOR_RIM` / `SAMPLE_CURSOR_RIM_WIDTH` / `SAMPLE_CURSOR_EDGE_MARGIN`,
  `CURSOR_EASE_SECS` / `CURSOR_EASE_EPSILON`, `sample_cursor_size` /
  `sample_cursor_half_height` / `sample_cursor_reserve_px` /
  `sample_cursor_room_px`; the blink's `timeout_blink_anchor`,
  `CURSOR_TIMEOUT_BLINK_PERIOD` / `CURSOR_TIMEOUT_BLINK_FLOOR`.
- `overlay.rs`: `WindowSeries.cursor` and `.max_sample_gap`, the `cursor_due`
  and `blink_due` terms in the `apply` render gate, `cursor_repaint_interval`
  and `timeout_blink_repaint_interval` (both chained in `bin/renderer.rs`'s
  `repaint_interval`).
- `config.rs`: `sample_cursor`, `sample_cursor_size_px`,
  `cursor_timeout_blink`, `cursor_timeout_blink_color`, the size/blink consts
  and the `normalize` clamp.
- `ui.rs`: the Colors pane's "Sample cursor" checkbox, "Cursor size" slider,
  "Blink on timeout" checkbox and "Blink color" picker.

## How & why
- Graph-space geometry, all three vertices through `transform_point`, so it
  rotates and mirrors with the line: apex `(base_x - size, y)`, base corners
  `(base_x, y ± size * 0.7)`, where `base_x = long_px - SAMPLE_CURSOR_EDGE_MARGIN`.
- `line_y_at_x` walks the series with `draw_series`' own state machine —
  connectors, resume stubs, gaps — so the apex cannot drift from the drawn
  line; the last covering segment wins and the fallback is the newest revealed
  valued sample (the timeout rule).
- The easing state lives per series in `WindowSeries` and is threaded to the
  renderer as `Series.cursor`; the pure test path passes `None` and draws the
  target directly. Exponential ease with τ = 0.15 s; the first frame and any
  long gap snap; an epsilon of 0.25 px settles it (`active = false`).
- Repaints: `apply`'s `cursor_due` and `cursor_repaint_interval` use the
  border clock (~16.7 ms) while any cursor is easing — index mode has no frame
  clock of its own and would otherwise move only when a sample arrives.
- The timeout blink reads the raw samples, not the reveal-filtered slice, so
  a failure starts pulsing the moment it is recorded. `timeout_blink_anchor`
  requires the newest real sample to be a failure no older than
  `max_sample_gap` (a host that stopped probing stops blinking), walks back
  over the contiguous run and returns its first timestamp; the fill is the
  blink colour scaled from 35% to 100% by `0.5 − 0.5·cos(2π·(now − anchor) /
  2 s)`, and a value sample restores white. `blink_due` in `apply` and
  `timeout_blink_repaint_interval` in the renderer's chain supply the frames
  while the run lives.
- Two reserves, read by both `overlay::layout_in_rect` and the renderer:
  `sample_cursor_reserve_px` is a constant 2 px gutter at the leading edge
  (edge margin + half the rim), and `sample_cursor_room_px` (`ceil(size * 0.7
  + rim / 2 + 1)`) pads the ceiling end of the latency axis. The zero-line
  end shares its band with the glow's reserve, so `layout_in_rect` keeps
  `max(glow reserve, cursor room)` there rather than adding both; a cursor on
  0 ms or clamped at the ceiling stays whole either way.
- Draw order: after the cores, before the border, per host. At the minimum
  size 4 the triangle is mostly rim — cosmetic, not a bug.

## Config keys / UI
| Key | Default | Range / clamp | Control |
| --- | --- | --- | --- |
| `sampleCursor` | on (new and absent) | on/off | Colors → Sample cursor |
| `sampleCursorSizePx` | 10 | 4–20 | Colors → Cursor size |
| `cursorTimeoutBlink` | off (new and absent) | on/off | Colors → Blink on timeout |
| `cursorTimeoutBlinkColor` | `#ef4444` | hex | Colors → Blink color |

## Tests that pin it
`the_sample_cursor_sits_flush_at_the_leading_edge`,
`the_sample_cursor_apex_moves_with_its_size`,
`the_sample_cursor_stays_on_the_last_drawn_value_through_a_timeout`,
`a_cursor_on_the_zero_line_or_the_ceiling_stays_whole`,
`the_cursor_animation_eases_toward_its_target`,
`the_sample_cursor_reserves_room_on_both_axes`,
`the_timeout_blink_pulses_dim_then_bright`,
`the_timeout_blink_starts_before_smooth_rendering_reveals_the_failure`,
`a_value_sample_ends_the_timeout_blink`,
`the_timeout_blink_anchor_is_the_start_of_the_failed_run`,
`cursor_timeout_blink_defaults_off_and_round_trips`.

## Related
[rendering.md](rendering.md) · [glow.md](glow.md) ·
[smooth-rendering.md](smooth-rendering.md)
