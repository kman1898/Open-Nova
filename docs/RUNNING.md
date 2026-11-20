# Running Open Nova (Windows, macOS, Linux)

Open Nova is a web page plus two small Python programs that run on the computer next to the processors:
- **the app server** (`app/serve.py`) serves the page and keeps the shared project;
- **the hardware helper** (`tools/novalink.py`) talks to the processors.

`opennova.py` starts both and opens the browser. Nothing else to install: Python 3.9 or newer (standard library only).
The per-system packages (`…-windows.zip`, `…-mac.zip`, `…-linux.zip`, `make_package.py --python`) carry the Python
archives in `python-dist/` and set up from them on the first start, with no internet; that Python is used even when the
computer has its own. Without them, on Windows `Start Open Nova.bat` uses Python 3.9+ if the computer has it, and otherwise fetches python.org's embeddable
Python into a `python` folder next to it on the first start (`tools/get-python.ps1`: about 12 MB, checked against the
published SHA-256; no installer, no PATH change, no admin rights — delete the folder to remove it). macOS and Linux do the
same (`tools/get-python.sh`) with python-build-standalone's relocatable CPython (the builds uv uses; 27-37 MB, SHA-256
checked) when there is no Python 3.9+ with lzma. On a Mac without Apple's developer tools, `/usr/bin/python3` is only a
placeholder that opens Apple's install dialog, so it is skipped then.

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
1. Python: nothing to install. `Start Open Nova.command` uses the Mac's Python 3.9+ if it has one, else fetches one into
   the folder on the first start (needs internet that once).
2. Copy the whole Nova folder to the Mac (Documents is fine).
3. Double-click `Start Open Nova.command`. If macOS refuses ("unidentified developer" / "Apple could not verify"), allow
   it once: on **macOS 14 or older** right-click it ▸ **Open** ▸ **Open**; on **macOS 15 or newer** click **Done**, then
   System Settings ▸ Privacy & Security, scroll down to *"Start Open Nova.command" was blocked* ▸ **Open Anyway**, and
   confirm (password or Touch ID). Or, in Terminal: `xattr -dr com.apple.quarantine <the Open Nova folder>`, then
   double-click again. If it says it has no permission, run `chmod +x "Start Open Nova.command"` in Terminal in that folder.
4. When macOS asks whether Python (macOS 15 may name **Terminal** instead) may **find devices on your local network** and
   **accept incoming connections**, allow both — otherwise the processor search finds nothing. Clicked Don't Allow?
   System Settings ▸ Privacy & Security ▸ Local Network: switch on Terminal (or Python).

## Linux
`chmod +x start-open-nova.sh` once. If a firewall is on, allow UDP 3800 replies (NovaLCT processors), UDP 5600 (Unico) and
UDP 54622-54624 (MX / CX announcements) for the search, and TCP 8765 for other devices.

## Windows Firewall
When Windows asks whether Python may use the network, tick **both Private and Public**, then Allow: a show network with
static addresses and no internet counts as **Public**. Clicked Cancel, or ticked Private only? Control Panel ▸ Windows
Defender Firewall ▸ Allow an app through Windows Defender Firewall ▸ Change settings ▸ tick Private and Public for Python
(the one in the Open Nova folder's `python` folder).

## Finding processors
- The search asks every network the computer is on (Wi-Fi and Ethernet at the same time), not just the main one.
- A processor on another subnet or over a VPN (Tailscale) doesn't hear the search: Processors ▸ Hardware ▸ **Add by
  address…** and type its IP; it is asked directly on every search from then on.

## A controller on USB (its USB-B port, e.g. VX1000)
Find lists it like a processor on the network. What each system needs (nothing for you to install on Windows or a Mac
when you use that system's package, `…-windows.zip` / `…-mac.zip`: they carry libusb in their `libusb` folder):
- **Windows:** a USB driver for the device. **Install NovaLCT once** (it installs NovaStar's USB driver; Open Nova then
  talks to it through that driver's libusb0.dll), or set the device to **WinUSB** with Zadig (Options ▸ List all devices ▸
  "Nova ProHD" / "NovaStar MTP"). Open Nova never installs drivers itself. Close NovaLCT / VMP while Open Nova uses USB.
- **macOS:** nothing. The any-system package needs `brew install libusb`.
- **Linux:** `sudo apt install libusb-1.0-0` (or your distribution's libusb package) and, so you don't need root, the
  rule `SUBSYSTEM=="usb", ATTR{idVendor}=="0483", ATTR{idProduct}=="5720", MODE="0660", TAG+="uaccess"` in
  `/etc/udev/rules.d/60-novastar.rules`; then unplug the controller and plug it in again.

When it is plugged in but can't be used, Find says why and the one thing to do (the same text goes into the recording, so
a problem report shows it).

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
