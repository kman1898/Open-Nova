# Diagnostics: seeing everything Open Nova exchanges with a processor

User, 2026-10-11: "when i connect via my mac to the H's we will need to make sure we have a way to analyze anything sent
from it to and from the H. So we need real diagnostics."

Two tools that cover each other's gaps:

| | Open Nova's recorder | Wireshark / tcpdump |
|---|---|---|
| Every byte Open Nova sends and gets back | always (recorded where the helper writes to the socket) | if capturing on the right interface, started in time |
| Which app action caused it | yes: the app's requests and actions, your notes | no |
| Helper-side errors (timeout, bad checksum, status) | yes, with the request they belong to | you see the gap, not why |
| Traffic Open Nova didn't make (other software, the processor itself, ARP, TCP resets) | no | yes |
| Readable | decoded, registers named | with the plug-in below |

Use the recorder always (it is on by default); add Wireshark when something looks odd, and import its capture into Open
Nova to read it decoded next to the recording.

## The recorder (tools/wirelog.py)
- Files: `Nova/diagnostics/<YYYY-MM-DD>/<time>_<pid>.nwl`, one JSON object per line; a new file each time the helper
  starts and every 20 MB (full files are gzipped to `.nwl.gz`; nothing is deleted; a second file in the same second is
  `<time>~02_<pid>.nwl`, so a rotation never writes into the file being gzipped). The folder syncs with Nextcloud.
- **Lossless (user, 2026-10-28: "all actions need to be logged to and from processor … including all packets sent").**
  Every byte to and from a processor is recorded whole, on every transport; the only thing ever masked is a password,
  token or login (H web login user / password and its token, the Unico login password and token, `Authorization` /
  `token` / cookie headers → `<hidden>`).
- Records: `tg` (a NovaLCT-protocol frame, exact bytes, decoded, register named, replies with round-trip ms; `late` =
  a reply that came after its request had timed out, e.g. emptied from the USB link before the next request), `echo`
  (our own request sent back by the processor, see below), `err` (timeout / bad checksum / status / connection closed,
  with the request; link `helper` = a bug in the helper itself, with a short traceback in `where`), `conn`, `junk`
  (bytes on a link that aren't a frame at all — all of them; bytes still in a link's buffer when it closes are recorded
  as `left over at close`), `usb` (NovaStar's USB wrapper: `USBC` write / read blocks with the tag and length they
  announce, `USBS` status blocks with tag / residue / status — every one, status 0 too —, the empty packet after a
  64-byte multiple; the frames inside are `tg` as on TCP), `udp` (discovery: the whole datagram as `hex`, and as `text`
  when it is text; the helpers read datagrams up to 65 535 bytes; `iface` = the network interface it went out of / came in
  on, `via` = the address it was sent from — Settings ▸ Network; a `conn` record's `via` says which interface a connection
  used, and link `net:<interface>` records an interface appearing, going, connecting or changing address), `http` (Unico / COEX / H web REST: method, URL,
  request / response headers `reqh` / `resph`, whole bodies — `{n, text}` for UTF-8, `{n, b64}` for anything else; a
  body over 4 MB goes to a side file `diagnostics/<day>/bodies/<recording>_<n>_<req|resp>.bin` and the record holds
  `{n, file, sha256, text: the first 64 KB, preview: true}`; multipart uploads (NCP / file sends) are recorded whole
  too), `op` (an app request to the helper starting / ending, with `what` = the app action's description), `mark` (app
  actions such as "App: a send started", your notes, refusals of the read-only alpha).
- **Every record made while serving an app request carries `act`**, the id of the user action in the app behind it
  (see Actions below).
