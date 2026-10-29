# Learning from NovaStar's own apps (Tools ▸ Vendor Apps)

User, 2026-10-28, for the early alpha going to many testers with different processors: *"what about a tool in it that will
detect LCT, VMP and Unico to diagnose what all they send and receive from there too"*.

Testers already use NovaLCT, VMP and Unico with processors we have never seen. **Tools ▸ Vendor Apps…** lets them hand us
what those apps do, in the same form as Open Nova's own recordings. Code: `tools/vendortap.py` (helper side,
`/api/hw/vendor/*`), `app/js/app-vendor.js` (the window), tests `tools/test_vendortap.py`.

Everything is written to the day's recording folder, **`diagnostics/<YYYY-MM-DD>/vendor/`**, which Help ▸ Report a problem
carries whole (`tools/alpha.py` `SESSION_DIRS`; each file up to 16 MB, bigger ones are named in the report instead):

| Folder | What |
|---|---|
| `vendor/captures/` | Wireshark / tcpdump files the tester added (kept as they are) + the same decoded as `.nwl` (12 MB parts) |
| `vendor/relay/` | relay sessions as `.nwl` (12 MB parts) |

The `.nwl` files are the recorder's own JSON-lines format (`tools/wirelog.py`). The window's **Recorded ▸ Open** opens one
in Tools ▸ Diagnostics (decoded frames, Wireshark export). WebSocket frames from the relay are the new record kind `ws`
(shown under *Web* in Diagnostics).

Nothing here sends anything of Open Nova's own to a processor except two reads, both recorded like every other call: the
relay's discovery ask (to learn the ports) and, for COEX, one `GET /api/v1/device/hw` (to learn the MAC for the announcement).

## 1. Detect (read-only)

What is installed and running, the version, and whom it talks to.

| Platform | Installed | Running | Talks to |
|---|---|---|---|
| Windows | registry Uninstall keys (HKLM, WOW6432Node, HKCU), services (`HKLM\SYSTEM\CurrentControlSet\Services\*\ImagePath` + `sc query`), executables under `%ProgramFiles%\Nova Star`, `%ProgramFiles(x86)%\Nova Star`, `%APPDATA%\Nova Star`, `%ProgramFiles%\UCenter` | `tasklist /FO CSV /NH` | `netstat -ano` (TCP to other computers + listening ports, by PID) |
| macOS [I] | `/Applications`, `~/Applications` bundles (Info.plist version) | `ps -axo pid=,comm=` | `lsof -nP -i` |
| Linux | — (NovaStar's apps don't run there) | | |

Version: the installed-programs entry (NovaLCT and VMP only carry it in the name, `NovaLCT V5.9.2`), else the executable's
own version resource (read in Python, no tools). Go programs (UCenter, XCenter, NeoController) carry none.

Apps known: NovaLCT, NovaLCT Lite, MarsServerProvider, NovaLCT monitoring (LCT_XCenter, MonitorDaemon), VMP, XCenter,
NeoController, Unico, UCenter, UServer. Seen on the VM (2026-10-28): NovaLCT 5.9.2 and Lite 5.6.2 (per user, `%APPDATA%`),
MarsServerProvider 3.1.1912.1001, VMP 1.5.1, Unico 2.8.0; services UCenter (`C:\Program Files\UCenter\ucenter\ucenter_win.exe`)
and VMPXCenter running. The report's REPORT.md gets a "NovaStar apps on this computer" table and `vendor/apps.json`.

## 2. The vendor apps' logs (opt-in)

Help ▸ Report a problem ▸ **NovaStar apps' logs** (unticked by default; the window's *Add them to problem reports* makes it
start ticked in that browser). Collected at report time, not copied anywhere first: files changed in the **last 3 days**,
newest first, **the last 4 MB of each** (whole lines), **40 MB in all**; `.gz` rotations unpacked, UTF-16 read as text.
`vendor/logs/INDEX.md` lists every file with what was cut or left out. Scrubbed (`vendortap.scrub`, then the report's own
scrub): `"password":"…"`, `password=…`, `Token:…`, `Authorization: Bearer …`, licence / serial / activation keys,
session ids, cookies, and prose like UCenter's `token store successful:<token>`.

Log folders (real paths on the VM, 2026-10-28):

