# PingLatencyOverlay — Spec

## Startup
- Launches into the system tray with no window shown. The tray is the program
  the user runs; the Config window and the renderer are started on demand.
- Tray menu: Config, Pause/Resume, Close tray, keep overlays running, Exit.
  The two exit items are deliberately different: closing the tray leaves the
  overlays running, and Exit stops the whole app. Pause and Resume read
  "Pause (no renderer)" and "Resume (no renderer)" while no renderer is
  attached, so the item always says what it will do.
- **Left-click** on the tray icon brings the Config window up, or focuses it if
  it is already open. The menu is on **right-click**.
- The app runs as three processes. The tray holds the tray icon and supervises.
  The Config window is started when it is asked for and **exits when it is
  closed**, so its window and graphics context exist only while you are looking
  at them. The renderer draws the overlay windows and runs the probes, with no
  graphics stack of any kind.
- What you launch brings the rest up with it, so any one of them gets you a
  working app. Launching the tray starts a missing renderer but does **not**
  open the window — the window opens when you ask for it from the tray's menu.
  Launching the window starts a missing tray and renderer. The renderer never
  starts anything, because it is the thing being started.
- Closing the Config window leaves the tray running. That is intended: the tray
  is the app, and a window should not take it down with it. To stop everything,
  use the tray's **Exit**.
- If something goes wrong, a log is written beside your config when one is
  asked for — a development build writes it always, a released build only when
  the `PLO_LOG` environment variable is set — and a failure that stops the tray
  from starting at all also puts up a message box, because the tray is the one
  part of this app with no window of its own.
- Starting the app starts the renderer. If one is already running — because you
  closed the tray, or launched the Config window directly — the caller attaches
  to it instead of starting a second.
- Each of the three runs at most once, enforced with its own named mutex. A
  second launch of the same one does nothing; it is not an error. Opening the
  Config window when it is already open focuses it rather than starting a rival.
- Closing the Config window asks first if there are unsaved changes, offering
  Save, Discard, or Cancel. It only closes if the answer succeeded: a save that
  could not be written leaves the window open and says why, because closing on a
  save that did not happen loses work silently.
- If the renderer exits on its own, the tray restarts it, up to five times in a
  minute. After that it stops trying and says so, because a crash loop is worse
  than a stopped app: it burns a core and buries the one message that would
  explain it. A renderer running with no tray is not restarted at all.

## Interfaces
- Config window: create and manage overlays.
- Overlay windows: one OS window per configured overlay.
- Tray, Config window and renderer talk over a named pipe. The first two send
  configuration, pause and resume, which overlay's preview border is showing,
  and shutdown; the renderer needs to say nothing back. If the renderer cannot
  be reached the sender says so rather than failing quietly, including the case
  where a profile was written to disk but the overlays were not updated.
- The renderer is found next to the caller's own executable, so all three
  programs must be installed into the same directory.

## Overlay window
- **Changes appear as you make them.** Editing a colour, a size, a position or a
  host updates the overlay immediately, without pressing Save. Save is what
  writes the profile file; it is not what applies your edits. Out-of-range values
  are clamped as you type, so what the overlay shows while you drag is what gets
  written.
- Frameless and transparent. Always on top by default; a Sticky Overlay can sit
  in front of the followed window only, and **Wallpaper Mode** puts it on the
  desktop instead — both described under *Display Mode* below.
