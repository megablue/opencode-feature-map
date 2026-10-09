# Probes — one Tokio task per host, measuring by cached address

Status: shipped (v0.2.35) · Read when: changing `probe.rs` / `probes.rs`, the
resolver cache, the sample cadence or the buffers.

## What it does
- Every enabled host runs its own Tokio probe task: one measurement per
  second, written into a bounded per-target buffer whether it answered or not.
- ICMP uses `ping-rs` (`IcmpSendEcho2`, no Administrator); TCP times the
  connect handshake. Both take the host's `timeoutMs`.
- A hostname is resolved once when the task starts and refreshed in the
  background afterwards, so a slow lookup never sits between two samples;
  every tick probes the cached address directly.
- A failed attempt still writes a sample (`value: None`) — that sample is what
  the timeout marker and the line break are drawn from.

## Map
- `probe.rs` — `measure` (the one-shot form), `lookup_ipv4`, `ping_ipv4`,
  `connect_ipv4`, `resolve_ipv4`.
- `probes.rs` — `ProbeManager` (`apply_config`, `spawn`, `stop`, retirement),
  `probe_loop`, `measure_cached`, `AddressCache` (`rehost`, `take_refresh`),
  `address_action` / `AddressAction`, `TaskKey`, `SampleStore`,
  `MAX_BUFFERED_SAMPLES`.
- `render.rs` — `SAMPLE_INTERVAL` (the cadence both files read) and
  `sample_gap_threshold` (timeout + cadence + slack).
- Constants: `DNS_REFRESH_INTERVAL` (60 s), `DNS_REFRESH_AFTER_FAILURES` (3),
  `SLOW_LOOKUP` (500 ms).

## How & why
- **One task per (overlay id, target id), never one per overlay.** A probe
  measures for as long as its timeout allows, so a task probing four hosts in
  turn would take four timeouts per tick when they are all down.
- **Target ids are only unique within their overlay**, which is why the task
  key is the pair and why `validate` checks them per overlay.
- **A style-only save does not restart tasks.** `ProbeManager::apply_config`
  starts and stops tasks for added, removed and disabled targets only;
  existing tasks read the shared settings each tick, so changing a colour or a
  timeout does not pause the graph.
- **The address cache is what removed the silent gaps.** `probe::lookup_ipv4`
  can block for seconds on a cold DNS cache; before it was cached, the blocked
  loop wrote no sample at all — a break with no marker to explain it. Now the
  tick pings/connects the cached address and a detached task refreshes it on
  `DNS_REFRESH_INTERVAL` or after `DNS_REFRESH_AFTER_FAILURES` consecutive
  misses; the result arrives through an mpsc channel on the next tick. A host
  edit drops the address; a failed lookup keeps the address that worked and
  waits the normal clock.
- **Resolution never runs inside a connect.** `connect_ipv4` takes the address
  and the port and builds a `SocketAddr`, so nothing can resolve mid-connect.
  `lookup_ipv4` is IPv4-only by design, for both protocols.
- **Background tracking keeps a departure's task alive.** A removal rides the
  next `SetConfig` as the `retire` list, which only the Config window computes
  (the renderer cannot tell "switched away from" from "deleted"); kept targets
  keep measuring while their overlay does not exist, so switching back
  restores the history.
- A lookup slower than `SLOW_LOOKUP` logs `lookup for <host> took …`; in a
  release build that line exists only under `PLO_LOG` (see diagnostics.md).

## Config keys / UI
| Key | Default | Notes |
|---|---|---|
| `probe` | `icmp` | per host: `icmp` or `tcp` |
| `host` | — | name or literal; resolved once, then cached |
| `port` | — | TCP only |
| `timeoutMs` | 1000 | per host; the line breaks after timeout + cadence + slack |
| `ui.backgroundTracking` | on | global preference; see config/window.md |

## Tests that pin it
`every_enabled_target_gets_its_own_task`,
`style_only_config_update_keeps_existing_task`,
`disabling_one_target_stops_only_its_task`,
`the_same_target_id_in_two_overlays_is_two_tasks`,
`a_probe_reaches_the_nested_buffer`,
`a_departure_keeps_its_task_when_background_tracking_is_on`,
`a_saved_removal_retires_the_kept_target`,
`background_tracking_off_drops_what_was_kept`,
`a_returning_target_reuses_its_kept_task`,
`the_address_action_resolves_refreshes_or_reuses`,
`a_finished_lookup_lands_in_the_cache`,
`changing_the_host_drops_the_cached_address`,
`a_literal_ip_host_caches_its_address`,
`a_tcp_target_connects_to_its_cached_address`;
the gap side is pinned by `a_data_gap_is_not_interpolated_*` and
`a_one_second_cadence_is_not_a_gap` in `render.rs`.

## Related
[runtime.md](runtime.md), [config/storage.md](config/storage.md),
[overlays/rendering.md](overlays/rendering.md),
[overlays/smooth-rendering.md](overlays/smooth-rendering.md),
[diagnostics.md](diagnostics.md).
