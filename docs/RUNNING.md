# Running Open Nova (Windows, macOS, Linux)

Open Nova is a web page plus two small Python programs that run on the computer next to the processors:
- **the app server** (`app/serve.py`) serves the page and keeps the shared project;
- **the hardware helper** (`tools/novalink.py`) talks to the processors.

`opennova.py` starts both and opens the browser. Nothing else to install: Python 3.9 or newer (standard library only).

## Start it

| System | Double-click | Or in a terminal |
|---|---|---|
| macOS | `Start Open Nova.command` | `python3 opennova.py` |
| Windows | `Start Open Nova.bat` | `py -3 opennova.py` |
| Linux | `start-open-nova.sh` | `python3 opennova.py` |

The app opens at http://localhost:8765/. Other devices on the same network (an iPad, a second laptop) use the
addresses printed in the window, e.g. http://192.168.0.10:8765/. **Leave the window open while you work**; closing it
(or Ctrl+C) stops Open Nova.

Options: `--port 8775` (another port), `--data-dir DIR` (where the project and logs are kept; default `app/data`),
`--local-only` (this computer only), `--bind all|localhost|<interface>` (which networks can open the app; default: what
Settings ▸ Network says), `--no-browser`, `--alpha` (behave as the alpha build: read-only until unlocked;
DIAGNOSTICS.md "The alpha build"). The version is in Help ▸ About and the window title (`app/version.json`).

## First time on a Mac
1. Python: macOS's built-in `python3` may lack a module Open Nova needs (it says so). Then install Python from
   https://www.python.org/downloads/ and start again.
2. Copy the whole Nova folder to the Mac (Documents is fine).
3. Double-click `Start Open Nova.command`. If macOS refuses ("unidentified developer"), **right-click it ▸ Open ▸ Open**
   once. If it says it has no permission, run `chmod +x "Start Open Nova.command"` in Terminal in that folder.
4. When macOS asks whether Python may **find devices on your local network** and **accept incoming connections**, allow
   both — otherwise the processor search finds nothing.

## Linux
`chmod +x start-open-nova.sh` once. If a firewall is on, allow UDP 3800 replies (NovaLCT processors), UDP 5600 (Unico) and
UDP 54622 (MX) for the search, and TCP 8765 for other devices.

## Finding processors
- The search asks every network the computer is on (Wi-Fi and Ethernet at the same time), not just the main one.
- A processor on another subnet or over a VPN (Tailscale) doesn't hear the search: Processors ▸ Hardware ▸ **Add by
  address…** and type its IP; it is asked directly on every search from then on.

## Networks (Settings ▸ Network…)
Like Bitfocus Companion, Open Nova uses **every network interface at once** by default: each search goes out of every
interface that is up (one socket per interface, bound to its address) and each processor found shows the interface it
answered on (Add processor, the Hardware card, Device info: "H5 · 192.168.0.11:5200 · Ethernet 2").

- **Search for processors on this network**: one tick per interface (name, type, address, connected or not, processors
  found on it). All on by default; one that turns up later (a USB Ethernet adapter, Wi-Fi joining, a VPN) is searched
  within about 15 s without a restart, one that goes away is dropped. Every change is in the log and the recording.
- **App reachable from**: every network (default), this computer only, or one interface (that network and this
  computer). Applies the next time Open Nova starts (`serve.py`, `serve.ps1` and `opennova.py` all read it; `--bind`
  overrides it). An interface that isn't connected at start = this computer only until a start with it connected.
- Kept on **this computer** (`network.json` in `%APPDATA%\OpenNova`, `~/Library/Application Support/OpenNova`,
  `~/.config/opennova`), never in the project and never in the (synced) Open Nova folder.
- **The same IP on two networks** (two isolated show networks numbered alike): both are found, flagged ("Two networks each
  have a processor at …"), and each is linked through its own interface (its address in the project is
  `192.168.0.11%Ethernet 3`; the connection is bound to that interface). If that interface isn't there, Open Nova refuses
  to connect rather than reach the other network's processor. Limits: Windows and macOS keep each connection on its
  interface; Linux does so on kernel 5.7 or newer (older kernels need root for it, otherwise the system's routing
  decides). A processor linked before the second network appeared keeps its plain address: link it again from the list.
  MX controllers (COEX) are told apart by MAC when two answer at one address. The interface name is this computer's: a
  project opened on another computer with such a link asks to be linked again there.

## Windows: the older server
`app/serve.ps1` (PowerShell) still works on Windows and behaves the same; `serve.py` is the cross-platform one.