- `t` = seconds since 1970 with microseconds, from a monotonic clock anchored to the wall clock when the helper started:
  it never goes backwards (a clock change mid-session doesn't reorder a recording); `seq` is strictly increasing.
- **Writing never stops silently:** a failed write (disk full, the folder gone) keeps the records in memory (up to
  64 MB, then the oldest are counted as `lost`) and tries again at most once a second; `diag/status` has
  `writeError {since, error, held, lost}`, every helper answer carries it as `recorderError` (the app shows a warning,
  once a minute) and Tools ▸ Diagnostics says so in red. When writing works again the held records are written in
  order, followed by a `mark` (source `recorder`) saying what happened.
- **Echoes (H series, seen on the user's H2 / H5, 2026-10-11):** the H sends some requests back to the computer:
  the broadcast write `W sender S* 0x01000000 SortCommand = 00` (detection) comes back byte for byte, and a request for a
  sending card that isn't there (`R sender S2 … ModelID`) comes back with the sending-card byte changed (S2 → S251,
  checksum redone) instead of a reply — so that request times out. Both are normal; the table shows them as `↩ echo:`
  with the request they belong to. Recordings made before this (where they were `junk`) are sorted out when opened.
- Frame summaries use the app's numbering: `W rx S1 P3 C* 0x02000001 GlobalBrightness = C0` = write, receiving cards,
  sending card 1, port 3, all cards, register, value. `S*` / `P*` / `C*` = broadcast. Replies: `-> value`.
- Register names: `tools/tg_registers.json` (from docs/HW_OPERATIONS.md Appendix A.1 / A.2 / B, `python
  tools/build_registers.py`; packed rows such as `MasterOrSlave(New/New16/New32)Addr` or `R/G/B brightness` are expanded
  per address) plus the names from captures in `wirelog.CURATED` (these win) / `RANGES`. Rebuild the plug-in after.
- USB / serial links (`usb:0483:5720@<bus-ports>`, `serial:COM3`) are recorded like TCP ones; in the `.pcap` export each
  gets a made-up host `10.99.1.n` on TCP 5200 (where the plug-in decodes) and a note packet naming the link; importing
  that `.pcap` again gives the links their names back. USB wrapper blocks go into the `.pcap` as notes (UDP port 9).
- The `.pcap` export leaves nothing out: payloads over 16 000 bytes go out as several TCP segments (Wireshark
  reassembles them), discovery datagrams whole, REST calls with their recorded headers and whole bodies (side files read
  back), notes (`op`, `mark`, `err`, `conn`, `usb`, failed REST calls) longer than a packet as numbered parts
  (`OpenNova part 2/3: …`). Imported captures keep whole datagrams and stray bytes too.
- A reply swaps header bytes 4 and 5 (HW_PROTOCOL §2.1): its sending card is byte 4.

## Actions: which click caused which frames
Every user action in the app — a click / pointer press on anything, a form change, a key shortcut, a slider drag (one
action per control while it moves) — gets an id `<tab>-<n>` (`app-log.js` `logAct`; `<tab>` = 4 random characters per
page load). Everything the action causes carries it:
- the app's log (`open_nova.log`): every entry made during it has `act` (shown as `[id]` in the Logs window), and
  each helper call it makes is logged as `helper_call` / `helper_done` (path, host, ok, ms, error);
- every helper call (`DRV.post`, the alpha / Diagnostics calls) sends it as the body field `_action` (and
  `_actionWhat`, a short description such as `#btnSendHdr Send ▾`); the helper also takes an `X-OpenNova-Action`
  header. The helper removes both fields before handling the request, records the id on the `op` start / end and on
  every `tg` / `echo` / `junk` / `usb` / `http` / `udp` / `conn` / `err` / `mark` record it makes while serving it
  (threads the request starts too, `wirelog.bind`), and in its own log line (`[action id]`);
- steps that follow from it keep the id: promise callbacks keep the action they were set up in, `setTimeout` keeps it,
  `setInterval` runs as no action — so the monitor, the background search and the Diagnostics poll never land on a
  click, while a Send's chained calls all do.
In Tools ▸ Diagnostics, **All actions** filters by one action (newest first, with the number of records), and a row's
details link to "show only this action". REPORT.md has an **Actions** table (time, id, what, processor, frames sent /
got, web / discovery / USB / stray counts, errors, time taken, result incl. "REFUSED (read-only)") built from this
helper run's recordings, the writes table has the action of each write, and the timeline marks lines with `[action id]`
— e.g. "Send to H5 (action k3f9-42) → 1 812 frames sent / 1 812 got → 0 errors → ok".

## In the app: Tools ▸ Diagnostics
- Live list (once a second while the tab is shown), filters (text, link, action, kind, problems only), Pause, Note….
- Click a row: decoded fields, the matching request / reply, the bytes as a hex dump; REST calls show both bodies and
  the headers (a side-filed body: its first 64 KB and the file name; binary bodies as a hex dump); USB wrapper blocks
  show their tag / length / status (under Frames).
- Right panel: per link sent / received / errors / reply time (average, max), last error.
- Open a recording… (earlier ones and imported captures), Import capture… (.pcap / .pcapng), Download (.nwl),
  Wireshark .pcap, Wireshark plug-in, Folder.

## Wireshark
- **Plug-in** `tools/wireshark/novastar.lua` (also Tools ▸ Diagnostics ▸ Wireshark plug-in; rebuild with
  `python tools/build_wireshark.py`). Copy it into Wireshark's personal plugins folder (Help ▸ About Wireshark ▸ Folders
  ▸ Personal Lua Plugins; macOS `~/.local/lib/wireshark/plugins/`, Windows `%APPDATA%\Wireshark\plugins\`), restart
  Wireshark. It decodes TG frames on any TCP port (heuristic) and on 5200–5232 directly, and discovery on UDP 3800 / 5600
  / 54622. Filters: `novastar`, `novastar.addr == 0x02000001`, `novastar.status != 0`, `novastar.dev == 1`,
  `novastar.badsum`, `novastar.echo` (a request frame coming from the processor's port 5200–5232: an H echo).
- **Capturing on a Mac without Wireshark's GUI** (built-in tcpdump; find the interface with `ifconfig`, e.g. en7 for a
  USB Ethernet adapter):

  ```
  sudo tcpdump -i en7 -s 0 -w ~/Desktop/h-test.pcap host 192.168.0.10
  ```
  Ctrl+C to stop, then Tools ▸ Diagnostics ▸ Import capture…. `-s 0` keeps whole packets; `host` = the processor's IP.
- **Pitfalls that make a capture "miss stuff":** the wrong interface (Wi-Fi instead of the H's Ethernet), starting it
  after the action, a capture filter that's too narrow (use only `host <ip>`), or a switch between the computer and the
  processor while capturing on a third computer (it only sees its own traffic without a mirror port).
- Import reassembles TCP in order, drops retransmissions, marks gaps ("capture gap: N bytes missing"), and decodes
  NovaStar frames on any port; HTTP request / status lines on other streams are listed. The processor is the side on
  TCP 5200–5232 (else the side the first request went to); request frames from it are echoes.

## Tests
`python -I tools/test_wirelog.py`: a real TcpLink against a stand-in processor (good / stale / status / silent replies,
refused connection), the file on disk, `.pcap` export → import, pcapng, a frame split over packets with a retransmission;
an H-like stand-in that echoes (broadcast, missing sending card), late replies, old recordings' junk sorted out (and the
user's real H recordings when `../OpenNova-20261011` is there, read only), helper bugs and USB / serial links in the
`.pcap`, the register names (JSON up to date with the doc, no malformed names, packed rows expanded, plug-in in step).
`python -I -X utf8 tools/test_recorder_complete.py`: a 10 MB REST body each way through the COEX client (side files byte
for byte, sha256, headers, whole in the `.pcap`), a 60 KB discovery reply through novalink's real discovery on loopback
(whole in the record and back from the `.pcap`), stray bytes whole, USB wrapper blocks, the action id on every record
(also in a thread), timestamps when the wall clock goes back an hour, a disk-full write failure (visible in status and in
every helper answer, nothing lost after recovery, in order), rotation within one second and retention over `keepMB`
never dropping this run's files. The app side of the action id: `app/tests/app_test.html` (actions).

## The alpha build
An early alpha goes to many testers with different processors (NovaLCT family incl. H / VX / MCTRL, Unico VX Pro, COEX
MX …). Testers read `README-ALPHA.md` (source: `docs/README-ALPHA.md`). The pieces (`tools/alpha.py`, `app/js/app-alpha.js`):

- **One version source:** `app/version.json` `{version, build, channel, readOnly, unlock, reportContact, keepDays, keepMB}`.
  Shown in the window title, Help ▸ About, the browser log (`app_version`), the server log (`server_start.version`), the
  first line of every helper log (`novalink_logs/YYYYMMDD.txt`) and recording (a `mark` with source `header`), the support
  bundle and every report. `reportContact` = where testers send reports (fill it in before packaging, or `--contact`).
- **Alpha mode:** `channel: "alpha"` (the packaged version.json) or `opennova.py --alpha` (env `OPENNOVA_ALPHA=1`).
  Then: the recorder can't be switched off (Diagnostics ▸ Record is refused); recordings and helper logs older than
  `keepDays`, then the oldest over `keepMB`, are removed at start and every 6 h (only in alpha mode); the first start
  shows a one-screen intro (what is recorded, nothing is sent, no passwords; optional name / contact, kept in
  `alpha-settings.json` next to the app); a **Report** button and a **Read-only** badge on the menu bar's right.
- **Read-only until unlocked (alpha, `readOnly: true`) — every write needs the code** (user, 2026-10-28: "we need every
  save or send what have you to be password protected"). `alpha.classify` is default-deny: a request is a *read* only
  when its route is on the `READ` allowlist (discover, info, detect, health, read-backs, card identity for the file
  guard, colour / screen reads, presets / schedules lists, the H web login / info, and local routes that never reach a
  processor: simulate, VMP project, support bundle, report, `diag/`, `alpha/`, `rcv/`, `vendor/`), or a `READ_WHEN`
  route with its read value (`/api/hw/calib` op `read`; `/api/hw/proxy` off), or a `/api/hw/run` plan whose every op is
  a read (`note`, `sleep`, `r`, `stash`). Everything else is a *write*, including a route or plan op added later and not
  listed: Send, Save, Send backup, blackout / freeze / normal, test patterns, identify on the wall, mapping, the error
  Clear's counter reset (rx 0x01000076 ← 05, COEX errorbit DELETE), colour / gamma / low latency (live too), service,
  calibration changes, .rcfgx / NCP, presets, schedules, backup verify, starting the proxy port. There is no
  "visible only" tier any more. (Detect itself starts with NovaLCT's broadcast "arrange addresses", rx 0x01000000 = 00,
  and Unico / COEX detect ask for a cabinet refresh, as their own apps do on connect; detect stays a read as asked.)
  Writes are refused by the helper (`{ok:false, readOnly:true}`, a `mark` "Refused (read-only alpha)" with the action)
  unless the request carries `alphaUnlock` = the send token, and refused in the app before any call (the app then tells
  the helper, `/api/hw/alpha/refused`, so the refusal is in the recording and the report too); greyed in the app with the
  tooltip "Writing to processors is off in this alpha — Settings ▸ Alpha ▸ Allow sending" (Send, Save, Screen Settings
  Apply, scenes, blackout / freeze / normal, the Test menu, the dashboard's show buttons, service, calibration). The
  Monitor's Clear stays clickable: it clears Open Nova's own error list, and says the processor's counters were not
  reset. Live colour controls stay editable in the project; each live send is refused with a message.
  **Unlock:** `unlock = {salt, sha256: SHA-256(salt + code), tokenSha256: SHA-256(SHA-256(salt + code + "|send"))}`. The
  browser checks the typed code against `sha256`, then keeps the send token `SHA-256(salt + code + "|send")` (localStorage)
  and sends it with each write; the helper checks `SHA-256(token)` against `tokenSha256`. Reading version.json therefore
  gives no token that writes (only the code does; it is a speed bump against accidents, not a password). A package made before 2026-10-28 (no
  `tokenSha256`) still takes the old hash. A build packaged without a code (`--no-unlock-code`) never writes. Unlocked =
  this browser profile until Settings ▸ Alpha ▸ Lock again or a new version/build; each unlock / lock goes into the
  browser log and the recording (never the code or the token). Every write the helper sees or the app refuses is listed
  in the report (sent / refused / refused in the app, with its action id).
- **First contact:** a processor found whose model the catalogue doesn't know (unknown ModelID, Unico / COEX model id,
  H chassis), or a helper bug (an exception that isn't a device answer) → `diagnostics/<day>/first-contact/<time>_<key>.json`
  with the discovery entry, the info read (read-only) and every recorded record for that address; once per key a day.
- **Help ▸ Report a Problem…:** the tester's text + chosen parts → the helper makes `OpenNova-report-<version>-<date>-<model>.zip`
  in Downloads (else `Nova/reports`): `REPORT.md` (version, writing locked / unlocked and the writes of the session,
  ⚠ unknown models, system, processors found / in the project with model IDs, firmware and receiving cards, errors,
  the last 50 helper errors with tracebacks, connection timeline), `app/` (project, browser + server logs, state,
  per-processor read-backs incl. receiving cards with firmware), `recordings/` (this helper run), `logs/helper/`, and every
  file under the session subfolders `first-contact/` and `vendor/` of the day folders (`alpha.SESSION_DIRS`: a tool that
  writes session files there gets them into reports as they are; binary files go in unscrubbed). Passwords, tokens,
  logins, cookies are always scrubbed; *Anonymise* maps private IPv4 addresses to device-A, device-B … consistently over
  all files (also their ASCII inside hex dumps) and the home folder to `~`. Nothing is uploaded.
  After saving, the dialog shows the zip's path with **Show in folder** (`/api/hw/alpha/reveal`: Explorer selects it,
  Finder reveals it, Linux opens its folder; only a report this helper made, by name), **Copy issue text** (version, OS,
  browser, processors by model family, the error line, "Report zip attached" — addresses, serials, MACs, e-mails, paths and
  the project's names become placeholders) and a link to the GitHub issue page (only a link the tester opens).
- **Error caught → make a report?** (`app-alpha.js`): an unexpected error — a JS error, an unhandled promise failure (not
  "helper not running"), a helper bug (its HTTP 500 says `internal: true` with the traceback in `where`; a processor that
  didn't answer or answered with an error — LinkError, OSError, UnicoError, CoexError — is not one, `alpha.unexpected`) or
  a driver result flagged `internal` (`DRV.internal`, the `internal` event; a driver that didn't load) — shows "Something
  went wrong — Make a report / Dismiss" at the bottom, once per distinct error (kind + message + where thrown) a session,
  held back while a processor operation runs (`hw.busy`) or a send / report dialog is open, never focused. Logged:
  `error_prompt` (shown) and `error_prompt_choice`. Make a report opens Report a Problem with that error picked ("Error to
  report", also pickable from the menu); REPORT.md then starts with **Error that prompted this report**: time, action id,
  kind, message, stack, the app log of the 30 s before it under its action and the four before / one after (no action: the
  five before), and the helper's records of the same 30 s under those ids (the browser sends its clock with the report, so
  a browser on another computer still lines up).
- **Package:** `python tools/make_package.py --alpha [--contact ADDRESS]` → `dist/OpenNova-<version>-alpha.zip`; stamps
  channel alpha and build = `<date>-<8 hex of SHA-256 over the packaged files>`; adds README-ALPHA.md; no test pages,
  projects, data, recordings, samples or test data (refused if one slips in). **The unlock** (user, 2026-10-28: every
  alpha build uses the same simple code, a speed bump against accidental sends, not a real password): (1)
  `OPENNOVA_UNLOCK_CODE` when set (never printed or logged; a too-short one stops the build without showing it), else
  (2) the console prompt (twice, no echo) when `--unlock-code` is given, else (3) by default `tools/alpha_unlock.json`'s
  `unlock` — the shared code's salt + hashes made with `alpha.make_unlock` (the code itself is in no file; testers get it
  from whoever gave them the build). `--no-unlock-code` = a build that never writes to processors.
  **CI (GitHub Actions):** no secret needed — `python tools/make_package.py --alpha` takes the shared code's hashes.
  `OPENNOVA_REPORT_CONTACT` sets the contact (`--contact` wins). `SOURCE_DATE_EPOCH` fixes the build date and every file
  time in the zip. Python 3.9+ stdlib, paths relative to the checkout: the same on ubuntu-latest, windows-latest,
  macos-latest.
  (The build id hashes the files as checked out: keep line endings fixed, e.g. `.gitattributes` `* -text`, to get the
  same id on Windows runners.)
- Tests: `python -I -X utf8 tools/test_alpha.py` (default-deny policy, the gate end to end: every formerly "visible"
  action, the error Clear, live colour, the proxy and an unknown route refused while locked with nothing reaching the
  stand-in processor, the version.json hash refused as a token, a no-code build never writing; the action id from the
  request to its frames and into REPORT.md; report zip contents, scrubbing, anonymising, first contact, retention, the
  alpha package and its stamped version.json, the shared code's hashes by default, the code / contact from the
  environment and SOURCE_DATE_EPOCH),
  `app/tests/app_test.html` (the app side: SHA-256, policy, greyed buttons incl. blackout / Test, refusal without a
  processor call, the action id on helper calls; error caught → one notice, none for the same error again, Make a report
  preselects it, a helper 500 offered / a processor not answering not, the issue text without addresses / serials / names),
  `python -I -X utf8 tools/test_error_report.py` (expected vs internal errors, the 500 flag, REPORT.md's "Error that prompted
  this report" with only the 30 s / nearby actions, Show in folder per OS and the route).