- Click-through: mouse events pass to the window underneath as if it did not exist.
- Renders a live line graph of latency samples, one tick per ping.
- Plot start: the first point is the first responding latency, not y0.
- Timeouts (a ping exceeding the overlay's timeout counts as no response):
  - The line is not interpolated across a timeout.
  - Each timeout is marked in the timeout color (default red), drawn over the
    glows and under the lines. **Timeout indicator** chooses the mark: a
    **Stick** spanning the full height of the overlay box (the default), a
    **Stub** — a two-pixel mark at the bottom edge — or a **Gap** that draws
    nothing, so the break in the line is the mark.
  - On resumption, the next segment starts at the next responding sample's X,
    using the last responding Y, then continues with actual samples.
- A stretch with no samples at all is not drawn across either: a target whose
  profile was switched away — unless **background tracking** keeps it probed —
  or that **Pause** stopped, breaks the line and resumes at the last known value
  exactly the way a timeout does. With tracking off, coming back shows the
  history the profile collected before it was switched away with an honest hole
  in it; with tracking on there is no hole to draw.
- X axis:
  - User configures a time window (minimum 30 s) and an X-axis scale multiplier.
    The slider snaps from 1× through 10×; the numeric input also accepts larger
    values for wide graphs (default 2×).
  - The overlay window's long axis is sized `window(s) x scale` (e.g. 60 s at 2x
    = 120 px).
  - The graph fills the window's actual size, so the effective pixels-per-tick is
    `viewport / windowSeconds`. The window is sized in logical pixels, so under
    Windows DPI and text scaling that is not the same as `scale`.
  - Optional smooth rendering scrolls the timestamped graph between probe
    samples, drawn three sample intervals behind live, with the window shifted
    so the newest revealed instant sits at the leading edge: each incoming
    sample is revealed over its own interval, so the line's tip walks along the
    segment instead of the segment appearing whole at the leading edge. The
    line is drawn through one sample older than the visible window, so where it
    leaves the canvas the segment is clipped by the edge rather than the line
    stopping short of it. It is
    enabled by default at 60 FPS for new overlays and legacy configs without an
    explicit preference; the per-overlay smooth FPS controls the intermediate
    redraw rate, and gaps in the data are never interpolated.
- Startup behaviors:
  - `Cosmetic startup prefill` can show a deterministic fake latency graph
    before the first real probe result arrives.
  - The prefill uses its own line color (default `#64748b`) and reveals from
    left to right over the configured number of seconds (default 3).
  - The prefill remains as cosmetic history after the reveal; real samples are
    appended to the same rendered timeline and naturally scroll it left. The
    fake points retain the prefill color and are never added to the real sample
    buffer.
  - Prefill is enabled by default for new overlays and legacy configurations
    without an explicit preference.
  - The startup border effect defaults to RGB Loop when unspecified. RGB Noise
    assigns a new pseudorandom RGB color to every border pixel as it animates.
    The effect runs for 5 seconds by default, then fades for 1 second by default.
    Selecting an overlay in the list activates the RGB loop; losing the
    selection, leaving the Overlays page, or closing the Config window starts
    the fade and eventually disables the border. A border therefore animates
    only while you are actually looking at that overlay's settings. The
    selection animation can be turned off in the Global page under
    **Appearance**; that leaves the startup effect alone.
  - Border animation uses a dedicated 60 FPS redraw path and a 3 px inline
    border, independent of the graph Smooth Rendering setting.
- Y axis:
  - Height is configurable (`graphHeightPx`, default 60 px).
  - Ceiling is configurable (`maxYMs`, default 1000 ms); pings above it clamp to
    the top of the axis.
- Style:
  - Orientation rotates the whole graph anticlockwise: 90 => time plots
    bottom to top, 180 => right to left, 270 => top to bottom.
  - Mirror: on/off; combines with any orientation.
  - Line color: configurable.
  - Timeout color: configurable, default red.
  - Line width (`lineStrokePx`, 0.5–6 px, default 1.5): one stroke width for
    every host line, the startup prefill and the timeout markers. A thick line
    is not sliced by the overlay edge: the graph pads itself for it, so a line
    resting on the zero line or clamped at the ceiling keeps its full width.
  - Background color (`bgColor`, default `#0f172a`) and opacity (`bgOpacity`,
    0–100, default 0 = fully transparent), drawn behind the graph and not
    rotated with it.
  - Line glow (on by default for a new overlay, off for a profile written
    before the setting existed): every line casts a soft glow in its own colour,
    so each host of a group glows in the colour of its line. The cast falls
    toward the zero line in the graph's own frame, which means it rotates and
    mirrors with the overlay rather than staying screen-down. The cast never
    appears on the far side of a line — however sharp a spike, no glow wraps
    over its peak. Intensity (0–100, default 10) and radius (2–50 px, default
    30) are per overlay, and the startup prefill glows in the prefill colour.
    A lower intensity also pulls the cast closer to its line — the radius is
    how far it reaches at full intensity — and the overlay box reserves room
    past the zero line only for that reach, so the Y axis keeps the height
    `graphHeightPx` names, a line sitting on the zero line is not cut off, and
    turning the glow down gives the empty space back.
  - Sample cursor (on by default, including for a profile written before the
    setting existed; an explicit off turns it off): a white triangle with a dark
    rim marks each line's leading end. Its base sits flush against the leading
    edge and its apex points back along the line, so how far back it reaches is
    the cursor's size; the apex sits on the line itself, interpolated between
    samples — including a spike's flank or the jog where a line resumes after a
    timeout — and it eases to a new value instead of jumping. Through a timeout
    it holds the last value the line drew, because a timeout writes no point.
    It rotates and mirrors with the graph. Size is configurable
    (`sampleCursorSizePx`, 4–20 px, default 10). With the timeout blink on
    (`cursorTimeoutBlink`, off by default, absent key included), the cursor
    pulses in its own colour while a host's newest sample is a failure — dim
    to bright and back every two seconds, starting with the failed probe
    rather than waiting for smooth rendering's held frames, and returning to
    white as soon as a value arrives. The colour is per overlay
    (`cursorTimeoutBlinkColor`, default `#ef4444`). The overlay box reserves a
    constant gutter at the leading edge for the base and room at both ends of
    the Y axis, so the axis keeps its length and height and a cursor on the zero
    line or clamped at the ceiling stays whole.
