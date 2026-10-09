# The game module

A design document for work that has **not been started**. Nothing described
here exists in the code. It is here so the thinking survives a session
boundary, not to describe current behaviour — for that, read `docs/SPEC.md`.

## Status

**Unbuilt.** The app currently ships as three processes
(`plo-tray.exe`, `plo-config.exe`, `plo-renderer.exe`) with no game
module. This is the last stage of the split that produced them: the point
of moving the renderer into its own process with no graphics stack is that
something can be drawn there that is not a latency graph.

Decisions below are marked **Settled** or **Open**. The Settled ones were
argued through and are not to be reopened without new information.

## What it is

The user's own description, unedited:

> it shares the same overlay/viewport as the graph — either reuses
> existing lines — or modifying them a bit or change them completely — it
> is up to the game itself (maybe a simple scriptable game engine for it).
> the graphs/latency samples data will become objects of a game
> (depending on how the game wanted to use them). for instances, the
> lines become terrains (changed colors, remapped with images etc). npc
> birds flying trying to pick up worms on the terrain, if they come in
> too hard they would collide with ground/hill or when they try to fly up
> a valley they could hit the hill etc. or getting burn to death from the
> 'laser' (timeout lines). birds may fly in different velocity/speed/
> pattern etc. the game keep scores on how many death and how many worms
> eaten etc... (just a rough idea). so no sound. no input, just
> programmed npc(s) reacting to the ping latency based game objects.

The essential shape: the latency graph becomes a terrain, birds fly over
it collecting worms, timeout samples are a hazard, and a score counts
deaths and catches. **No sound. No user input.** Everything is driven by
programmed NPC behaviour reacting to the ping data.

## Where it runs

**Settled — inside the renderer process, not as a fourth one.**

The game shares the same layered window as the graph. Two processes cannot
both own the pixels of one `WS_EX_LAYERED` window: it would need a
duplicated section handle, a per-frame barrier, and a z-order agreed
through shared memory — a display list in shared memory so one address
space does not need a `match` against the other. The frame rates do not
line up either: the graph arrives at 1Hz, the game animates continuously.

So the game is a module inside `crates/core`'s renderer binary, with access
to the same `SampleStore` the graph reads and the same `OverlayManager`
the graph draws through.

## The three decisions that matter more than the process layout

### 1. One `Terrain` value, two consumers — **Settled**

Build the terrain **as a value** (a polyline plus a per-x height lookup) and
have both the renderer and the birds read *that*.

Never sample the latency data twice, once to draw and once to collide. A
bird will land on a hill that is not drawn there, and it is a miserable bug
to chase — it looks like bad physics, when it is two functions disagreeing
about what the ground is. Worms need a spawn point on the surface, which
must be a terrain query, not a second read of the buffer.

### 2. Fixed-timestep simulation, decoupled from the render tick — **Settled**

Birds have velocities. If the simulation advances by wall-clock frame time,
then a bird that dies in a 12 ms hitch behaves differently on a slow
machine, and every balance decision becomes machine-dependent — the same
"skill" plays differently depending on whether the disk was busy.

Fixed step (60 Hz) with an accumulator. The render tick draws whatever the
simulation currently says, and may draw the same state more than once or
skip one. This also means the sim and the repaint rate are genuinely
independent, which is what the next section needs.

### 3. Timeout must be a first-class sample field — **Settled**

A timeout is a different *kind* of sample, not a large number. Today the
renderer draws one as a full-height line that breaks the latency line, and
the game's "laser" depends on it. If the contract handed the game only
latencies, the laser would never work — or would fire on every slow
response, which is worse than not existing.

## Rendering

**Settled — `tiny-skia`, the same code path the graph already uses.**

Proven, dependency-free, and already the renderer's only drawing code. The
graph's renderer is not being touched.

**Settled — no egui in the renderer or the game, ever.** A GPU context and
an event loop inside a click-through layered window is what the old
multi-viewport rewrite already paid for. That lesson is expensive and
already learned.

