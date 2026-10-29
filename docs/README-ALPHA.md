# Open Nova — alpha test

Thank you for testing Open Nova, an open-source alternative to NovaLCT, VMP and Unico for NovaStar LED processors.
This is an early alpha: it will have bugs. When something goes wrong, one report from you tells us what we need to fix it.

## 1. Install Python 3 (once)
Open Nova needs Python 3.9 or newer and nothing else.
- **Windows:** https://www.python.org/downloads/ — tick **"Add python.exe to PATH"** in the installer.
- **macOS:** https://www.python.org/downloads/ (the Python built into macOS may lack a part Open Nova needs; it tells you).
- **Linux:** usually there already (`python3 --version`).

## 2. Start it
Unzip this folder anywhere (Documents is fine), then double-click:

| System | Start |
|---|---|
| Windows | `Start Open Nova.bat` |
| macOS | `Start Open Nova.command` (first time: right-click ▸ Open ▸ Open) |
| Linux | `start-open-nova.sh` (once: `chmod +x start-open-nova.sh`) |

The app opens in your browser at http://localhost:8765/. **Leave the black window open** while you work; closing it
stops Open Nova. When macOS asks whether Python may find devices on your local network and accept incoming
connections, allow both — otherwise no processor is found. More in `RUNNING.md`.

## 3. Read-only until you unlock it
This alpha **does not write to your processors**: it finds them, reads them (model, cards, layout, backup, firmware) and
monitors them.

**Everything that changes a processor needs the unlock code** — Send, Save, Send backup, Blackout / Freeze / Normal,
test patterns, Identify, Mapping, colour settings (also while you drag a slider), resetting the error counters, service
actions, calibration and receiving-card files. These are greyed out (or say why they didn't go through). The Monitor's
**Clear** still clears Open Nova's own error list; the processor's counters are then left as they are.
To switch writing on: **Settings ▸ Alpha ▸ Allow sending…** and type the unlock code — ask the person who gave you this
build for it. It stays on in that browser until **Settings ▸ Alpha ▸ Lock again** (or a new version). The code is a
speed bump against sending by accident, not a password. Every unlock and lock is noted in the log (never the code).

## 4. What is recorded
Open Nova records the conversation between itself and your processors — every byte of every frame, web call, discovery
and USB packet, whole — in the `diagnostics` folder, plus its own logs. Each click in the app gets a number, and
everything it caused is recorded with that number, so we can see exactly what a button sent and what came back.
**Nothing is sent anywhere** unless you send us a report.
Passwords, tokens and logins (e.g. the H series web login) are never recorded. Old recordings are removed after
14 days (or when they pass 2 GB). If the disk fills up, Open Nova warns you and keeps what it records in memory until
there is room again.

When Open Nova meets a processor it doesn't know yet, it keeps a small snapshot of what the processor said
(`diagnostics/<date>/first-contact/`) so that one report is enough for us to add it.

## 5. Report a problem
**Help ▸ Report a Problem…** (or **Report** at the top right):
1. Write what you were doing and what went wrong.
2. Leave the boxes ticked (project, recordings, logs, processor info, system), or untick what you don't want to share.
   *Anonymise IP addresses* replaces your network addresses with device-A, device-B …
3. **Make report** saves one file, `OpenNova-report-<version>-<date>-<model>.zip`, in your Downloads folder
   (**Show in folder** opens it). It reads the processors (read-only) for their models and firmware first.
4. Send that file to the address shown in the dialog. Nothing is uploaded automatically.

The report starts with `REPORT.md`, a readable summary: you can open the zip and check what is in it before you send it.

## 6. Help us learn from NovaLCT, VMP and Unico
If you use NovaStar's own apps with a processor or feature Open Nova doesn't handle yet, **Tools ▸ Vendor Apps…** lets
you show us what they do (details: `VENDOR_CAPTURE.md`):
- **On this computer** lists which of NovaLCT, VMP and Unico are installed and running, with versions (read-only). It goes
  into every report.
- **Their logs:** tick **NovaStar apps' logs** in Report a problem (off unless you tick it): the last 3 days, at most 40 MB,
  passwords and keys hidden.
- **Wireshark capture:** pick the app (or *One processor* and its IP), copy the filter, follow the steps, then
  **Add capture…** with the saved file. The next report carries it. The capture file itself goes in unchanged, so it may hold
  a login the NovaStar app sent — check before you share it if that matters to you.
- **Relay (experimental):** Open Nova stands in for the processor and records what the NovaStar app sends and gets back,
  passing every byte on unchanged. Start it with the processor's IP, then pick the entry at the relay address
  (127.0.0.42) in the NovaStar app. Whatever the NovaStar app sends still reaches the processor (the read-only lock is
  Open Nova's only). If the app also lists the real processor, or misbehaves, stop the relay and use a Wireshark capture.

## Versions
Help ▸ About shows the version and build (also in the window title and at the top of every report).