- **Display Mode** is one of three exclusive placements, chosen in a **Display
  Mode** section under Position and defaulting to **Global Overlay**:
  - **Global Overlay** places the overlay on a display. Position is one of 9
    anchors within that monitor's **work area** (which excludes the taskbar /
    other appbars), so bottom and right overlays aren't hidden behind the
    taskbar. The **monitor** row in this branch chooses which display: "Primary
    monitor (follow automatically)" and one entry per other attached display,
    labelled with its resolution, its scaling and where it sits relative to the
    primary (`left of the primary`). The default follows the primary, so an
    overlay created before this existed behaves the same as it always did and
    moves with whichever display Windows treats as primary.
  - **Sticky Overlay** follows a window. The overlay keeps its size and anchor,
    but the window's **client area** is the placement rect instead of a
    monitor's work area, so all 9 anchors and the margins apply inside the
    window. It follows the window as it moves and resizes. The target is a
    process name (matched exactly), a title substring, and/or a window class
    (matched exactly); every non-empty box has to match, and empty boxes are
    ignored. When several windows match, the focused one wins, otherwise the
    topmost. The overlay **hides while the target is minimized, hidden, closed,
    or not matched at all**, and comes back with it. A **Pick window** crosshair
    fills the process and class boxes from a window the user points at and
    leaves the title box empty — a title is true only for the moment it was
    read, and most change with the document or the page, which would strand the
    overlay on a window right in front of the user; the click is swallowed, so
    it never reaches the window being picked.
  - **Wallpaper Mode** puts an overlay on the desktop instead of on top of
    everything: above the wallpaper and the desktop icons, and below every
    normal window, with the taskbar staying above it. It is never topmost; it
    keeps its ordinary window and is parked directly above the shell's desktop
    window, so the desktop icons show through wherever it does not draw. It
    stays visible when the desktop is shown (Win+D): a wallpaper overlay
    refuses to be minimized. The anchor, the margins and the monitor pin are
    unchanged, so the overlay keeps the same place on the same display. Because
    it is behind normal windows it is not visible over a fullscreen or
    borderless app.
- A Sticky Overlay is **always above other windows** by default, or can be
  **in front of the followed window** instead: it then shares that window's
  place in the z-order, so switching to another app takes it off the screen with
  the window it belongs to. That choice is under Display Mode, and only Sticky
  uses it.
- **An overlay pinned to a display that is not attached is hidden, not moved.**
  The pin is kept, the overlay comes back where it was when that display
  returns, and the entry stays in the list marked "not connected" so a graph
  that is off screen has a visible reason to be.
- A display's scaling is read **from that display**, so the same overlay is
  sized and margined in physical pixels for the panel it is on. Overlays on
  differently-scaled monitors do not match in physical size, and that is
  correct: matching in physical size is what a wrong number looks like. A
  sticky overlay takes the scaling of the display its target window is on.
- The anchor, the margins and the placement rect are the whole position: a
  monitor's work area in Global Overlay mode, the target window's client area in
  Sticky Overlay mode. An overlay on a secondary display is positioned against
  that display's work area, including when its coordinates in the Windows
  desktop are negative (a display left of or above the primary).
- Existing profiles that turned on `wallpaperMode` open in Wallpaper Mode; the
  key is read once and never written again, and the file it came from is
  rewritten with `displayMode` on the next save.
