# Glow — the underglow cast under each line

Status: shipped (v0.2.33, swept in v0.2.36) · Read when: touching the glow code
in `render.rs`, its reserve in `overlay.rs`, or the Colors pane rows.

## What it does

- Per overlay, every host line casts a soft glow in its **own** `lineColor`, and
  the startup prefill casts in `prefillLineColor`.
- The cast falls toward the zero line in the graph's **own** frame: it rotates
  and mirrors with the overlay instead of staying screen-down.
- Intensity 0–100 (default 10) and radius 2–50 px (default 30), both per
  overlay. The radius is the cast's reach at full intensity, and the reach
  scales with the square root of the intensity: a fainter glow is also a
  shorter one, and the room the box reserves follows it. A new overlay starts
  with the glow on; a profile written before the setting existed has no
  `lineGlow` key and reads as off.
- The cast never appears on the far side of a line — however sharp a spike, no
  glow wraps over its peak — and no host's glow can tint another host's line.

## Map

- `render.rs`: `LineGlow { reach, intensity, dir }`; `LinePass { Glow, Core }`;
  `stroke_run`; `glow_bands` / `glow_layer_count` / `GLOW_ALPHA_FLOOR`;
  `GLOW_BAND_WIDTH`; `GLOW_BAND_STEP`; `glow_reach_px`;
  `glow_direction` and `rotation`; `line_glow_reserve_px`; the `glow` and
  `pass` arguments of `draw_series`, and the `draw_lines(pass)` closure in
  `render_graph_into_internal`.
- `config.rs`: `line_glow`, `line_glow_intensity`, `line_glow_radius_px`, the
  `DEFAULT_/MIN_/MAX_LINE_GLOW_*` consts, and the clamps in `normalize`.
- `overlay.rs`: `layout_in_rect` grows the window by the reserve.
- `ui.rs`: the Colors pane's Line glow checkbox, Glow intensity and Glow
  radius sliders (the sliders are enabled only while the checkbox is on).

## How & why

- **The cast is a sweep, never a widening stroke.** The path is copied at a
  band of depths — `GLOW_BAND_STEP` (0.75 px) apart, each copy stroked thin at
  `GLOW_BAND_WIDTH` (1.5 px) with `LineJoin::Bevel` — and slid along the cast
  direction. A widening stroke inflates perpendicular to the path, spreads
  sideways around steep flanks, and its miter joins spike outward at corners;
  that is what used to wrap glow over spike tops. A translated thin copy can
  only ever sit behind its own line, so no mask is needed and no host's cast
  can clip or tint another's.
- **Layers**: `glow_bands(reach, intensity)` is the one band list, read by
  both `stroke_run` and the reserve. `glow_layer_count(reach)` =
  `ceil(reach / GLOW_BAND_STEP)` clamped to 3..=64; layer depth runs from half
  a band out to the reach; alpha is `intensity · 255 · t²` with
  `t = 1 − depth / reach`, scaled by the spacing overlap so the near-line
  strength is stable. Bands below `GLOW_ALPHA_FLOOR` (3/255, about 2% once
  neighbours overlap) are dropped rather than drawn faintly, so the outermost
  fade neither paints nor reserves room.
- **Direction**: `glow_direction(orientation, mirrored)` is the image of the
  graph's +Y basis (toward Y0) under the same rotation and mirror
  `transform_point` uses — they share `rotation`. 0° casts down, 90° right,
  180° up, 270° left, each flipped by the mirror.
- **Reach and reserved room**: `glow_reach_px(radius, intensity)` =
  `radius · √(intensity / 100)` — full strength reaches the radius, and 0%
  reaches nothing. `line_glow_reserve_px` = `ceil(reach + 0.5)` physical px
  when a band survives the floor, else 0 — the furthest band's edge plus its
  half pixel of antialiasing, rounded up. It is read by **both**
  `overlay::layout_in_rect` (adding it to the window's short dimension) and
  `render_graph_into_internal` (insetting `bottom`), so the box and the
  drawing cannot disagree; the axis keeps the height `graphHeightPx` names.
  Below the zero line the cast's band and the cursor's room are the same
  space, so that end keeps `max(reserve, cursor_room)` rather than their sum;
  at full strength the reserve is the old radius + 1. The background fill and
  the border cover the reserved band.
- **Draw order**: every series' cast, then every timeout marker, then every
  series' core. Markers span the canvas edge rather than the zero line precisely
  because the reserve moved the zero line inward.
- The prefill is the same walk with a different paint; the glow follows the
  segment's kind, so a prefill segment glows in the prefill colour without a
  special case.
- Known cosmetic edge: at the minimum radius or a near-vertical segment, the
  outer bands can show a faint sub-pixel halo at the sides; it is 5–20 % alpha.

## Config keys / UI

| Key | Default | Range / clamp | Control |
|---|---|---|---|
| `lineGlow` | new: on; absent key: off | on/off | Colors → Line glow |
| `lineGlowIntensity` | 10 | 0–100 | Glow intensity slider (%); scales the reach too |
| `lineGlowRadiusPx` | 30 | 2–50 | Glow radius slider; the reach at 100% |

## Tests that pin it

`the_underglow_casts_toward_the_zero_line_in_every_orientation`,
`the_underglow_uses_each_hosts_own_line_colour`,
`the_underglow_fades_with_depth_below_the_line`,
`another_hosts_glow_does_not_tint_an_earlier_hosts_line`,
`the_underglow_does_not_reach_above_the_line_at_a_spike`,
`a_timeout_marker_reaches_through_the_underglow_reserve`,
`the_underglow_reserves_room_on_the_short_side`,
`the_underglow_reserve_follows_the_intensity`,
`the_glow_and_cursor_share_the_room_below_the_zero_line`,
`line_glow_defaults_off_and_clamps_to_its_limits`.

## Related

- [rendering.md](rendering.md) — draw order, reserves and the layered window.
- [sample-cursor.md](sample-cursor.md) — the other per-overlay decoration.
- [smooth-rendering.md](smooth-rendering.md) — the reveal cut the glow follows.
