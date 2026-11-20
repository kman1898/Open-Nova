# USB capture — record NovaLCT ↔ a USB-only controller (NovaPro HD) the way Wireshark does

User, 2026-11-16: "same way wireshark works". NovaLCT keeps the controller and uses USB as normal, in any order; Open Nova
only watches. Code: `tools/usbcap.py` (tests `tools/test_usbcap.py`). The pinned installer: `tools/usbpcap.json`.
Related: USB_NOVA_DEVICE.md (the device and NovaLCT's USB framing), VENDOR_CAPTURE.md (the network side), DIAGNOSTICS.md.
The network side is automatic and passive too (VENDOR_CAPTURE.md §0b, `tools/netcap.py`: Windows' pktmon, **Allow recording**);
its prompt is separate from **Allow USB recording** (two recorders, each asks once per start).

[R] = seen live, [S] = read in USBPcap's source (tag 1.5.4.0), [D] = documentation, [?] = not checked live yet.
No live capture of a NovaPro HD has been made yet: everything below about the controller's traffic is to be confirmed.

## 0. Automatic: the tester chooses nothing (`tools/usbauto.py`)

User, 2026-11-16: *"i dont want them to have to choose the bridge. the app needs to be able to do both and smart enough to
understand the need to do both"*. The helper runs a coordinator (`usbauto.run`, started by `novalink serve`; tests
`tools/test_usbauto.py`) that looks every **2.5 s** (Toolhelp32 process list about 12 ms, cfgmgr32 for the device about
6 ms; the libusb listing only when the device comes) and picks between Open Nova's own link + the bridge
(VENDOR_CAPTURE.md §4) and this USB capture:

| Situation | What happens | The tester's line |
|---|---|---|
| NovaStar USB device (0483:5720) here, NovaLCT closed | Open Nova may use it; the **bridge is armed** (127.0.0.42, NovaLCT's search answered) | `NovaPro HD on USB · ready for Open Nova and NovaLCT` |
| NovaLCT opens | 15 s for it to connect through the bridge | `NovaLCT is open · waiting for it to connect through Open Nova` |
| NovaLCT connected through the bridge | both use it, everything recorded (until NovaLCT closes) | `NovaLCT connected through Open Nova · recording` |
| NovaLCT didn't connect within **15 s**, or already had the device (the bridge's open failed busy) | Open Nova **lets go**: bridge stopped, its own link closed and not opened again while NovaLCT runs (`novalink.usb_yield`: its requests get "NovaLCT is using the …: Open Nova leaves it alone until NovaLCT closes", its searches answer from the last probe). Then USBPcap records it | `NovaLCT has the NovaPro HD · recording` |
| … USBPcap missing | the one step | `… · not recorded yet` + **Install USB capture** |
| … installer running | | `… · installing USB capture…` |
| … installed, not active | | `… · restart the computer once to record it` |
| … ready, not allowed yet this session | | `… · not recorded yet` + **Allow USB recording** |
| … Windows' prompt up | | `… · Windows is asking to allow USB recording` |
| … prompt answered No | never asked again this helper session | `… · not recorded (Windows’ prompt was answered No)` |
| … start failed | no automatic retry; the button again (reason in its tooltip) | `… · not recorded: USB recording didn’t start` + **Allow USB recording** |
| NovaLCT closes | capture stopped and decoded, device taken back, bridge armed again (a fresh recording file) | back to the first line |
| Device busy, NovaLCT closed | tried again every 5 s; if a NovaLCT program (MarsServerProvider, its monitoring) runs, it is treated like NovaLCT | `… is in use by another program · trying again` |
| The bridge can't start (port taken …) | Open Nova still uses the device; NovaLCT starting = released at once | `…: NovaLCT can’t reach it through Open Nova` |
| A NovaLCT relay started / stopped by hand (Vendor apps ▸ Advanced) | coordinator stays out (while it runs, and 120 s after) | `USB handled by hand for now (Vendor apps ▸ Advanced)` |
| macOS / Linux | nothing: Open Nova just uses the device (NovaLCT is Windows-only) | (no line) |

* **Consent**: no UAC prompt before the tester's **Allow USB recording** (once per helper session). After it, the
  coordinator starts captures by itself when needed (NovaLCT again, a capture that hit its 8 h / 1 GB limit); after a No,
  never again that session (usbcap's `retry` stays False).
* **Unplugged mid-way**: the bridge stops; a running capture runs on (USBPcap's `--capture-from-new-devices` sees the
  device come back on that hub). Re-plugged: the bridge again, or still released while NovaLCT runs.
* **NovaLCT restarting** is a close + open (also when both happen between two looks: new process ids).
* Only NovaLCT-family controllers get the bridge: NovaStar's USB device, and a COM port Open Nova's own probe identified as
  a controller (released COM ports aren't recorded: USBPcap records the NovaStar USB device).
* Every change is a recorder mark (`USB auto: armed -> waiting …`, source vendor); the app logs `usb_auto_state`.
* The line: Device panel (under the processor cards), Add processor (online), Tools ▸ Vendor apps (top). Its tooltip says
  more. The hand controls (USB capture Start / Stop, Relay) are under **Advanced** in Vendor apps.
* Timings are constants at the top of `tools/usbauto.py` (`POLL_S`, `LCT_CONNECT_WAIT`, `REARM_RETRY`, `HAND_PAUSE`,
  `CAP_MINUTES` / `CAP_MB`), to be tuned after the live test. `OPENNOVA_USB_AUTO=0` switches the coordinator off.
* Status for code: `POST /api/hw/vendor/usb-auto` (state, sub, say, tip, action, device, history), `usb-auto-allow`,
  `usb-auto-install`.
* **To confirm on the tester's PC [?]**: whether NovaLCT finds a NovaPro HD through the bridge at all (it may scan USB
  only, or refuse a NovaPro HD found on the network: then the 15 s rule hands it over), whether NovaLCT holds the device
  all the time or only while busy, how often it scans USB (about 30 s?), whether its background programs hold the device
  after NovaLCT closes.

## 1. How it works

```
NovaLCT ──libusb0.sys──► device 0483:5720            (unchanged: NovaLCT holds the device)
                 ▲
     USBPcap.sys (filter under every root hub: sees every URB, changes nothing)
                 │ \\.\USBPcapN (admins only)
 USBPcapCMD.exe (elevated copy, started by ShellExecute "runas": the one UAC prompt)
                 │ named pipe
 USBPcapCMD.exe (as the tester, started by the helper) ──stdout──► helper ──► diagnostics/<day>/vendor/captures/<time>_usb.pcap
                                                                        └──► live counters; on Stop: <time>_usb.nwl next to it
```

* **USBPcap** (desowin/usbpcap) is a filter driver on the USB root hubs; `USBPcapCMD.exe` writes a classic `.pcap`,
  link type **249 LINKTYPE_USBPCAP** [S]. Wireshark's Windows installer offers it ("Install USBPcap") and runs this same
  installer interactively, then copies USBPcapCMD into its `extcap` folder and asks for a restart [S: Wireshark
  `packaging/nsis/wireshark.nsi`, `CMakeLists.txt` pins USBPcap 1.5.4.0 with the same SHA-256].
* **Admin only** [S]: each `\\.\USBPcapN` is created with SDDL `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GX;;;WD)(A;;GX;;;RC)` —
  SYSTEM and Administrators full access, Everyone only "execute". Starting a capture (`IOCTL_USBPCAP_START_FILTERING`)
  needs read + write access, so it needs an elevated process. Listing hubs and devices does not (the hub symlink IOCTL is
  FILE_ANY_ACCESS; the device walk uses the normal hub IOCTLs).
* **The one prompt**: USBPcapCMD, started un-elevated, starts an elevated copy of itself through `ShellExecuteEx`
  `"runas"` (SW_HIDE) and puts both in a kill-on-close job [S `cmd.c` `start_capture`, `create_elevated_worker`]. With
  `-o -` the elevated copy writes into a named pipe the un-elevated one reads and copies to stdout — the helper reads that
  pipe, writes the `.pcap` as it comes and counts frames live. The helper itself never runs elevated.
  Why not the elevated copy writing the file: it gets `-o <file>` without quotes [S: `WORKER_CMD_LINE_FORMATTER`], so a
  path with spaces (Nextcloud\LED\LED Wall Tech\…) breaks; and the file would belong to an administrator.
* **Stop** = the helper ends its USBPcapCMD (TerminateProcess). The pipe breaks, the elevated copy's pending pipe read
  fails (ERROR_BROKEN_PIPE) and it ends; the job closing ends it too [S]. If the helper dies, USBPcapCMD's stdout breaks and
  the same happens. What the elevated copy had in flight in the last ~0.3 s can be lost.
* **What is captured**: `-d \\.\USBPcapN -o - -s 131072 --inject-descriptors --devices <addr> --capture-from-new-devices`
  (the hub and address detect() found; `-A` = the whole hub when no address is known). `--inject-descriptors` puts the
  descriptors of the devices already connected at the start of the capture, so the NovaStar device is recognised without
  replugging; `--capture-from-new-devices` keeps a replug on the same hub (new address) in the capture.
* **A NovaLCT session already running is captured from the moment the capture starts** [S]: USBPcap learns every device's
  endpoints whenever a configuration is selected, capture or not ("Following URBs are always analyzed" in
  `USBPcapURB.c`), so transfers after the start are decoded with the right endpoints. Transfers before the start are
  not in it; a request in flight at the start has no request (its reply shows without a round-trip time).
* **Start-up time**: USBPcapCMD itself starts in well under a second [?]; the elevated copy writes the pcap header as soon
  as it opens the hub, and status() reports the time to that (`startSeconds`, also a mark in the recording). The human
  answering Windows' prompt dominates the first start. Can it record "from the moment NovaLCT first sees the device"?
  NovaLCT looks for USB devices every 30 s (USB_NOVA_DEVICE.md §3), so a capture started when the device appears
  (detect(): `present`) and allowed at once usually is running before NovaLCT's next look; with consent given earlier
  in the session, start() takes ~1 s [?, to measure on a Windows PC with USBPcap].
* **One prompt per USBPcapCMD**: a capture covers one root hub. Moving the controller to a port on another root hub needs
  a new capture (a new prompt). USB 3 root hubs: the installer's "Detect USB 3.0" step (`USBPcapCMD -I`, NonStandardHWIDs)
  [S].

## 2. Detection and states (`detect()`, read-only, cheap to poll)

| state | means | what the tester is told |
|---|---|---|
| unsupported | not Windows | USBPcap is Windows only (NovaLCT is too) |
| not-installed | no USBPcap service / filter / uninstall entry | install it once (button), then restart |
| reboot | installed but no `\Device\USBPcapN` yet (filter not attached), or the service is pending removal | restart the computer once |
| no-cmd | driver present, USBPcapCMD.exe missing | reinstall USBPcap |
| ready | can capture | the device's hub and address, or "plug the controller in" |

Looked at: `HKLM\SYSTEM\CurrentControlSet\Services\USBPcap` (+ `DeleteFlag`), `USBPcap` in the USB class key's
`UpperFilters` (`{36FC9E60-C465-11CF-8056-444553540000}`), `…\Uninstall\USBPcap` (DisplayVersion, UninstallString);
USBPcapCMD in USBPcap's folder or Wireshark's `extcap` (`OPENNOVA_USBPCAPCMD` = a stand-in for tests). Hubs:
`USBPcapCMD --extcap-interfaces` (cached 60 s). Device: `--extcap-interface \\.\USBPcapN --extcap-config` per hub (lines
`value {arg=99}{value=5}{display=[5] Nova ProHD}…`), matched by the names Windows has for `USB\VID_0483&PID_5720`
(DeviceDesc / FriendlyName: "Nova ProHD" from NovaLCT's INF) — done only when the device comes or goes (cfgmgr32
`CM_Locate_DevNode`, no process) or after 30 s. `needsElevation` is always true for the helper.

## 3. Install (`install()`, only on the tester's click)

The Windows package carries the official installer **unmodified**: `usb-capture/USBPcapSetup-1.5.4.0.exe` (195 040 B,
SHA-256 `87a7edf9…cb622`, Authenticode-signed "Tomasz Moń", Certum Code Signing CA SHA2, timestamped) and its source
`usb-capture/usbpcap-src-incl-pdb-1.5.4.0.7z` (SHA-256 `3a66cf03…b15e`), both pinned in `tools/usbpcap.json`. install()
checks the SHA-256 again, then ShellExecute "runas": Windows' prompt (it shows the verified publisher), then USBPcap's own
pages: the GPL-2.0 licence (tick), the BSD-2-Clause licence (tick), components (Full: driver, USBPcapCMD, "Detect USB 3.0"),
folder (`C:\Program Files\USBPcap`), Install; it sets a system restore point and installs the INF
(`InstallHinfSection DefaultInstall 132`: Windows may offer the restart itself) [S `nsis/USBPcap.nsi`]. Never silent.
Exit codes: 0 done, 1 cancelled, 2 stopped (already installed / a removal pending a restart). Then detect() again:
normally **reboot** — the filter attaches to the root hubs when they start, i.e. after a restart [D desowin.org tour:
"restart the computer after installation"; Wireshark's installer sets its reboot flag].
Not in the package (a git checkout, the plain zip): the button says where to get it (desowin.org/usbpcap, or Wireshark's
installer with "Install USBPcap" ticked).

Licences: driver GPL-2.0, USBPcapCMD BSD-2-Clause [S README "Licensing"]; texts in `licenses/USBPcap-*.txt`, NOTICE names
them. Shipping the unmodified installer next to Open Nova is mere aggregation; GPL-2.0 §3 is met by shipping the complete
source of the same release alongside (§3a), which the package does.

## 4. Decoding (`from_pcap(path or bytes, hint)` → the recorder's records)

USBPcap packet header (27 B, LE, packed) [S `USBPcap.h`]: headerLen u16, irpId u64, status u32 (USBD), function u16,
info u8 (bit 0 = completion, PDO→FDO), bus u16 (= N of `\\.\USBPcapN`), device u16 (address), endpoint u8 (bit 7 = IN),
transfer u8 (0 iso, 1 interrupt, 2 control (+1 B stage), 3 bulk), dataLength u32. Bulk data: OUT on the submission, IN on
the completion [S `USBPcapURB.c`].

* The device: a device descriptor (control completion, `12 01 … 83 04 20 57`) in the capture; else the hint (hub, address)
  the capture was started with; else its traffic — a 31-byte USBC block with CB length 16, CB[0] A2/A3, CB[7] 1 (a bare
  55 AA frame isn't enough). A descriptor naming another device wins over the hint (address reused). A replug (new
  address, new descriptor) is followed. Link name `usb:0483:5720@USBPcap<N>.<address>`.
* Kept: bulk transfers of that device only. OUT = `tx`, IN = `rx`. Each direction is a byte stream cut into USBC (31 B,
  `usb` record: tag, len, read, cb, note), USBS (13 B, `usb`: tag, residue, status), TG frames (`tg`, named by
  `wirelog.decode` / `summary`, round-trip time from the URB times by serial; a 55 AA coming back on IN = `echo`) and
  `junk`. A frame split over two IN transfers is one frame at the second one's time; a half frame followed by a new block
  is `junk` ("cut off"). An empty OUT = `usb` "empty packet". Failed transfers (non-zero USBD status) = `err`; NovaLCT's
  timed-out reads (USBD_STATUS_CANCELED, no data) are only counted. A transfer cut by the snap length, a file cut inside a
  packet or a capture ending inside a frame = `err`.
* Left out: control transfers, other devices on the same hub, interrupt / iso. The original `.pcap` stays next to the
  `.nwl`, unchanged. `import_pcap(name, bytes)` does the same for a file added with "Add capture…" (vendortap dispatches
  link type 249 here). CLI: `python tools/usbcap.py` (detect) / `python tools/usbcap.py decode FILE.pcap`.

## 5. For the USB coordinator (code that starts it without a tester)

* `detect()` costs registry reads + a cached hub list + one cfgmgr32 call (≈10 ms here); the per-hub walk runs only when the
  device appears / disappears or after 30 s. `detect(devices=False)` skips the device part.
* `start(consent=…)` never raises for the expected cases and never shows a UAC prompt unless `consent=True` (the tester's
  one "Allow USB recording" this session; it is remembered). After the prompt was answered No it doesn't ask again this
  session unless `retry=True`. Already running → `{ok: true, already: true}`. Returns `state`: capturing / waiting (prompt
  up) / needs-consent / unsupported / not-installed / reboot / no-cmd / no-device / refused / failed.
* `stop()` when nothing runs → `{ok: true, state: 'idle'}`. `status()`: running, state, bytes, packets, frames, novaSeen,
  startSeconds, the last five summaries.
* Limits: stops by itself after 60 min / 200 MB (start's minutes / max_mb). The helper ends USBPcapCMD when it exits.

## 6. Tester steps (Windows)

Normally none: §0 does it, and the line asks for the two one-time steps when they are needed. By hand (Vendor apps ▸
Advanced ▸ USB capture):

1. Once: Tools ▸ Vendor apps ▸ Advanced ▸ USB capture ▸ **Install USB capture…** → Windows asks "Do you want to allow this app…
   USBPcap installer, Verified publisher: Tomasz Moń" → Yes → USBPcap's installer: tick "I accept" on both licence pages,
   Next, Next (Full), Install, Close. **Restart the computer** (needed: the driver attaches to the USB hubs at start-up).
2. Plug in the controller (NovaPro HD) and open NovaLCT as usual — before or after, in any order.
3. Open Nova ▸ Tools ▸ Vendor apps ▸ Advanced ▸ USB capture ▸ **Start** → Windows asks once (for "USBPcapCMD" [?: the
   publisher line it shows not seen yet]) → Yes. The line shows "Capturing" and counts frames.
4. Use NovaLCT (connect, read, send…).
5. **Stop**. The recording appears under Recorded (open it in Tools ▸ Diagnostics); the `.pcap` (Wireshark) is next to
   it; both go into the next problem report.

## 7. macOS (note only)

NovaLCT is Windows-only, so this matters only for VMP / Unico over USB, if they use USB at all [?]. macOS has no USBPcap:
Wireshark / tcpdump capture USB through the `XHC20` / `XHCn` pseudo-interfaces (`sudo ifconfig XHC20 up`, macOS 10.13+);
since Catalina this needs System Integrity Protection disabled (`csrutil disable` from Recovery; on Apple silicon entirely),
interface names differ (XHC0 / XHC1 / XHC2), and reports say it no longer works on macOS 15 [D: Wireshark wiki
CaptureSetup/USB, Apple Developer Forums threads 124875 / 95380, ask.wireshark.org 30854]. Not something to ask of
testers: on a Mac, use the relay (VENDOR_CAPTURE.md) or a Windows PC.