- Position offsets are signed screen-axis values in logical pixels:
  `horizontalMarginPx` and `verticalMarginPx`, both defaulting to 0. Edge-facing
  axes measure inward from the work-area edge; centered axes measure from the
  center. Positive values move right/down (or inward from an edge), and negative
  values move left/up (or outward from an edge). Negative values may move an
  overlay outside the work area.
- Existing `marginPx` configurations are migrated relative to each overlay's
  current anchor so their screen position is preserved.

## Groups of hosts
- **An overlay can graph several hosts at once.** There is no separate kind of
  overlay: one overlay with one host is exactly what every configuration written
  before grouping existed, so there is one code path rather than a single-host one
  and a grouped one that could drift apart.
- **The hosts share one plot.** One window, one X axis, one Y ceiling, one
  position, one background, one border. A group spanning 5 ms to 300 ms looks
  lopsided, and that is the honest picture: comparing the hosts is the point.
- What belongs to the **group** is the appearance of the window and the plot —
  orientation, mirror, time window, scale, smoothing, the startup prefill and
  border, graph height, latency ceiling, position, offsets, monitor, background
  colour and opacity, line width, line glow, sample cursor.
- What belongs to a **host** is the probe itself and the two colours that
  identify its line: protocol, target, port, timeout, line colour and timeout
  colour. A host can also be switched off without being deleted.
- **A host added next to an existing one is given a different line colour**
  automatically, stepping through a small set of distinguishable hues. Two lines
  in the same colour are one line as far as the reader is concerned, so the one
  thing copying cannot usefully do is copy the colour. The set is a cycle, so a
  group larger than it has two hosts sharing a colour — never two neighbours,
  because each step is relative to the host added before it.
- **A timeout is marked on the graph in that host's own timeout colour**, and
  the overlay's **Timeout indicator** says how: the full-height **Stick** (the
  default) spans the whole overlay box, through the underglow's reserved band
  when a glow is on; the **Stub** is a two-pixel mark resting on the bottom
  edge; the **Gap** draws nothing at all. Two hosts dropping in the same
  second draw their markers over each other and only the later one is
  visible, which is the same thing that happens to two lines crossing.
  Markers are not drawn for a host that has never answered, because a line
  along the bottom would read as "extremely fast" rather than "has said
  nothing".
- **A host's history is its own.** A host added to an existing group has none of
  the history the others have, and its line is placed by its own samples, not
  shifted by how much history it is missing.
- The **startup reveal draws one cosmetic curve per host**, seeded per host so
  two of them never draw the same fake latency.
- Probes are independent: each host is measured on its own cadence and its own
  timeout, so one unreachable host does not delay the others. The tick is one
  second per host.
- An overlay's **last host cannot be removed**, because an overlay with no hosts
  has nothing to draw and nothing to probe.

## Probe (per host)
- Protocol: ICMP echo or TCP connect.
- Target: domain name or IP address.
- Port: required for TCP, unused for ICMP.
- Timeout: configurable, default 1000 ms.
- A hostname is resolved when its probe starts and refreshed in the background
  afterwards, so a slow name lookup does not interrupt the one-second cadence.
  Both protocols then probe the cached address directly — ICMP pings it, TCP
  connects to it — so resolution is IPv4-only, as ICMP has always been.

## Config storage
- Settings live in profile files under
  `~/.config/.PingLatencyOverlay/profiles`, one file per profile, named
  `profile_<id>.json`. The id is a lowercase slug and is the only unique part
  of a profile.
- Every profile file carries its own name in the `profileName` key. It is
  free-form, keeps the case it was typed in, and does not have to be unique; it
  is what the window title, the sidebar button and the profile popup show.
  Files written before names existed get one derived from their id on the next
  launch.
- Creating or renaming a profile never overwrites another profile file. When
  the id derived from the new name is taken, the file is stored with the first
  free postfix instead: `profile_home_2.json`, `profile_home_3.json`, and so
  on. A profile renamed to a name that resolves to its own id keeps its file.
- The whole directory can be moved with the `PLO_CONFIG_DIR` environment
  variable: profiles, themes, `globalconfig.json`, `rules.json` and the log all
  follow it, and every executable honours it. An ordinary launch sets nothing;
  it exists so a capture or test session can run against a sandbox copy
  instead of the live settings.
