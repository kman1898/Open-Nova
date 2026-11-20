# Open Nova — alpha test

Thank you for testing Open Nova, an open-source alternative to NovaLCT, VMP and Unico for NovaStar LED processors.
This is an early alpha: it will have bugs. When something goes wrong, one report from you tells us what we need to fix it.

## Known limits in this alpha
- **Tried on real processors so far:** the H2, H5 and H9 (finding and reading them), and a VX4S-N over USB (Send, Save,
  Detect and test patterns, from alpha.4). MCTRL, other VX models, NovaPro, Unico and MX / CX processors have only been
  run against simulators so far. If something looks wrong, a report is the most useful thing you can send.
- **USB (NovaPro HD, a VX's USB-B port) works on a real VX4S-N; the first test on a real NovaPro HD is still to come.** Windows:
  install NovaLCT once (it brings the USB driver). Open Nova and NovaLCT can both use the controller. To record what
  NovaLCT does, Open Nova asks once to **Install USB capture** (then restart the computer) and once per start to
  **Allow USB recording**.
- **USB on a Mac needs macOS 14 (Sonoma) or newer.** Network processors work on older versions. Linux needs libusb and
  a udev rule (`RUNNING.md`).
- **Windows 10 or 11, 64-bit.** Windows 7 and 8 can't run it. When Windows asks about Python and the network, tick
  **both Private and Public**, then Allow.
- **Recording NovaStar's own apps:** while NovaLCT, VMP or Unico is open, Open Nova records what it says to the processors.
  It only listens (Windows' own packet recorder; Windows 10 version 2004 or newer) and never gets in the way. Windows asks
  once per start: **Allow recording**. Not tried yet with a real NovaLCT and processor. The Mac way (it asks for your
  password once) is untested. USB recording works on Windows only. The relay under Advanced is an experimental expert
  option. Recordings and Wireshark captures go into the report as they are (they may hold a login the NovaStar app sent).
  NovaStar apps' logs go in only when you tick them.
- **A controller on a COM port:** close NovaLCT first. It holds the port, and Open Nova tells you which one.
- **Writing is off until you type the unlock code** (Settings ▸ Alpha ▸ Allow sending). Greyed buttons are locked, not
  broken. The unlock is per browser.
- **Unzip to a normal folder on this computer,** not OneDrive or a network share. Your projects live in the Open Nova
  folder (`app/data`): when you update, copy that folder across.
- **Browser:** current Chrome, Edge or Firefox, or Safari 16.4 or newer.

## 1. Python 3 (once)
Open Nova needs Python 3.9 or newer and nothing else.
- **Windows:** nothing to do. The Windows package (`…-windows.zip`) carries its own Python and sets it up in the Open Nova
  folder on the first start (no internet needed; nothing is installed on Windows). The any-system package fetches it
  from python.org instead (about 12 MB, needs internet that once). If Windows says "Windows
  protected your PC", click **More info ▸ Run anyway**. When Windows Firewall asks about Python, tick **both Private
  and Public** networks and click **Allow** — a show network without internet counts as Public, and otherwise no
  processor is found. Clicked Cancel? Control Panel ▸ Windows Defender Firewall ▸ Allow an app ▸ tick Python for both.
- **macOS:** nothing to do either. Without a usable Python the first start fetches one into the Open Nova folder (about
  27 MB, needs internet that once; no installer, no password). When macOS asks whether Python (or Terminal: macOS 15
  may name it instead) may find devices on your local network and accept incoming connections, allow both.
- **Linux:** the same (about 35 MB) when the computer's own `python3` is missing or older than 3.9.

## 2. Start it
Unzip this folder anywhere (Documents is fine), then double-click:

| System | Start |
|---|---|
| Windows | `Start Open Nova.bat` |
| macOS | `Start Open Nova.command` (first time: see below) |
| Linux | `start-open-nova.sh` (once: `chmod +x start-open-nova.sh`) |

**Mac, the first time:** macOS blocks a downloaded script that isn't signed. Allow it once:
- **macOS 14 or older:** right-click `Start Open Nova.command` ▸ **Open** ▸ **Open**.
- **macOS 15 or newer** (right-click ▸ Open no longer does it): double-click it and click **Done** when macOS says it
  can't verify it. Then **System Settings ▸ Privacy & Security**, scroll down to *"Start Open Nova.command" was blocked*,
  click **Open Anyway**, and confirm with your password or Touch ID.

The app opens in your browser at http://localhost:8765/. **Leave the black window open** while you work; closing it
stops Open Nova. When macOS asks whether Python or Terminal may find devices on your local network and accept incoming
connections, allow both — otherwise no processor is found. More in `RUNNING.md`.

**A controller on USB** (VX1000's USB-B port, NovaPro HD): on Windows **install NovaLCT once** — it installs the USB
driver Open Nova uses. On a Mac nothing is needed with the Mac package. On Linux see `RUNNING.md`.
If Find says it can't use the USB device, it says what to do; if that doesn't help, send a problem report.

**Open Nova and NovaLCT together (Windows):** you don't choose anything. Plug the controller in and use Open Nova,
NovaLCT, or both, in any order. One line under the processor cards (also in Add processor and Tools ▸ Vendor Apps) says
what is happening, e.g. *NovaLCT connected through Open Nova · recording* or *NovaLCT has the NovaPro HD · recording*.
Open Nova never blocks NovaLCT: if NovaLCT wants the controller for itself, Open Nova lets go until NovaLCT closes and
records what NovaLCT does instead. For that it may ask you two things, each once: **Install USB capture** (USBPcap, a
free USB recorder; Windows asks for permission, then restart the computer) and **Allow USB recording** (Windows asks for
permission: click Yes). If you answer No, Open Nova doesn't ask again until you start it again.

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
If the black window says the hardware helper didn't start or stopped, the app stays open: Report a problem still works
and says what is missing.

## 6. Help us learn from NovaLCT, VMP and Unico
**Just use them.** While NovaLCT, VMP or Unico is open, a line under the processor cards says so, e.g. *NovaLCT is open ·
not recorded yet* with **Allow recording**. Click it once and answer **Yes** to Windows (it names Python: Open Nova's
recorder). From then on, until you close Open Nova, everything those apps say to your processors is recorded: build your
whole show in NovaLCT as usual. Open Nova only listens (Windows' own packet recorder, the way Wireshark does): there is no
second processor in NovaLCT's list and nothing in the way, and if recording fails NovaLCT doesn't notice. When the app
closes the line says *NovaLCT recording saved*; it is in `diagnostics/<day>/vendor/captures` and goes into the next problem
report (a long session is bigger than the report's e-mail limit: then send the `diagnostics` folder, zipped). On a Mac
macOS asks for your password once instead (untested yet).

**Tools ▸ Vendor Apps…** has more (details: `VENDOR_CAPTURE.md`):
- **On this computer** lists which of NovaLCT, VMP and Unico are installed and running, with versions (read-only). It goes
  into every report.
- **Their logs:** tick **NovaStar apps' logs** in Report a problem (off unless you tick it): the last 3 days, at most 40 MB,
  passwords and keys hidden.
- **Wireshark capture:** pick the app (or *One processor* and its IP), copy the filter, follow the steps, then
  **Add capture…** with the saved file. The next report carries it. The capture file itself goes in unchanged, so it may hold
  a login the NovaStar app sent — check before you share it if that matters to you.
- **Relay (expert option, experimental, under Advanced):** you don't need it to record NovaLCT, VMP or Unico (above). Open Nova stands in for the processor and records what the NovaStar app sends and gets back,
  passing every byte on unchanged. Start it with the processor's IP, then pick the entry at the relay address
  (127.0.0.42) in the NovaStar app. Whatever the NovaStar app sends still reaches the processor (the read-only lock is
  Open Nova's only). If the app also lists the real processor, or misbehaves, stop the relay and use a Wireshark capture.
  A controller on **USB only** (e.g. NovaPro HD) needs none of this: Open Nova handles it by itself (section 2). The
  relay and USB capture controls are under **Advanced**, for doing it by hand.

## Versions
Help ▸ About shows the version and build (also in the window title and at the top of every report).