**Open — whether the game can later become a `wgpu` renderer.** The process
boundary is the future-proofing: an upgrade can happen *inside* the
renderer without the game or the graph learning about it. The measurement
below says it is not needed for performance. Treat it as a maybe, not a
plan.

**Open — "remapped with images".** The user's description mentions the
terrain being textured. That is the one requirement that might exceed what
`render.rs` does today. `tiny-skia` has image and pattern support, so this
is very likely fine, but it has not been checked against our actual
renderer. If it turns out it cannot, the answer is still not egui.

**Settled — the game is pluggable, not hard-wired over the graph.** A game
may render nothing but birds, with no terrain at all. Anything the game
needs from the app arrives through a trait, not by reaching into the
graph's internals.

## What has been measured, and what has not

**Measured — the repaint machinery is not the bottleneck.**

Smooth rendering has been in the app since it was implemented, running at
100 fps with the CPU at 1% at worst and 0.1–0.5% typically. Task Manager's
CPU column is a percentage of *total* system CPU, so the per-frame cost
depends on core count — roughly 0.02 ms to 1.6 ms per frame across the
plausible range. The 1% spike is almost certainly the 1 Hz probe landing
and forcing a redraw with a new sample, not the rendering.

This was the one cost that could have forced a GPU renderer, and it does
not. `tiny-skia` is comfortably fast enough.

**Not measured — the per-pixel fill cost.**

The measurement above covers a scene containing a single polyline. A game
fills the window: terrain as a filled region, dozens of birds, worms,
particles, a score. Almost none of that is per-pixel work today, so the
number says nothing about it.

**This is the first thing to measure before writing any game code.** The
specific question is whether cost scales with *what is drawn* or with *how
big the window is*:

- If it scales with window area, then `UpdateLayeredWindow` is dominated by
  memory traffic (width × height × 4 bytes per frame) and barely by drawing
  at all. The design constraint is then **keep the overlay small**, and
  terrain and birds are close to free.
- If it scales with draw calls, the game has to be built like a software
  renderer: batch, minimise overdraw, and treat the sprite count as a
  budget.

The answers point opposite ways, so this is worth one targeted experiment
rather than a guess. A full-window background fill at every frame, with
per-pass timing aggregated once a second (min, median and max — a median
hides exactly the hitch that would make the game feel bad), is enough. Do
not log per frame; the logging would itself be a measurable cost and would
flatter the result.

## Scripting — **Deferred on purpose**

A script host was considered as a possible extra process, to isolate
untrusted game logic. It is deferred, and the reason is worth recording:
deciding an IPC protocol for a scripting language before writing one game
is how you end up with a protocol that cannot carry what you needed.

Write the first game in Rust behind a trait. Put a script host behind
that trait later, once the interface is known from a real implementation
rather than from a guess.

## Open questions to ask before starting

1. **Does fill cost scale with area or with draw calls?** (above — measure
   it)
2. **Can the game's terrain be textured in `tiny-skia` within this
   renderer?** If not, what is the smallest honest change that allows it
   without reintroducing a GPU context?
3. **Does the game need to run when the Config window is closed?** It almost
   certainly does — that is the point of the split — but the overlay's own
   size and position are per-overlay settings, and a game may want the
   window to be bigger than a graph is.

## Related work already done

The split that makes this possible is complete. In short:

- The renderer is its own process with **no eframe, no glow, no winit, no
  tray-icon** — enforced by a test that runs `cargo tree` and fails if any
  appear.
- The tray is a second process with no eframe, and is the only one that
  stays resident. The Config window starts on demand and exits when closed.
- The three communicate over a named pipe carrying one JSON object per
  line.
- `AGENTS.md`'s `## Processes and the pipe` section records the rules any
  new process must follow, including the message-pump rule that a thread
  owning a window must service its messages.

Read that section before adding a fourth process. There are good reasons
there are only three.