- `~/.config/.PingLatencyOverlay/globalconfig.json` holds app-wide
  preferences. It is created as `{}` and stays empty until something needs to
  be stored. Preferences live under a single `ui` object, currently
  `ui.railCollapsed`, `ui.showVersionInTitle`, `ui.selectionBorderAnimation`,
  `ui.backgroundTracking` and `ui.theme`; writing preferences rewrites that
  object and nothing else, so the active profile pointer and any key a future
  version adds survive. A file that is missing, unparseable or holds unrelated
  keys simply yields the defaults. `ui.showVersionInTitle` is off by default,
  because the window title is already long and the About page is where the
  version belongs; `ui.selectionBorderAnimation` is on by default, because the
  border is what ties the selected row to the window on screen;
  `ui.backgroundTracking` is on by default, because a profile you switch away
  from should not come back with a hole in its graph (*Auto profile
  switching*).
- `~/.config/.PingLatencyOverlay/rules.json` holds the auto profile switching
  rules, app-wide like the preferences. It is a file of its own rather than a
  key in `globalconfig.json` because the tray re-reads it when it changes;
  see *Auto profile switching*. Its absence means switching is off, and
  nothing else in the app writes it.
- The active profile is recorded in that file as `activeProfile` (the id) plus
  `activeProfileFile` (the `profile_<id>.json` name), and both keys are removed
  when the active profile is `default`, so an absent key means `default`.
- On startup those two keys are the only source for what to load. The stored
  file name is used first, then the stored id, which keeps older files written
  before the file name existed working. A pointer that does not resolve, or
  points at a file that is gone or unreadable, falls back to `default` and the
  stale keys are cleared. No other profile is ever picked by scanning the
  directory, and a missing `default` on a first run is not a fallback: it is
  created empty.
- The active profile is loaded on startup to recreate overlays and their
  settings, and it is the target of **Save**.
- Profiles are created empty, and are listed, renamed, duplicated and deleted on
  the Profiles page. **Duplicate** copies the source profile's overlays into a
  new file and leaves the source untouched; the copy is not loaded, so switching
  to it stays a deliberate action. Rows that share a name also show their id, and
  the delete confirmation names the file it removes.
- Switching profiles is refused while there are unsaved edits. **Discard**
  reloads the active profile from disk and drops those edits.
- Deleting the active profile falls back to `default`, or to the first
  remaining profile when `default` is gone. The last remaining profile cannot
  be deleted.
- An existing `config.json` is validated and moved to
  `profiles/profile_default.json`, and only then removed. A file that fails
  validation is left in place and the problem is reported.
- If `config.json` is missing, a legacy `~/.PingLatencyOverlay/config.json` is
  migrated first. The legacy directory is removed only when `config.json` was
  its only entry; other files and subdirectories are preserved.
- The Config status bar reports whatever happened at startup: a migration, a
  migration that could not be done, a profile that was imported, profile names
  that were added to older files, and a stored active profile that no longer
  resolves.

## Auto profile switching
- The active profile can change on its own to match the windows that are
  open. The rules live in `<config dir>/rules.json`, are edited in the Global
  page under **Auto profile switching**, and are applied by the tray.
- A rule matches a **window**: every condition is asked about the same
  candidate window, and the rule matches when one window satisfies all of its
  conditions — or, with **any**, at least one of them. The candidate is either
  any visible window on the desktop (the default) or only the focused window.
- A condition looks at the window's **process name** (`cs2.exe`), its
  **title**, or its **Win32 class name** (`Chrome_WidgetWin_1`), and compares
  with **is exactly**, **contains** (both case-insensitive) or **matches
  regex** (as written; use `(?i)` for a case-insensitive pattern). A rule with
  an incomplete condition or an invalid pattern disables itself and says so
  in the editor; it never takes the rest of the file down with it.
- Rules are checked in order and the first match wins; the arrows in the
  editor change that order. When no rule matches, the **fallback profile**
  applies. With no rules, or only rules that cannot match, switching is off
  rather than "always the fallback".
- A rule naming a profile that was renamed away or deleted matches nothing
  and is shown as broken in the editor; no other profile is ever used in its
  place.
- A decision has to hold through two consecutive checks (about two seconds)
  before it is applied, so a launcher handing over to the game it started, or
  an alt-tab, does not cause a visible flip.
- The switch is a full profile load: overlays are replaced exactly as if the
  profile had been chosen in the window, the active profile recorded in
  `globalconfig.json` is updated, and profile files are never written.