| App | Folder | Notes |
|---|---|---|
| NovaLCT | `%APPDATA%\NovaLCT 2012\Config\LogInfo` | `LCT\LCT.log`, `Monitor\Monitor.log*` (10 MB rotations), `MarsServer\Mars.log` |
| NovaLCT | `%APPDATA%\Nova Star\NovaLCT\Bin\Log` | `<date>\MonitorDaemon.log`, brightness tool logs |
| NovaLCT | `%APPDATA%\LCT_XCenter\log` | `xcenter.log`, `fiber.log`, daily `fiber-*.log.gz` |
| NovaLCT | `%ProgramData%\XCenter\log` | `marsproxy\marsproxy.log` (100 MB here: only its end goes in) |
| NovaLCT Lite | `%APPDATA%\Nova Star\NovaLCT Lite\Bin\Log` | |
| VMP | `%APPDATA%\NovaStar\VMP\log` | `vmp.log` (76 MB here) |
| VMP | `%ProgramData%\VMP_XCenter\log` | `xcenter.log`, `xcenter_panic.log`, `fiber.log` |
| VMP | `%APPDATA%\VMP\xserver140\<n>\userdata\log` | the offline controllers (NeoController): `controller\controller.log`, `ncp.log`, `fiber.log` |
| VMP | `%ProgramFiles(x86)%\Nova Star\Coex VMP\Bin\Log` | empty here |
| Unico | `%ProgramData%\Unico\log` | `ucenter\ucenter.log` (logs the device login JSON: scrubbed), `unico\logs\*`, `userver\<sn>\*.log.gz` |
| Unico | `%APPDATA%\Unico\logs` | empty here |
| Test tool | `%APPDATA%\NovaStar\testtool\log` | |
| macOS [I] | `~/Library/Logs/{Unico,VMP}`, `~/Library/Application Support/{Unico/logs,UCenter/log,NovaStar/VMP/log,VMP_XCenter/log}` | guesses until a tester's Mac shows the real ones |

## 3. Wireshark capture (guided)

The window shows which tools are here (Windows: Wireshark / dumpcap / tshark under Program Files, Npcap and whether it is
restricted to administrators; macOS: Wireshark.app, `/usr/sbin/tcpdump`, whether `/dev/bpf*` is readable / ChmodBPF is
installed), the capture filter and the steps.

| Family | Capture filter |
|---|---|
| NovaLCT (TG) | `udp port 3800 or tcp portrange 5200-5232` (discovery 3800; 5200, H series 5201+) |
| Unico | `udp port 5600 or tcp port 8088 or tcp port 15200` (discovery, REST + WebSocket, central control) |
| VMP / COEX | `udp portrange 54622-54624 or udp port 54700 or tcp port 8001 or tcp port 9001` (announcements, backup discovery, REST + WS, HTTPS) |
| One processor | `host <IP>` — everything with it: the best choice for a model or feature nobody has captured |

Steps (Windows): install Wireshark with Npcap → pick the adapter that reaches the processor (loopback adapter when the vendor
app and a simulator are both on this computer) → paste the filter, start → do one thing in the vendor app → stop, File ▸
Save As .pcapng → **Add capture…**. macOS also: `sudo tcpdump -i en0 -w ~/Desktop/nova.pcap '<filter>'` (the tester types
their own password).

**Add capture…** sends the file to the helper (`/api/hw/vendor/import`, up to 300 MB): the original is kept unchanged in
`vendor/captures/` and decoded by `wirelog.from_capture` (NovaLCT frames on any TCP port with round-trip times, echoes,
discovery on 3800 / 5600 / 54622, HTTP request / status lines; HTTP bodies and WebSocket frames are not decoded from captures —
the original is there for that). The original goes into the report **as it is, not scrubbed**: a vendor app's login (Unico's
default `MTIzNDU2`) can be in it.

**Start here** (only when dumpcap is installed): `dumpcap -i <adapter> -f <filter> -w vendor/captures/<time>_live.pcapng -q
-a duration:<min> -a filesize:200000`, as the user, never elevated. When it stops at once with a permission error (Npcap
"admin only", no BPF access) the window says so and the steps are the way. **Stop** ends it and imports the file.

## 4. Relay (experimental — needs a live check)

Open Nova stands in for the processor: the vendor app finds and connects to the **relay address**, every byte goes on to the
real processor **unchanged** and the answers come back unchanged. Both directions are recorded into `vendor/relay/`
(bytes are passed on first, recorded after: a recorder problem never touches the traffic). The relay address is a
`127.x` address on this computer (default `127.0.0.42` on Windows / Linux, `127.0.0.1` on macOS, which has only that one) when
the vendor app runs here, or this computer's address on a second network adapter when the vendor app runs on another computer.

