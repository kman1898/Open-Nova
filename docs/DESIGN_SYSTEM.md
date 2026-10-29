# Open Nova design system: the pro look in the real app

The user, 2026-10-28, after the "tiles are the tabs" header landed: "The tiles look exactly the same. We've got to make
these look better. We've gotta make the whole app look better." Before that: "It still looks super basic like not
polished at all look how sharp and clean tessera remote looks", and on the gallery mock-ups: "That has much more
polished … all this stuff looks great though from the gallery".

**The target is the gallery, not a new idea.** The approved mock-ups are `app/out/pro/{index,layout,screen,monitor,device,lut}.html`
with `app/out/pro/pro.css` (its header comment is the design system: principles, tokens, components) and the screenshots
`docs/screenshots/2026-10-28-pro/{layout-rounded,device,screen-settings,monitor-temperature,detail-*}.png`.
The real app must look like those, in every tab, with real data. Rounded corners are the default.

## Where the real app falls short (seen 2026-10-28, `real-*.png` and `header-pop-*.png` vs the gallery)

1. **Header tiles are empty boxes.** Each one has a tiny line icon and a caps word in a large flat box. The gallery tiles
   carry a **pictogram drawn from live data** plus a value and a lit bar:
   - a thumbnail of the wall;
   - the processor's rear panel with lit ports;
   - a gamma curve, a brightness sun, a colour-temperature gauge, the gamut triangle;
   - pattern bars, the pause glyph, the backup icon with a check.

   That is where the "pop" came from. Tiles that are tabs still get a pictogram that means the tab, drawn from the
   project:
   - Device: the active processor's rear panel, ports lit by use.
   - Layout: a mini wall in its port colours.
   - Correction: a cabinet grid coloured by calibration state.
   - Screen Settings: a gamma curve with the brightness value.
   - Backup: primary and backup arrows, with a check when verified.
   - Preset: the scene number.
   - Monitor: a mini heat map or a pulse line, red on an error.
   - Schedule: a clock or calendar with the next event.

   Use them sized as in the gallery, not as a tiny icon.
2. **Loud flat port colours** on the canvas (saturated red, green, purple, yellow fills). The gallery uses the `--p1..--p4`
   palette as translucent overlays and outlines over the picture or a dark cabinet grid, with port-number plates.
3. **Side-panel controls are uneven.** Buttons have different heights, labels wrap ("Apply edits live", "+ Add another
   VX2000 Pro"), there's a lone "×" button, and the grid misaligns. The gallery follows its own rules: a 4 px grid,
   24 px rows, right-aligned labels, controls on the right, one control height (22 px), segmented controls, and no wrapping.
4. **Dead space**, for example processor cards with large empty areas. Size content to what it holds; fill pages with
   useful structure, not padding.
5. **Typography**, as in the gallery:
   - Barlow Semi Condensed for the UI, small caps for group labels, JetBrains Mono for numbers and addresses.
   - Tabular numbers.
   - A clear hierarchy: panel title, then group label, then row label, then value.

## Rules for every agent on this pass

- **Area files.** Styling goes in the pro look's area files (index.html loads them after `looks/pro.css`, pro look only):
  - `looks/pro-tiles.css`: the header tiles and override/system tiles.
  - `looks/pro-panels.css`: the menu bar, side panels (tree, properties, forms, buttons, segmented controls, toggles,
    sections) and the status bar.
  - `looks/pro-canvas.css`: Layout, meaning the stage, cabinets, port overlays, wiring arrows, toolbar, rulers,
    navigator and port list.
  - `looks/pro-pages.css`: the module pages (Dashboard, Device/Processors, Correction, Screen Settings, Backup, Preset,
    Monitor, Schedule) and dialogs.

  `looks/pro.css` holds the tokens; only the panels agent edits it. Copy token values from `app/out/pro/pro.css`;
  never invent new colours.
- **Classic stays untouched** (View ▸ Look ▸ Classic). Markup changes must work in both looks.
- **Prove it.** Screenshot your area side by side with the matching gallery screenshot at 1440×900 (and 1920×1080, 1280×800)
  in dark and light. Keep going until a stranger couldn't tell which is the mock-up. Save the before and after in
  `docs/screenshots/2026-10-28-polish/<area>-{before,after}-<w>.png`.
- **Run on your own server and data folder**, never 8765/8766 or `app/data-home`:
  `python opennova.py --port <yours> --no-browser --data-dir <scratch>`.
  Use an offline project rich enough to look real: 2 processors (an H5 and a VX1000), 2 screens, 30+ cabinets on
  4 ports, backups, colour values.
- **Run the checks.** Run `python tools/run_tests.py`, `python tools/browser_tests.py` and the UI sweep
  (`app/tests/ui-lint.js` uiSweep at 375–1920 px, both themes, menus open). There must be no overlaps, no clipped or
  wrapped controls, and contrast ≥ 4.5:1 for text.