- Coming back is the same as any other load: a profile's overlays show the
  history it collected before it was switched away. With **background
  tracking** on (the default) that history has no hole in it, because the
  targets kept being probed; with it off, the line is broken across the time it
  was not being probed rather than drawn through it.
- **Background tracking** (Global page, under **Auto profile switching**, on by
  default) keeps the targets of a profile you switch away from probed, so its
  graph is continuous when you return. A host you disable or delete keeps
  probing too, because the edit is unsaved: **Discard** brings it back with its
  history, and **Save** stops it for good — and only the removals the active
  profile's Save commits, so saving never touches the hosts another profile is
  keeping. Turning the setting off stops every kept probe and takes effect the
  moment it is clicked, like the Appearance settings; **Save** is what makes it
  survive a restart. **Pause** still stops all probing, and a restarted renderer
  starts with nothing kept.
- **While the Config window is open, that window applies the rules.** The tray's
  engine stands down for its whole lifetime; the window runs the same
  one-second, two-tick debounce itself, on every page, deciding from the saved
  rules. A settled switch waits while either the profile draft or the rules
  draft has unsaved edits — the status bar says so once — and lands as soon as
  everything is saved or discarded. Closing the window hands the rules back to
  the tray, which may reapply its own decision within a couple of seconds.
- The Global page shows what the rules as edited would decide right now.
- The rules are read when `rules.json` changes, so hand-editing the file
  takes effect without a restart. A file that cannot be parsed leaves the
  last good rules in force and is reported; the app never silently replaces
  it, and **Discard** puts the editor back to the last loaded rules.
- Auto switching runs in the tray. **Close tray, keep overlays running**
  leaves the overlays exactly as they are and stops switching until the app is
  launched again.

## Themes
The configuration window is themed. Its colours come from a file rather than
from the program, so a theme can be written, shared and edited without a build.

- A theme is one directory under `<config dir>/themes/`. It holds up to two
  files: **`core.json` is required** and is the light appearance;
  **`core-dark.json` is optional** and is the dark appearance of the same theme.
  A theme with only `core.json` is a light theme.
- The app ships a theme called **`default`**, in those two files. It is written
  to `<config dir>/themes/default/` on first run. A file there that cannot be
  read is replaced with the shipped copy; a file that *can* be read is left
  alone, so editing it works and your edits are not thrown away on the next
  launch.
- Any other directory under `themes/` is a user theme. It uses the same two-file
  layout. Choosing between themes is not in this release; the directory is
  already read this way so that it is not a breaking change later.
- A theme sets **colours only** — fifteen of them, covering the window
  background, the surfaces, the borders, the two text colours, the accent
  colours, the selection and scrollbar colours, and the two danger colours. It
  does not set fonts, sizes or spacing.
- Colours are written `#rrggbb`. A colour a theme leaves out is inherited from
  the app's built-in theme *for the light or dark file it is in*, so a theme
  that sets one colour and leaves out the rest still works.
- A theme may supply artwork for the position picker — `assets.positionPicker`
  takes a file name for each of its `default`, `hover` and `selected` states, and
  any state it leaves out uses the built-in picture. A file name that is
  anything other than a plain name in the theme's own directory is ignored, and
  the built-in picture is used.
- A theme that makes text hard to read is still applied, and the window says so
  in the status bar rather than refusing to load it. The two built-in themes are
  held to a readable contrast in the test suite.
- **What a theme does not cover.** The latency graph's colours — its line, its
  background, its timeout marker and its startup line — belong to each overlay
  and are set on the Overlays page, not by a theme. The tray menu is drawn by
  Windows from your system settings and is not themed. The tray icon and the
  About page's logo are the app's own artwork.

## Light and dark
- The window has a **light** and a **dark** theme, and follows Windows by
  default: flipping Windows between light and dark changes the window, including
  while it is open.
- You pick between **System Theme**, **Light Theme** and **Dark Theme** with
  three square buttons in the Global page, under Appearance. Each button is
  drawn with its own icon — a sun, a crescent moon and a half-filled circle —
  painted from the theme's colours rather than shipped as artwork. The System
  button's tooltip says which one it currently resolved to, so you can still see
  that it is following.
- Choosing one takes effect immediately, the way the other Appearance settings
  do, and **Discard** puts the previous one back. It still needs **Save** to
  survive a restart, like the rest of the Global page.
- The tray's menu follows Windows either way, so choosing Light or Dark is the
  only case where the window and the tray menu can look different.