| Family | How the vendor app finds the relay | Relayed |
|---|---|---|
| NovaLCT | Its loopback search (`rqProMI:` to UDP 3800, seen by FakeProcessor's `--devices`) is passed to the processor; the processor's own `rpProMI…` answer goes back from the relay address. Ports: the ones the answer names (5200, H series `H_SUB_CARD` 5201+), listened on at the relay address, so the answer needs no change | TCP, TG frames recorded as `tg` / `echo` / `junk` with round-trip times |
| Unico | UCenter's loopback search (NOVA frame to 127.0.0.1:5600 from :54309) is passed on, the device's NOVA answer returned from the relay address; the HTTP / WebSocket port it names is listened on there | HTTP calls (`http`, request paired with answer, chunked bodies joined) and WebSocket frames (`ws`, NOVA frames decoded, every frame incl. pings) |
| VMP / COEX | XCenter is told about `<relay>:8001` every 2 s in the controllers' own announcement format (`{"data":[{"apiPort","mac",…}]}` to 127.0.0.1:54622/54623; to the broadcast address on 54622-54624 for a NIC address) | HTTP + WebSocket as Unico |

Recordings are whole, as the recorder's own (docs/DIAGNOSTICS.md): every body, header, frame, datagram and stray byte;
UTF-8 bodies as text, others base64, over 4 MB in `diagnostics/<day>/bodies/`. They never hold a login: passwords, tokens
and `Authorization` values are hidden in what is recorded (the bytes passed on are untouched). Open Nova's own discovery ignores a running relay's address (`vendortap.relayed`), so the app
doesn't take the relay for a processor of its own.

**Limits (say so to testers):**
- The vendor app may **still find the real processor** directly: NovaLCT, UCenter and XCenter search every adapter. Then it
  lists two (same name / SN, different address). Use the one at the relay address; if the app merges or flips between
  them (Unico is known to flip between two addresses for one SN, FakeUServer §20), the relay needs the vendor app on another
  computer / adapter that only reaches the relay.
- NovaLCT connects to **every** processor it finds: with both listed, the real one gets two connections (direct + relay). A
  processor that takes one connection only refuses the second.
- What the vendor app sends is sent: Open Nova's alpha read-only lock covers Open Nova's own writes, not the vendor app's.
- Searches through the relay need UDP 3800 / 5600 free for a shared bind on this computer; when they aren't, the relay
  still forwards TCP and the vendor app needs "connect by IP" (or the relay address typed in).
- NovaLCT's TG ports must be 4-digit (LCT's own rule), so the relay can't move them: it listens on the same port numbers at
  the relay address.
- Not seen with a real vendor app yet (on the VM NovaLCT / Unico / VMP need elevation, which the test can't drive).

## 5. Tested (2026-10-28, fakes only, nothing real)

`python -I -X utf8 tools/test_vendortap.py` (all pass): parsing (tasklist, netstat, ps, lsof, dumpcap -D, versions from names
and PE resources, app matching incl. another vendor's "VMP"), scrubbing (7 forms, and what must stay), logs (days, per-file
tail with whole lines, total cap with "left out", .gz, UTF-16, INDEX), pcap import into `vendor/captures/` (+ original, opens
in Diagnostics), a stand-in dumpcap (interfaces, admin-only refusal, start / stop / import), and the relay byte for byte:
- **NovaLCT** against a stand-in TG processor on 127.0.0.5: ports learned from `H_SUB_CARD`, loopback search answered from
  127.0.0.42 with the processor's own bytes, frames split at odd places + stray bytes + an H-style echo: both sides got exactly
  the other's bytes; 3 requests / 3 replies with RTT, the echo, the junk, discovery and the connection recorded; the file
  loads in Diagnostics and exports to .pcap.
- **Unico** against a stand-in (NOVA discovery, login POST, chunked GET, WebSocket upgrade, binary NOVA push, ping / pong,
  masked client frames): byte for byte both ways; 3 calls paired; push decoded (tag 327936); no password / token in the file.
- **COEX**: the announcement from 127.0.0.42 (`apiPort`, MAC, authType 0); HTTP both ways unchanged.

Also by hand: NovaLCT relay against **FakeProcessor** (C#, MCTRL4K preset): search through the relay answered
`rpProMI:FakeProcessor` from 127.0.0.42; ModelID / sender parameters / receiving-card reads / a missing second sender:
same answers via the relay as direct. Unico relay against **FakeUServer** persona vx2000pro-b: NOVA search answered via
the relay, login + node/detail + node/ethernet + screen/list-detail identical via relay and direct, WebSocket upgrade and
the persona's pings recorded, the password hidden. The app window on a test server: detection of the VM's apps, a relay
started from the window (an LCT-like client found it and read through it), Stop, Add capture of its .pcap export, Open in
Diagnostics; problem report with and without the vendor logs.

## 6. Needs a live check
- Each relay with the real vendor app: does NovaLCT / UCenter / XCenter list the relay entry, use it, and work normally
  through it? What happens with the real processor also visible (two entries, flip-flop)?
- macOS: app bundle names, log folders, `lsof` without admin, `tcpdump` / ChmodBPF permissions.
- dumpcap with a real Npcap (not on the VM): interface names, whether non-admin capture works out of the box.
- Big real logs on a tester's machine: time to collect (40 MB took ~14 s here with 30 days; 3 days is the default).
