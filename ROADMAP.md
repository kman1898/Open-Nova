# Open Nova roadmap

The short version, for people who use Open Nova. Nothing here has a date: work lands in a release when it is finished
and checked.

## What Open Nova is

Open Nova is an open-source app for NovaStar LED processors: map a wall, send it, set up redundancy, adjust colour and
monitor the wall's health. It covers the NovaLCT family (H series, VX, MCTRL), VX Pro processors that Unico controls and
the MX / CX controllers that VMP controls, from one app on Windows, macOS and Linux.

## Works today

Built and tested on stand-ins and simulators; the "Checked" column of the [README](README.md#what-works) says which
parts have also been run on real processors.

- Layout: screens, cabinets, wiring patterns and manual wiring, port capacity, quick add, align and distribute, complex
  screens, undo.
- Send, Dry run and Compare per processor; Save as its own button.
- Redundancy: port-to-port backup sets, Send backup, Verify.
- Screen settings: brightness, gamma and colour temperature, live, read back from the processor.
- Blackout, Freeze, Normal, test patterns, identify.
- Monitor: temperature, voltage, bit errors, power supplies, alarms that stay until cleared, a heat map.
- Presets and schedules on processors that keep them.
- Maintain: the cabinet table, receiving-card NCP files behind the file guard, a cabinet library.
- Files: NovaLCT `.scr` (standard and complex) and `.scfg`, Unico screen import, VMP project import.
- Several projects, online and offline (design without hardware).
- Diagnostics: a lossless local recording of every processor conversation, and Help ▸ Report a Problem.
- The alpha build: read-only until unlocked.

## Needs live hardware

These are built, but only checked against recordings and stand-ins. The alpha exists to close them, so reports from
these are the most useful ones.

- **Send to a real processor** from Open Nova across models: standard and complex screens, free topology on H-series
  cards that support it, a complex screen with free topology.
- **Redundancy Send** and Save on a real H series processor, and cross-card backup pairs.
- **One connection, many jobs:** detect, monitoring and a Send at the same time on a VX1000, an H series and an MCTRL;
  unplugging and replugging the cable; NovaLCT waiting while Open Nova holds the link.
- **Several screens on one NovaLCT-family processor:** sent together and read back into the same screens, in order.
- **Screens over several processors** in Unico (cross-device / Super Screens) and VMP (one screen over controllers of the
  same model and firmware): confirm live before enabling. Until then a screen belongs to one processor everywhere.
- **Colour read-back** on real H series and VX cards, and on a real VX Pro and MX controller.
- **Receiving-card NCP sends** on a real wall, compared with NovaLCT's; a send to some ports leaving the others alone.
- **Clearing error counters** on a real receiving card.
- **VX Pro (Unico) and MX / CX (COEX) processors** on real hardware at all: so far only simulators and stand-ins.
- **macOS and Linux on real networks** with real processors (the packages already start on all three in CI).

## Next

- **The new look:** the darker, denser interface shown in the README screenshots is being built into the app.
- **A leaner interface:** fewer buttons and less text, hints in tooltips.
- **Colour:** gamut on NovaLCT-family processors (it needs the panel's measured primaries), low latency on Unico, effects
  and sync source, once each has been seen working on hardware.
- **Interchange:** writing Unico screen files; EDID on NovaLCT-family processors.
- **Beta:** the repository goes public, with the live checks above done.

## Later, if asked for

- Inputs, layers and multi-view on the processors whose own apps have them.
- A control interface for show systems (HTTP, OSC, Art-Net or sACN).
- Talking to USB processors straight from the browser.

## Not planned

Uploading or editing calibration coefficients, firmware updates, and making or modifying receiving-card configuration
files are out of scope: a mistake there can damage a wall. Also left out for now: relays, changing a processor's IP
address, Take Over, dehumidification, Smart Settings, editing receiving-card parameters, resetting run time and the
authorisation lock.

## How releases work

- A release is tagged `v` + the version in `app/version.json`. `-alpha`, `-beta` and `-rc` releases are pre-releases.
- Every release runs the whole test suite first, and its zip is unpacked and started on Windows, macOS and Linux before
  it is published ([docs/TESTING.md](docs/TESTING.md)).
- Keep a copy of an important project before you move to a new alpha.

## Licence

Open Nova is licensed MIT OR Apache-2.0, at your option; see [LICENSE-MIT](LICENSE-MIT) and
[LICENSE-APACHE](LICENSE-APACHE). Versions already released stay available under those licences.

## How to follow along

- Issues: <https://github.com/kman1898/Open-Nova/issues>
- Releases: <https://github.com/kman1898/Open-Nova/releases>
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