- The default is System, so nothing changes for a user who has never set it.

## Config window layout
- The Config window has three panes and a status bar.
- The **navigation rail** is the leftmost pane: one row per page (**Overlays**,
  **Profiles**, **Global**, **About**) plus a chevron that collapses it to icons
  only. The rail is 148px labelled and 44px collapsed, and its glyphs are
  painted, so they never depend on font coverage.
- The **list pane** holds the current page's list, headed by the page's own
  controls. The Overlays page heads it with the profile switcher, which shows
  the active profile's display name and opens the profile menu. Its footer holds
  **Add overlay** and **Pause all**. The Profiles page lists every profile with
  its overlay count and an accent dot on the active one, and its footer holds
  **+ New profile**.
- The Overlays page opens with **nothing selected**, so pane 3 shows a short
  "No overlay selected" message and no border is animating until you choose an
  overlay. Two things clear the selection again: clicking the row you already
  have selected, and clicking the blank space in the list pane below the last
  row. The blank space is a hit target only, so a list short enough to fit never
  grows a scrollbar; a list long enough to scroll simply has no blank space and
  the row click carries on alone.
- Selection is a view concern only. Unsaved edits are held per overlay, so
  clearing the selection never discards anything, and **Save** and **Discard**
  keep their state.
- Overlay counts are read from each profile's file when the Profiles page is
  arrived at, and again after any action that changes one - creating, renaming,
  duplicating, deleting or switching a profile. A count that has not been read
  draws no number at all, because "not read yet" is not the same as "no
  overlays" and a zero would be a confident lie. A profile whose file cannot be
  read is counted the same way: no number, never a zero.
- A profile row in the list **selects** its profile; it never loads it. Loading is
  the separate **Switch to this profile** action in the detail pane, because
  switching is refused while there are unsaved edits and a list selection should
  not have that side effect.
- The **profile menu** under the switcher only switches, and ends with
  **Manage profiles**, which opens the Profiles page. Create, rename, duplicate
  and delete live on that page instead, where they have room for a real name
  field rather than an editor crammed into a menu.
- The **detail pane** holds the current page's detail: the editor for the
  selected overlay on the Overlays page, and the selected profile's name, file,
  overlay count and **Switch to this profile**, **Rename**, **Duplicate** and
  **Delete** on the Profiles page. Rename, Duplicate and Delete open their editor
  in place of that detail. The Global page has no list, so the detail pane spans
  the width the list pane would have used, and shows the app-wide preferences:
  an **Appearance** group that opens with the **System Theme**, **Light Theme**
  and **Dark Theme** buttons described under *Light and dark*, followed by a
  **Collapse the navigation rail** checkbox, and a
  **Storage** group listing the config folder, the profiles folder and
  `globalconfig.json` as read-only paths, truncated with the full path on hover.
  Toggling the rail applies immediately, so the user watches it collapse as they
  click, but the value is only written when the draft is saved and **Discard**
  puts the rail back. The Appearance group also holds **Show the version in the
  window title**, which appends the version in brackets to the title
  (`PingLatencyOverlay - Current Profile: Home (v0.1.68)`). Like the rail
  checkbox it previews immediately and is written only on Save. The group's
  remaining checkbox is **Animate the selected overlay's border**, the switch
  for the selection preview described under *Overlay window*: turning it off
  stops that animation for every selection, including the first overlay a
  profile switch selects, while the per-overlay startup border effect is
  untouched. It previews immediately and is written only on Save, like the rest.
  The page also carries the **Auto profile switching** section, and with it the
  **Keep tracking profiles in the background** checkbox described under *Auto
  profile switching*. Like the Appearance settings it previews immediately and
  is written only on Save.
  The About page
  has no list either, so its detail pane spans the same full width, and is
  read-only and centred: the app icon, then one column of lines — the app name
  large, the tagline under it, the version, then the repository, the copyright
  and the licence. Nothing on it can be edited, and it carries no Save/Discard
  footer because it stages nothing. No line on it is smaller than the rest of
  the window's body text. The repository line is the only clickable one: it
  opens the address in the user's default browser, and the full address is in the
  hover tooltip. The copyright
  carries no year, so it cannot go stale between releases. The licence is named
  in words and not linked, because the licence text is not bundled with the app.
