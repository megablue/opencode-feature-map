# Session handoff — PingLatencyOverlay

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `7f391b2` — 2026-10-07 (timeout indicator in the working tree,
awaiting the visual check).

## State

- The tip is pushed (`7f391b2`: the UI label/unit pass, bundled as 0.2.59)
  and the tree holds one uncommitted change: the per-overlay timeout
  indicator (Stick / Stub / Gap), plus a fix to the flaky
  `prefill_history_and_real_samples_render_together`. Awaiting the user's
  visual check before commit. Read `git log -1` for the tip and
  `git rev-list --count HEAD` for the commit count the version derives
  from — do not trust a number written here.
- Tests: 301 across the workspace. Last bundle:
  `PingLatencyOverlay_0.2.59_x64-setup.exe` (commit `7f391b2`); the next
  release build takes its version from the commit count.
- The features-map migration is complete: 13 pages under `docs/features/` with
  the README index, and `AGENTS.md` is process plus hard rules only.

## Open threads

- **Timeout indicator, uncommitted.** Per overlay (`timeoutIndicator`:
  `stick` the default / `stub` / `gap`), chosen on the Graph pane. `stick` is
  the old full-height bar; `stub` is a two-pixel mark resting on the canvas
  bottom (`TIMEOUT_STUB_HEIGHT`); `gap` draws nothing and lets the break in
  the line be the mark. Release build pending for the visual check; captures
  with a refused TCP target are in
  `%LOCALAPPDATA%\Temp\opencode\plo-capture-timeout-stub\` and
  `...\plo-capture-timeout-gap\`. Commit after the user confirms, then
  bundle (0.2.60).
- **Flaky prefill test fixed in the same change.**
  `prefill_history_and_real_samples_render_together` asserted a green count
  over pixels that were really the cursor rim's antialiasing; the real line
  was never drawn because its samples sat inside smooth rendering's
  three-second reveal hold. Explicit older samples now pin it; 60/60
  repeats pass.
- **UI label/unit pass, shipped in `7f391b2`.** Known wart left open: a
  DragValue suffix is static, so a value of 1 reads "1 seconds" (most visible
  on Border fade out); pluralising the second fields is an easy follow-up.
- The smooth-rendering investigation (the newest segment appearing to
  skip instead of scrolling with the rest of the line) is closed: the line
  path had no regression, and the reveal hold plus the shifted time mapping
  replaced the pop with a tip that walks its segment.

## Known gaps (volatile; the durable traps live in the feature pages)

- **Multi-monitor is verified by synthetic monitor lists only** — one monitor
  on this machine, so the positioning has never been seen by eye.
- **Sticky mode's rarer paths were exercised by scripted repros**, not by eye:
  the FollowWindow z-order option, multi-window targets (focused match first,
  else topmost) and DPI changes while following. The main path was confirmed
  on real apps.
- **A theme file edited on disk is re-read only at the next launch.**
- **A release build logs nothing unless `PLO_LOG` is set** — say so when
  asking for a log.
- The About page's copyright line has not been eyeballed since 0.2.22.

## Local-only state (not on GitHub)

- `archive/egui-rewrite-*-2026-09-24` — local tags holding the abandoned work
  of that day; push them with `git push origin "refs/tags/archive/*"` if they
  must outlive this clone.
- **Every SHA before 2026-09-29 is dead** — the history was force-rewritten to
  drop an unwanted trailer; `git log` is the only truth.
- Session scratch lives under `%LOCALAPPDATA%\Temp\opencode\` — the commit
  message file, capture sandboxes and repro scripts. Ephemeral by design.

## If testing themes on Windows

`HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme`
(1 = light, 0 = dark) is what the app follows; **restore it to 0 when done.**