- The **detail pane** ends in a sticky footer holding **Discard** and **Save**,
  right aligned with Save as the filled primary action, under a scrolling detail.
  Both are enabled while **either** draft has something to write - the profile
  or the app-wide preferences - which is also how unsaved edits are signalled. A
  Save that only has preferences to write leaves the profile file alone. Only a
  page that stages a draft carries it: the
  Overlays and Global pages do, the Profiles and About pages do not, because
  they act on files immediately or stage nothing at all. On the Profiles page
  the pending-draft hint in the detail names the Overlays page as the place to
  resolve it, and the rail's Overlays row carries a dot and an "unsaved changes"
  hover while one is open.
- The **status bar** spans the full width and holds the transient operation
  message. The version is not here; it is on the About page, and optionally in
  the window title.
- Both panes are a scrolling area above a fixed footer, so a pane's own actions
  sit next to the content they act on instead of a pane away in the status bar.
- A row in the list pane is its contents plus the same margin on every side, so
  the controls inside it never sit flush against the fill. A profile row reserves
  a gutter for its overlay count and active dot, so a long display name
  truncates rather than running underneath them. The gutter is two columns: the
  count, right aligned, and the active profile's dot in a fixed slot after it, so
  the numbers line up down the list and the dot never moves them. The name, the
  gap between widgets and the gutter all come out of the row's width.
- The profile switcher at the head of the list pane carries the same fills the
  control it replaced had: a resting fill, a hover fill, and the selection while
  its menu is open, with the profile name in the normal text colour. It has no
  outline of its own, like the rows.
- Rows in the list pane carry no border of their own. Like the rail's rows they
  are painted: the selected row gets the selection fill, a hovered row a
  muted fill, and an untouched row nothing at all. The rail is the reference,
  so a selection looks the same wherever it appears.
- The list pane's header, its rows and its footer are all one width, and that
  width is one column centred in the pane, so both of the pane's boundaries get
  the same margin. Nothing in the pane can be wider or narrower than its
  neighbour, and the rows do not shift sideways when a list outgrows the pane.
- The two pane boundaries are drawn the same way: a hairline centred in the gap
  between the panes, then the gap itself. The list pane is spaced identically on
  the rail side and the detail side.
- Switching pages is always allowed, because the Overlays draft stays in memory.
  Switching *profile* is refused while there are unsaved edits.
- The window is 860x660, resizable between 720x480 and 1400x8192, which keeps
  room for the rail, the list pane and a usable detail pane at the same time.
  `AGENTS.md` records the layout traps behind these proportions; every one of
  them first shipped as a visible misalignment.

## Installer and build
- Target architectures: x64 and ARM64.
- Installer: native NSIS (`-setup.exe`), one per architecture.
- The installer runs four pages: welcome, destination folder, install, and
  finish. There is no components page.
- The finish page carries two ticked checkboxes: **Launch PingLatencyOverlay**
  and **Create a desktop shortcut**. A silent install (`/S`) never shows the
  finish page, so it creates the desktop shortcut to match the default.
- The default install folder is `%LOCALAPPDATA%\Programs\PingLatencyOverlay`,
  per user, with no elevation prompt.
- The application ships three executables and does not require WebView2:
  `plo-tray.exe` (the tray), `plo-config.exe` (the Config window) and
  `plo-renderer.exe` (the overlay windows and the probes). They are installed
  into the same directory, because each finds the others next to itself. Only
  the tray gets a Start Menu or desktop shortcut, since only the tray is what a
  user launches, and the installer's "Launch" checkbox launches the tray too.
- All three executables carry the app icon, the product version and the
  copyright notice in their Windows resource, so the Start Menu shortcut (which
  points at the tray) shows the app icon rather than the generic one, and the
  version and copyright Explorer reports agree with what the Config window
  shows.
- The installer stops any running copy of the app before writing the new files,
  including the names used before the three executables were renamed, and
  removes the previous installation first. An upgrade over a running app
  therefore replaces the binaries instead of quietly leaving the old copy. It
  never touches your settings.
- The GPLv3 text ships as `LICENSE` in the install directory beside the
  executables. It is installed unconditionally, not as an option, and the
  uninstaller removes it.
- The build version is `MAJOR.MINOR.(commits since countBase)` — the count
  since a base recorded in `src-tauri/Cargo.toml`, not the raw commit count, so
  each new minor restarts at `.1`. It is the version the Config window reports
  and the version the installer is named after, and both are derived from that
  one recorded base, so they cannot disagree.
