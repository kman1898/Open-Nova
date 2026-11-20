"""vendortap.py - Tools ▸ Vendor apps: learn how NovaStar's own apps (NovaLCT, VMP, Unico) talk to processors Open Nova
hasn't met yet (new models, features). Stdlib only; Mac, Windows, Linux. Docs: docs/VENDOR_CAPTURE.md.

User, 2026-10-28 (early alpha going to many testers): "what about a tool in it that will detect LCT, VMP and Unico to
diagnose what all they send and receive from there too".

Everything goes into the day's recording folder, diagnostics/<YYYY-MM-DD>/vendor/ (the session folder the problem report
carries whole, tools/alpha.py SESSION_DIRS): captures/ (Wireshark files + their .nwl), relay/ (the relay's .nwl).
The .nwl files are the recorder's own format (tools/wirelog.py): Tools ▸ Diagnostics opens them.

  detect()                 read-only: which vendor apps are installed / running, versions, whom they talk to; capture tools
  log_places() / report_logs(days, max_each, max_total)   the vendor apps' own log folders (real paths: LOG_PLACES), newest
                           first, capped, passwords / tokens / licence keys scrubbed -> [(name in the report, text)]
  capture_tools() / FILTERS / interfaces() / capture_start(...) / capture_stop()   Wireshark / dumpcap / tcpdump; a capture
                           is only started with dumpcap / tcpdump that run without elevation (nothing asks for admin)
  import_capture(name, bytes)   a .pcap / .pcapng -> vendor/captures/<time>_<name>.nwl (wirelog.from_capture) + the original
  relay_start(body) / relay_stop(kind) / relay_status()   EXPERIMENTAL: Open Nova stands in for the processor (answers the
                           vendor app's discovery from a relay address, forwards every byte unchanged to the real one and
                           records both directions). NovaLCT TG, Unico (HTTP + WebSocket), COEX / VMP (HTTP + WebSocket).
                           NovaLCT also to a USB-only controller (BridgeRelay: target usb: / serial:COMx, frames passed
                           over Open Nova's own link, the discovery answer made by the relay); bridge_targets() lists them
  report_md() / report_files(include_logs)   the problem report's section and files (tools/alpha.py build_report)
  handle(path, body)       /api/hw/vendor/* for the helper (tools/novalink.py)

Nothing here writes to a processor on its own. The relay passes on what the vendor app sends, unchanged, and nothing else;
Open Nova's own asks (discovery, a COEX device/hw read to learn the MAC) go through the recorder like every other call.
"""
import base64
import collections
import gzip
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import zlib

import wirelog

IS_WIN, IS_MAC = sys.platform == 'win32', sys.platform == 'darwin'
_lock = threading.Lock()

# ------------------------------------------------------------------ the vendor apps
# id, name, family, executables (lower case, as the process list shows them), installed-programs name, macOS bundle name
APPS = [
    {'id': 'novalct', 'name': 'NovaLCT', 'family': 'lct', 'exe': ['novalct.exe'], 'reg': r'^NovaLCT(?!\s*Lite)', 'mac': r'^NovaLCT'},
    {'id': 'novalct-lite', 'name': 'NovaLCT Lite', 'family': 'lct', 'exe': ['novalct lite.exe'], 'reg': r'^NovaLCT\s*Lite', 'mac': None},
    {'id': 'mars', 'name': 'MarsServerProvider', 'about': 'NovaLCT’s Mars server', 'family': 'lct', 'exe': ['marsserverprovider.exe'], 'reg': None, 'mac': None},
    {'id': 'lct-monitor', 'name': 'NovaLCT monitoring', 'about': 'LCT XCenter, MonitorDaemon', 'family': 'lct',
     'exe': ['lct_xcenter.exe', 'monitordaemon.exe', 'novamonitormanager.exe'], 'reg': None, 'mac': None},
    {'id': 'vmp', 'name': 'VMP', 'family': 'coex', 'exe': ['vmp.exe', 'vmp'], 'reg': r'\bVMP\b', 'mac': r'^(Coex )?VMP'},
    {'id': 'xcenter', 'name': 'XCenter', 'about': 'VMP’s service', 'family': 'coex', 'exe': ['vmp_xcenter.exe', 'xcenter.exe', 'xcenter'], 'reg': None, 'mac': None},
    {'id': 'neocontroller', 'name': 'NeoController', 'about': 'the COEX controller program; VMP runs it as its offline emulator', 'family': 'coex',
     'exe': ['neocontroller.exe', 'neocontroller'], 'reg': None, 'mac': None},
    {'id': 'unico', 'name': 'Unico', 'family': 'unico', 'exe': ['unico.exe', 'unico'], 'reg': r'^Unico\b', 'mac': r'^Unico'},
    {'id': 'ucenter', 'name': 'UCenter', 'about': 'Unico’s service', 'family': 'unico', 'exe': ['ucenter_win.exe', 'ucenter.exe', 'ucenter', 'ucenter_mac'], 'reg': None, 'mac': None},
    {'id': 'userver', 'name': 'UServer', 'about': 'Unico’s device simulator', 'family': 'unico', 'exe': ['userver.exe', 'userver'], 'reg': None, 'mac': None},
]
# Where they install (seen on the VM 2026-10-28; NovaLCT installs per user under %APPDATA%), searched for the executables
INSTALL_DIRS_WIN = [r'%ProgramFiles%\Nova Star', r'%ProgramFiles(x86)%\Nova Star', r'%APPDATA%\Nova Star', r'%ProgramFiles%\UCenter',
                    r'%ProgramFiles%\NovaStar', r'%ProgramFiles(x86)%\NovaStar']
FAMILY_NAMES = {'lct': 'NovaLCT', 'unico': 'Unico', 'coex': 'VMP / COEX'}

# The vendor apps' own logs (real paths found on the VM 2026-10-28, docs/VENDOR_CAPTURE.md §2). macOS paths are guesses
# [I] until a tester's Mac shows them; a folder that isn't there is skipped.
LOG_PLACES = [
    ('NovaLCT', r'%APPDATA%\NovaLCT 2012\Config\LogInfo'),          # LCT\LCT.log, Monitor\Monitor.log*, MarsServer\Mars.log
    ('NovaLCT', r'%APPDATA%\Nova Star\NovaLCT\Bin\Log'),
    ('NovaLCT', r'%APPDATA%\LCT_XCenter\log'),                      # LCT's monitoring XCenter: xcenter.log, fiber*.log(.gz)
    ('NovaLCT', r'%ProgramData%\XCenter\log'),                      # marsproxy\marsproxy.log (large)
    ('NovaLCT Lite', r'%APPDATA%\Nova Star\NovaLCT Lite\Bin\Log'),
    ('VMP', r'%APPDATA%\NovaStar\VMP\log'),                         # vmp.log
    ('VMP', r'%ProgramData%\VMP_XCenter\log'),                      # xcenter.log, xcenter_panic.log, fiber.log
    ('VMP', r'%APPDATA%\VMP'),                                      # xserver140\<n>\userdata\log\controller\*.log (offline controllers)
    ('VMP', r'%ProgramFiles(x86)%\Nova Star\Coex VMP\Bin\Log'),
    ('Unico', r'%ProgramData%\Unico\log'),                          # ucenter\ucenter.log, unico\logs\*, userver\<sn>\*
    ('Unico', r'%APPDATA%\Unico\logs'),
    ('NovaStar test tool', r'%APPDATA%\NovaStar\testtool\log'),
    ('Unico', '~/Library/Logs/Unico'), ('Unico', '~/Library/Application Support/Unico/logs'), ('Unico', '~/Library/Application Support/UCenter/log'),
    ('VMP', '~/Library/Logs/VMP'), ('VMP', '~/Library/Application Support/NovaStar/VMP/log'), ('VMP', '~/Library/Application Support/VMP_XCenter/log'),
]
LOG_EXT = ('.log', '.txt', '.json', '.gz')
LOG_DAYS, LOG_EACH, LOG_TOTAL = 3, 4 * 1024 * 1024, 40 * 1024 * 1024

# Wireshark capture filters per family (ports: docs/HW_PROTOCOL.md §4.1, UNICO_PROTOCOL.md §1, VMP_PROTOCOL.md §1-2)
FILTERS = {
    'lct': 'udp port 3800 or tcp portrange 5200-5232',
    'unico': 'udp port 5600 or tcp port 8088 or tcp port 15200',
    'coex': 'udp portrange 54622-54624 or udp port 54700 or tcp port 8001 or tcp port 9001',
}
FILTERS['all'] = ' or '.join('(%s)' % FILTERS[k] for k in ('lct', 'unico', 'coex'))
IMPORT_MAX = 300 * 1024 * 1024


def vendor_dir(sub=''):
    """diagnostics/<today>/vendor[/sub] (made when asked for)."""
    d = os.path.join(wirelog.DIAG_DIR, time.strftime('%Y-%m-%d'), 'vendor', *([sub] if sub else []))
    os.makedirs(d, exist_ok=True)
    return d


def _rel(p):
    return os.path.relpath(p, wirelog.DIAG_DIR).replace('\\', '/')


def _safe(t, n=40):
    return re.sub(r'[^\w.-]+', '_', str(t or '')).strip('_.')[:n] or 'x'


def _run(cmd, timeout=10):
    """A read-only command's output ('' if it isn't there / fails). No window on Windows."""
    try:
        kw = {'creationflags': 0x08000000} if IS_WIN else {}          # CREATE_NO_WINDOW
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, **kw)
        b = r.stdout
    except (OSError, subprocess.SubprocessError):
        return ''
    for enc in ('utf-8', 'mbcs' if IS_WIN else 'latin1'):
        try: return b.decode(enc)
        except (UnicodeDecodeError, LookupError): continue
    return b.decode('latin1', 'replace')


def _expand(p):
    return os.path.expanduser(os.path.expandvars(p))


# ------------------------------------------------------------------ parsing (pure: unit-tested)
def version_from_name(name):
    """'NovaLCT V5.9.2' -> '5.9.2' (NovaLCT's and VMP's uninstall entries carry the version only in the name)."""
    m = re.search(r'\bV?(\d+(?:\.\d+){1,3})\b', str(name or ''), re.I)
    return m.group(1) if m else ''


def pe_version(data):
    """The version in a Windows executable's resources: ProductVersion text if there, else the fixed FileVersion. '' if none."""
    pv = data.find('ProductVersion\0'.encode('utf-16-le'))
    if pv >= 0:
        i = pv + 30
        while i < len(data) - 1 and data[i:i + 2] == b'\0\0': i += 2
        j = i
        while j < len(data) - 1 and data[j:j + 2] != b'\0\0' and j - i < 80: j += 2
        s = data[i:j].decode('utf-16-le', 'replace').strip()
        if re.match(r'^[\w.,\- ]{1,40}$', s) and re.search(r'\d', s): return s.replace(', ', '.').replace(',', '.')
    k = data.find(b'\xbd\x04\xef\xfe')                 # VS_FIXEDFILEINFO signature
    if k >= 0 and k + 16 <= len(data):
        ms, ls = struct.unpack_from('<II', data, k + 8)
        if ms or ls: return '%d.%d.%d.%d' % (ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF)
    return ''


def exe_version(path):
    """pe_version of a file: the whole file when small, else its first and last 8 MB (resources sit at the end)."""
    try:
        n = os.path.getsize(path)
        with open(path, 'rb') as f:
            if n <= 48 * 1024 * 1024: return pe_version(f.read())
            head = f.read(8 * 1024 * 1024); f.seek(n - 8 * 1024 * 1024); tail = f.read()
        return pe_version(tail) or pe_version(head)
    except OSError:
        return ''


def parse_tasklist(text):
    """`tasklist /FO CSV /NH` -> [{name, pid, session}]"""
    out = []
    for ln in text.splitlines():
        f = re.findall(r'"((?:[^"]|"")*)"', ln)
        if len(f) >= 2 and f[1].isdigit(): out.append({'name': f[0], 'pid': int(f[1]), 'session': f[2] if len(f) > 2 else ''})
    return out


def parse_ps(text):
    """`ps -axo pid=,comm=` (macOS / Linux) -> [{name, pid, path}]"""
    out = []
    for ln in text.splitlines():
        m = re.match(r'^\s*(\d+)\s+(.+?)\s*$', ln)
        if m: out.append({'pid': int(m.group(1)), 'path': m.group(2), 'name': os.path.basename(m.group(2))})
    return out


def parse_netstat(text):
    """`netstat -ano` (Windows) -> [{proto, local, remote, state, pid}]"""
    out = []
    for ln in text.splitlines():
        p = ln.split()
        if len(p) >= 4 and p[0] in ('TCP', 'UDP') and p[-1].isdigit():
            out.append({'proto': p[0].lower(), 'local': p[1], 'remote': p[2], 'state': p[3] if p[0] == 'TCP' and len(p) >= 5 else '', 'pid': int(p[-1])})
    return out


def parse_lsof(text):
    """`lsof -nP -i` (macOS) -> [{proto, local, remote, state, pid}]"""
    out = []
    for ln in text.splitlines()[1:]:
        p = ln.split()
        if len(p) < 9 or not p[1].isdigit(): continue
        name = ' '.join(p[8:]); st = re.search(r'\((\w+)\)', name)
        a = name.split(' ')[0]; loc, _, rem = a.partition('->')
        out.append({'proto': p[7].lower(), 'local': loc, 'remote': rem, 'state': st.group(1) if st else '', 'pid': int(p[1])})
    return out


def parse_dumpcap_list(text):
    """`dumpcap -D` -> [{n, name, desc}] ('1. \\Device\\NPF_{…} (Ethernet0)' / '1. en0 [Up, Running]')"""
    out = []
    for ln in text.splitlines():
        m = re.match(r'^\s*(\d+)\.\s+(\S+)(?:\s+\((.*)\))?(?:\s+\[(.*)\])?\s*$', ln)
        if m: out.append({'n': int(m.group(1)), 'name': m.group(2), 'desc': m.group(3) or m.group(4) or ''})
    return out


def _endpoint(s):
    h, _, p = str(s).rpartition(':')
    return h.strip('[]'), p


def _talks(conns, pids):
    """Who these processes talk to: established / opening TCP connections to other computers, and the ports they listen on."""
    to, listen = [], []
    for c in conns:
        if c['pid'] not in pids: continue
        h, p = _endpoint(c['remote'])
        if c['proto'].startswith('tcp') and c['state'] in ('ESTABLISHED', 'SYN_SENT') and h and not h.startswith('127.') and h not in ('::1', '0.0.0.0', '*'):
            if '%s:%s' % (h, p) not in to: to.append('%s:%s' % (h, p))
        elif c['proto'].startswith('tcp') and c['state'] in ('LISTENING', 'LISTEN'):
            lp = _endpoint(c['local'])[1]
            if lp and lp not in listen: listen.append(lp)
    return to[:20], sorted(listen, key=lambda x: int(x) if x.isdigit() else 0)[:20]


def _base(p):
    """The file name of a path in either form (a Windows path read on macOS / Linux too)."""
    return re.split(r'[\\/]', p or '')[-1]


def match_apps(installed, exes, procs, conns, services=()):
    """Put the pieces together per app: installed = [{name, version, location, publisher}] (installed-programs list / app
    bundles), exes = [path], procs = [{name, pid}], services = [{name, path, state}] -> [app rows] (only apps seen at all)."""
    out = []
    for a in APPS:
        row = {'id': a['id'], 'name': a['name'], 'about': a.get('about', ''), 'family': a['family'], 'installed': False, 'version': '', 'path': '', 'running': [],
               'service': '', 'talksTo': [], 'listens': []}
        for e in installed:
            if a['reg'] and re.search(a['reg'], e.get('name', ''), re.I) and re.search(r'nova|诺瓦|西安', (e.get('publisher') or '') + e.get('name', ''), re.I) \
                    or a['mac'] and e.get('bundle') and re.search(a['mac'], e['name'], re.I):
                row.update(installed=True, version=e.get('version') or version_from_name(e.get('name')), path=e.get('location') or row['path'],
                           seenAs=e.get('name'))
                break
        for p in exes:
            if _base(p).lower() in a['exe']:
                row['installed'] = True
                if not row['path'] or not row['path'].lower().endswith('.exe'): row['path'] = p
                break
        for s in services:
            if _base(s.get('path', '')).lower() in a['exe']:
                row['installed'] = True; row['service'] = '%s (%s)' % (s['name'], s.get('state') or 'service'); row['path'] = s['path']   # the one that runs
        row['running'] = sorted(p['pid'] for p in procs if p['name'].lower() in a['exe'])
        if row['running']: row['talksTo'], row['listens'] = _talks(conns, set(row['running']))
        if row['installed'] or row['running']: out.append(row)
    return out


# ------------------------------------------------------------------ detection (read-only)
def _win_installed():
    import winreg
    out = []
    for hive, key in ((winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'),
                      (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'),
                      (winreg.HKEY_CURRENT_USER, r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')):
        try: k = winreg.OpenKey(hive, key)
        except OSError: continue
        for i in range(winreg.QueryInfoKey(k)[0]):
            try:
                sk = winreg.OpenKey(k, winreg.EnumKey(k, i))
                def v(n):
                    try: return str(winreg.QueryValueEx(sk, n)[0] or '')
                    except OSError: return ''
                e = {'name': v('DisplayName'), 'version': v('DisplayVersion'), 'location': v('InstallLocation'), 'publisher': v('Publisher')}
                if e['name']: out.append(e)
            except OSError:
                continue
    return out


def _win_services():
    import winreg
    out, rx = [], re.compile('|'.join(re.escape(x) for a in APPS for x in a['exe'] if x.endswith('.exe')), re.I)
    try: k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Services')
    except OSError: return out
    for i in range(winreg.QueryInfoKey(k)[0]):
        try:
            n = winreg.EnumKey(k, i); sk = winreg.OpenKey(k, n)
            ip = str(winreg.QueryValueEx(sk, 'ImagePath')[0] or '')
        except OSError:
            continue
        if rx.search(ip):
            m = re.match(r'^\s*"([^"]+)"|^\s*(\S+\.exe)', ip, re.I)
            out.append({'name': n, 'path': (m.group(1) or m.group(2)) if m else ip, 'state': ''})
    st = _run(['sc', 'query', 'type=', 'service', 'state=', 'all'], 10)
    for s in out:
        m = re.search(r'SERVICE_NAME:\s*%s\s.*?STATE\s*:\s*\d+\s+(\w+)' % re.escape(s['name']), st, re.S | re.I)
        if m: s['state'] = m.group(1).lower()
    return out


def _win_exes():
    out, want = [], set(x for a in APPS for x in a['exe'] if x.endswith('.exe'))
    for d in INSTALL_DIRS_WIN:
        d = _expand(d)
        if not os.path.isdir(d) or '%' in d: continue
        for root, dirs, fs in os.walk(d):
            if root[len(d):].count(os.sep) >= 5: dirs[:] = []
            for f in fs:
                if f.lower() in want: out.append(os.path.join(root, f))
    return out


def _mac_installed():
    import plistlib
    out = []
    for base in ('/Applications', os.path.expanduser('~/Applications')):
        try: names = os.listdir(base)
        except OSError: continue
        for n in names:
            if not n.endswith('.app') or not re.search(r'nova|vmp|unico|ucenter|xcenter', n, re.I): continue
            e = {'name': n[:-4], 'version': '', 'location': os.path.join(base, n), 'publisher': 'NovaStar', 'bundle': True}
            try:
                with open(os.path.join(base, n, 'Contents', 'Info.plist'), 'rb') as f: pl = plistlib.load(f)
                e['version'] = str(pl.get('CFBundleShortVersionString') or pl.get('CFBundleVersion') or '')
            except (OSError, ValueError, Exception):  # noqa: BLE001 - a broken plist is just "no version"
                pass
            out.append(e)
    return out


_cache = {'t': 0, 'v': None}


def detect(refresh=False):
    """Installed and running vendor apps with versions, whom they talk to, and the capture tools. Cached 20 s."""
    with _lock:
        if not refresh and _cache['v'] and time.time() - _cache['t'] < 20: return _cache['v']
    installed, exes, procs, conns, services, note = [], [], [], [], [], ''
    if IS_WIN:
        installed, services, exes = _win_installed(), _win_services(), _win_exes()
        procs = parse_tasklist(_run(['tasklist', '/FO', 'CSV', '/NH'], 15))
        conns = parse_netstat(_run(['netstat', '-ano'], 15))
    elif IS_MAC:
        installed = _mac_installed()
        procs = parse_ps(_run(['ps', '-axo', 'pid=,comm='], 10))
        conns = parse_lsof(_run(['lsof', '-nP', '-i'], 15))
    else:
        procs = parse_ps(_run(['ps', '-eo', 'pid=,comm='], 10))
        note = 'NovaStar’s apps run on Windows and macOS; on Linux only captures and the relay are useful.'
    apps = match_apps(installed, exes, procs, conns, services)
    for a in apps:
        a['version'] = re.sub(r'^[Vv](?=\d)', '', a['version'])
        if IS_WIN and not a['version'] and a['path'].lower().endswith('.exe'): a['version'] = exe_version(a['path'])
        elif IS_WIN and a['path'].lower().endswith('.exe') and a['id'] not in ('novalct', 'vmp', 'unico', 'novalct-lite'):
            a['version'] = exe_version(a['path']) or a['version']
    r = {'ok': True, 'when': time.strftime('%Y-%m-%d %H:%M:%S'), 'platform': sys.platform, 'apps': apps, 'capture': capture_tools(),
         'filters': FILTERS, 'vendorDir': _rel(vendor_dir()), 'note': note, 'relays': relay_status()['relays'], 'relayIp': RELAY_IP}
    with _lock: _cache.update(t=time.time(), v=r)
    return r


# ------------------------------------------------------------------ the vendor apps' own logs
_SECRET = r'(?:[A-Za-z_]*?(?:password|passwd|pwd|passcode|token|secret|authorization|api_?key|access_?key|session_?id|cookie|' \
          r'licen[cs]e_?(?:key|code|no|number)|serial_?key|activation_?code|unlock_?code)|licen[cs]e)'
_SCRUB = [
    # "password":"…" / \"token\":\"…\" (JSON, also inside an escaped string)
    (re.compile(r'(\\?"%s\\?"\s*:\s*\\?")((?:[^"\\]|\\[^"])+)(\\?")' % _SECRET, re.I), r'\1<hidden>\3'),
    # password=… / token: … / Token:fake-… (key=value, headers, Go structs); the key must end the word ("TokenAuthenticator" stays)
    (re.compile(r'(\b%s\b\s*[=:]\s*)(?!<hidden>)((?:Bearer\s+|Basic\s+)?[^\s,;&"\'<>(){}\[\]]{2,})' % _SECRET, re.I), r'\1<hidden>'),
    (re.compile(r'(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}', re.I), r'\1<hidden>'),
    # prose: "token store successful:fake-43f6…" (UCenter) — a secret word, a few words, then : or = and a value
    (re.compile(r'(\b(?:token|password|passwd|secret)\b[^\n:="]{1,30}?[:=]\s*)(?!<hidden>)([^\s,;&"\'<>(){}\[\]]{4,})', re.I), r'\1<hidden>'),
]


def scrub(t):
    """Passwords, tokens, licence keys hidden where they appear as key=value / key: value / "key":"value"."""
    for rx, rep in _SCRUB: t = rx.sub(rep, t)
    return t


def _text(b):
    if b[:2] in (b'\xff\xfe', b'\xfe\xff') or (len(b) > 64 and b[1:64:2].count(0) > 24):
        try: return b.decode('utf-16', 'replace')
        except UnicodeDecodeError: pass
    return b.decode('utf-8', 'replace')


def log_places(days=LOG_DAYS):
    """[{app, path, files, bytes, recent, recentBytes, newest}] of the log folders that exist here (read-only)."""
    out, cut = [], time.time() - days * 86400
    for app, p in LOG_PLACES:
        d = _expand(p)
        if '%' in d or not os.path.isdir(d): continue
        n = b = rn = rb = 0; newest = 0
        for f in _log_files(d):
            n += 1; b += f[2]; newest = max(newest, f[1])
            if f[1] >= cut: rn += 1; rb += f[2]
        out.append({'app': app, 'path': d, 'files': n, 'bytes': b, 'recent': rn, 'recentBytes': rb,
                    'newest': time.strftime('%Y-%m-%d %H:%M', time.localtime(newest)) if newest else ''})
    return out


def _log_files(d):
    """(path, mtime, size) of the log-like files under d (VMP's %APPDATA%\\VMP: only the controllers' userdata\\log)."""
    vmp_root = os.path.normcase(d).endswith(os.path.normcase(os.path.join('Roaming', 'VMP')))
    for root, dirs, fs in os.walk(d):
        if root[len(d):].count(os.sep) >= 6: dirs[:] = []
        if vmp_root and os.sep + 'log' not in root[len(d):] + os.sep: continue
        for f in fs:
            lf = f.lower()
            if not (lf.endswith(LOG_EXT) or re.search(r'\.log\.\d+$', lf)): continue
            p = os.path.join(root, f)
            try: st = os.stat(p)
            except OSError: continue
            yield p, st.st_mtime, st.st_size


def report_logs(days=LOG_DAYS, max_each=LOG_EACH, max_total=LOG_TOTAL, places=None):
    """The vendor apps' logs of the last `days` days for the problem report, newest first: [(name, text)] with
    'vendor/logs/<app>/<folder>/<path>' names, each the end of the file when over max_each (whole lines), up to max_total in
    all, scrubbed; plus vendor/logs/INDEX.md (what is in, what was cut or left out)."""
    cut, picked = time.time() - days * 86400, []
    for app, p in (places if places is not None else LOG_PLACES):
        d = _expand(p)
        if '%' in d or not os.path.isdir(d): continue
        for f, mt, n in _log_files(d):
            if mt >= cut and n > 0: picked.append((mt, app, d, f, n))
    picked.sort(reverse=True)
    out, idx, total = [], [], 0
    for mt, app, d, f, n in picked:
        top = os.path.normpath(d).replace('\\', '/').split('/')[-2:]          # "VMP_XCenter-log", "Unico-log" …: one folder per place
        name = 'vendor/logs/%s/%s/%s' % (_safe(app), _safe('-'.join(top)), os.path.relpath(f, d).replace('\\', '/'))
        when = time.strftime('%Y-%m-%d %H:%M', time.localtime(mt))
        if total >= max_total:
            idx.append('| %s | %s | %d | left out (the report’s share for logs, %d KB, is full) |' % (name, when, n, max_total >> 10)); continue
        try:
            if f.lower().endswith('.gz'):
                with gzip.open(f, 'rb') as g: b = g.read(64 * 1024 * 1024)
                name = name[:-3]
            else:
                with open(f, 'rb') as h:
                    if n > max_each: h.seek(n - max_each)
                    b = h.read(max_each)
        except (OSError, EOFError, zlib.error) as e:
            idx.append('| %s | %s | %d | unreadable: %s |' % (name, when, n, e)); continue
        keep = min(max_each, max_total - total); cut_ = len(b) > keep or n > max_each and not f.lower().endswith('.gz')
        full = len(b) > keep                               # this one fills the report's share: the rest is left out
        if full: b = b[-keep:]
        if cut_: b = b[b.find(b'\n') + 1:]
        t = scrub(_text(b)); total = max_total if full else total + len(b)
        out.append((name, t))
        idx.append('| %s | %s | %d | %s |' % (name, when, n, 'the last %d KB' % (len(b) >> 10) if cut_ else 'whole'))
    found = sorted(set(_expand(p) for _, p in (places if places is not None else LOG_PLACES) if os.path.isdir(_expand(p))))
    head = ['# NovaStar apps’ own logs', '', 'The last %d days, newest first, at most %d MB per file and %d MB in all; passwords, tokens and '
            'licence keys hidden.' % (days, max_each >> 20, max_total >> 20), '', 'Folders searched: ' + (', '.join(found) or 'none found'), '',
            '| File | Changed | Bytes | In the report |', '|---|---|---|---|']
    return [('vendor/logs/INDEX.md', '\n'.join(head + (idx or ['| (no log changed in that time) | | | |'])) + '\n')] + out


# ------------------------------------------------------------------ Wireshark / dumpcap / tcpdump
def capture_tools():
    """What can capture here: {wireshark, dumpcap, tshark, tcpdump: path|''; npcap: {installed, adminOnly}; bpf (macOS)}"""
    t = {'wireshark': '', 'dumpcap': '', 'tshark': '', 'tcpdump': '', 'npcap': None, 'bpfReadable': None}
    env = os.environ.get('OPENNOVA_DUMPCAP')
    if IS_WIN:
        for base in (r'%ProgramFiles%\Wireshark', r'%ProgramFiles(x86)%\Wireshark'):
            for k, f in (('wireshark', 'Wireshark.exe'), ('dumpcap', 'dumpcap.exe'), ('tshark', 'tshark.exe')):
                p = os.path.join(_expand(base), f)
                if not t[k] and os.path.isfile(p): t[k] = p
        np = {'installed': os.path.isfile(os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'Npcap', 'wpcap.dll')), 'adminOnly': None}
        try:
            import winreg
            k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Services\npcap\Parameters')
            np['installed'] = True
            try: np['adminOnly'] = bool(winreg.QueryValueEx(k, 'AdminOnly')[0])
            except OSError: pass
        except (OSError, ImportError):
            pass
        t['npcap'] = np
    elif IS_MAC:
        for k, f in (('wireshark', 'Wireshark'), ('dumpcap', 'dumpcap'), ('tshark', 'tshark')):
            p = '/Applications/Wireshark.app/Contents/MacOS/' + f
            if os.path.isfile(p): t[k] = p
        t['tcpdump'] = '/usr/sbin/tcpdump' if os.path.isfile('/usr/sbin/tcpdump') else ''
        t['bpfReadable'] = os.access('/dev/bpf0', os.R_OK)
        t['chmodBPF'] = os.path.isfile('/Library/LaunchDaemons/org.wireshark.ChmodBPF.plist')
    for k in ('dumpcap', 'tshark', 'tcpdump', 'wireshark'):
        if not t[k]: t[k] = shutil.which(k) or ''
    if env: t['dumpcap'] = env                            # tests: a stand-in dumpcap
    return t


def _dumpcap_cmd():
    p = capture_tools()['dumpcap']
    if not p: return None
    return [sys.executable, p] if p.endswith('.py') else [p]


def interfaces():
    cmd = _dumpcap_cmd()
    if not cmd: return {'ok': False, 'error': 'dumpcap (Wireshark) isn’t installed', 'interfaces': []}
    out = _run(cmd + ['-D'], 20)
    l = parse_dumpcap_list(out)
    return {'ok': bool(l), 'interfaces': l, 'error': '' if l else 'dumpcap listed no interfaces (it may need the capture driver / permission: see the steps)'}


_cap = {'proc': None, 'file': '', 'started': 0, 'iface': '', 'filter': '', 'log': ''}


def capture_start(iface, cfilter, minutes=30, max_mb=200):
    """dumpcap on one interface into vendor/captures/<time>_live.pcapng, stopping by itself after `minutes` or `max_mb`.
    Never elevated: when it can't open the interface, the error and the manual steps are the answer."""
    cmd = _dumpcap_cmd()
    if not cmd: return {'ok': False, 'error': 'dumpcap (Wireshark) isn’t installed — follow the steps instead'}
    with _lock:
        if _cap['proc'] and _cap['proc'].poll() is None: return {'ok': False, 'error': 'a capture is already running', 'capture': capture_status()}
    if not iface: return {'ok': False, 'error': 'pick an interface'}
    cfilter = str(cfilter or '').strip()
    if re.search(r'[;&|`$<>\n]', cfilter.replace(' or ', ' ').replace(' and ', ' ')): return {'ok': False, 'error': 'that capture filter has characters it can’t have'}
    path = os.path.join(vendor_dir('captures'), time.strftime('%H%M%S') + '_live.pcapng')
    args = cmd + ['-i', str(iface), '-w', path, '-q', '-a', 'duration:%d' % max(1, int(float(minutes or 30) * 60)), '-a', 'filesize:%d' % (int(max_mb) * 1024)]
    if cfilter: args[len(cmd):len(cmd)] = ['-f', cfilter]
    logp = path + '.dumpcap.txt'
    try:
        lf = open(logp, 'w', encoding='utf-8')
        kw = {'creationflags': 0x08000000} if IS_WIN else {}
        proc = subprocess.Popen(args, stdout=lf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, **kw)
    except OSError as e:
        return {'ok': False, 'error': 'dumpcap didn’t start: %s' % e}
    time.sleep(1.5)
    if proc.poll() is not None:
        lf.close()
        try: msg = open(logp, encoding='utf-8', errors='replace').read()[-600:]
        except OSError: msg = ''
        perm = re.search(r'permission|privilege|access is denied|not permitted|administrator|npcap', msg, re.I)
        return {'ok': False, 'error': 'dumpcap stopped at once: %s' % (msg.strip() or 'exit %s' % proc.returncode),
                'needsAdmin': bool(perm)}
    with _lock: _cap.update(proc=proc, file=path, started=time.time(), iface=str(iface), filter=cfilter, log=logp, lf=lf)
    wirelog.mark('Vendor capture started: dumpcap on %s, filter "%s" -> %s' % (iface, cfilter, _rel(path)), source='vendor')
    return {'ok': True, 'capture': capture_status()}


def capture_status():
    p = _cap['proc']
    if not p: return {'running': False}
    n = os.path.getsize(_cap['file']) if os.path.isfile(_cap['file']) else 0
    return {'running': p.poll() is None, 'file': _rel(_cap['file']), 'bytes': n, 'seconds': round(time.time() - _cap['started']),
            'iface': _cap['iface'], 'filter': _cap['filter']}


def capture_stop():
    """Stop dumpcap (the one this helper started) and add the file like an imported one."""
    with _lock: p, path = _cap['proc'], _cap['file']
    if not p: return {'ok': False, 'error': 'no capture was started here'}
    if p.poll() is None:
        p.terminate()
        try: p.wait(5)
        except subprocess.TimeoutExpired: p.kill()
    try: _cap.get('lf') and _cap['lf'].close()
    except OSError: pass
    with _lock: _cap['proc'] = None
    if not os.path.isfile(path) or os.path.getsize(path) < 32: return {'ok': False, 'error': 'the capture file is empty (nothing matched the filter?)'}
    with open(path, 'rb') as f: data = f.read()
    r = import_capture(os.path.basename(path), data, keep_original=False, original_path=path)
    wirelog.mark('Vendor capture stopped: %s (%d bytes)' % (_rel(path), len(data)), source='vendor')
    return r


def import_capture(name, data, keep_original=True, original_path=None, tag=None, head_text=None, base=None):
    """A Wireshark / tcpdump capture -> vendor/captures/<time>_<name>.nwl (decoded like the recorder's, wirelog.from_capture)
    and the original file next to it. -> {ok, nwl, original, total, kinds, links, protos}"""
    if len(data) > IMPORT_MAX: return {'ok': False, 'error': 'that capture is over %d MB: cut it in Wireshark (File ▸ Export Specified Packets)' % (IMPORT_MAX >> 20)}
    recs = wirelog.from_capture(data)                       # ValueError: not a capture
    d = vendor_dir('captures')
    base = base or time.strftime('%H%M%S_') + _safe(os.path.splitext(os.path.basename(str(name or 'capture')))[0], 50)
    orig = original_path
    if keep_original:
        ext = '.pcapng' if data[:4] == b'\x0a\x0d\x0d\x0a' else '.pcap'
        orig = os.path.join(d, base + ext)
        with open(orig, 'wb') as f: f.write(data)
    kinds, links, protos, parts = collections.Counter(), collections.Counter(), collections.Counter(), []
    head = {'seq': 0, 't': recs[0]['t'] if recs else time.time(), 'kind': 'mark', 'source': 'vendor',
            'text': head_text or 'Imported capture %s (%d bytes, %d records)' % (os.path.basename(str(name)), len(data), len(recs))}
    f, n = None, 0
    try:
        for r in [head] + recs:                             # parts of 12 MB, so each fits in a problem report
            if f is None or n > TAPE_ROTATE:
                if f: f.close()
                parts.append(os.path.join(d, base + ('' if not parts else '_%d' % (len(parts) + 1)) + '.nwl'))
                f, n = open(parts[-1], 'w', encoding='utf-8', newline='\n'), 0
            if r.get('kind') == 'http' and isinstance(r.get('url'), str): r['url'] = scrub(r['url'])
            if tag: tag(r)                                  # netcap: which program on this computer it was
            line = json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n'
            f.write(line); n += len(line)
            kinds[r['kind']] += 1
            if r.get('link'): links[r['link']] += 1
            if r.get('proto'): protos[r['proto']] += 1
    finally:
        if f: f.close()
    wirelog.mark('Vendor capture imported: %s -> %s (%d records)' % (name, _rel(parts[0]), len(recs)), source='vendor')
    return {'ok': True, 'nwl': _rel(parts[0]), 'parts': [_rel(p) for p in parts], 'original': _rel(orig) if orig else '', 'total': len(recs),
            'kinds': dict(kinds), 'links': dict(links.most_common(12)), 'protos': dict(protos)}


def vendor_files(days=3):
    """The files under vendor/ of the last `days` days: [{name (for Diagnostics ▸ open), size, mtime, kind}]"""
    out, cut = [], time.strftime('%Y-%m-%d', time.localtime(time.time() - days * 86400))
    if not os.path.isdir(wirelog.DIAG_DIR): return out
    for day in sorted(os.listdir(wirelog.DIAG_DIR), reverse=True):
        if not re.match(r'^\d{4}-\d\d-\d\d$', day) or day < cut: continue
        base = os.path.join(wirelog.DIAG_DIR, day, 'vendor')
        for root, _, fs in os.walk(base):
            for f in fs:
                p = os.path.join(root, f)
                try: st = os.stat(p)
                except OSError: continue
                out.append({'name': _rel(p), 'size': st.st_size, 'mtime': st.st_mtime,
                            'kind': 'recording' if f.endswith('.nwl') else 'capture' if f.endswith(('.pcap', '.pcapng')) else 'other'})
    return sorted(out, key=lambda x: -x['mtime'])


# ------------------------------------------------------------------ the relay (experimental)
NOVA_SEARCH = b'{"searchInfo":[],"advSearchInfo":{"brand":{},"serial":{},"modelId":{}}}'
TAPE_ROTATE, TAPE_MAX = 12 * 1024 * 1024, 400 * 1024 * 1024   # bodies over 4 MB go to side files (wirelog._body), not into this
RELAY_IP = '127.0.0.42' if not IS_MAC else '127.0.0.1'   # Windows / Linux: any 127.x is this computer; macOS has 127.0.0.1 only
DISC_PORT = {'lct': 3800, 'unico': 5600}
DEF_PORTS = {'lct': [5200], 'unico': [8088], 'coex': [8001]}


def _crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8): crc = (crc >> 1) ^ 0x8408 if crc & 1 else crc >> 1
    return (~crc) & 0xFFFF


def nova_frame(tlvs, seq=1, response=False):
    """A NOVA "uniform" frame (Unico discovery / WebSocket, docs/UNICO_PROTOCOL.md §1): [(cmd, err, data)] -> bytes"""
    body = bytearray(struct.pack('<I', seq | (0x80000000 if response else 0))) + struct.pack('<HHBB', 1, 0, 0, 0)
    for cmd, err, data in tlvs:
        n = len(data); body += struct.pack('<IHH', cmd, (err or (n >> 16)) & 0xFFFF, n & 0xFFFF) + data
    head = bytearray(b'NOVA') + bytes([0, 1]) + struct.pack('<IIHH', 0, 0, len(body) >> 16, len(body) & 0xFFFF)
    head += struct.pack('<H', _crc16(body)); head += struct.pack('<H', _crc16(head[:20]))
    return bytes(head + body)


def nova_decode(buf):
    """-> {seq, response, tlvs: [(cmd, err, data)]} or None"""
    if len(buf) < 32 or buf[:4] != b'NOVA': return None
    blen = (struct.unpack_from('<H', buf, 14)[0] << 16) | struct.unpack_from('<H', buf, 16)[0]
    body = buf[22:22 + blen]; i = 10; tlvs = []
    while i + 8 <= len(body):
        cmd, hi, lo = struct.unpack_from('<IHH', body, i)
        n = lo | ((hi << 16) if tlvs else 0)
        tlvs.append((cmd, hi if not tlvs else 0, body[i + 8:i + 8 + n])); i += 8 + n
    s = struct.unpack_from('<I', body, 0)[0] if len(body) >= 4 else 0
    return {'seq': s & 0xFFFFFF, 'response': bool(s & 0x80000000), 'tlvs': tlvs}


def is_probe(kind, data):
    """A vendor app's discovery ask (not a device's answer)."""
    if kind == 'lct': return data.startswith(b'rqProMI')
    f = nova_decode(data)
    return bool(f and not f['response'] and any(c == 0x00010001 for c, _, _ in f['tlvs']))


def ports_from_reply(kind, data):
    """The TCP ports a device's discovery answer names: NovaLCT H_SUB_CARD tokens (else 5200); Unico http / websocket."""
    if kind == 'lct':
        if not data.startswith(b'rpProMI'): return []
        t = data[8:].decode('ascii', 'replace')
        return [int(x) for x in t.replace('H_SUB_CARD@^^@', '_').split('_') if len(x) == 4 and x.isdigit()] if 'H_SUB_CARD' in t else [5200]
    f = nova_decode(data)
    if not f or not f['tlvs']: return []
    try: j = json.loads(f['tlvs'][0][2].decode('utf-8', 'replace'))
    except ValueError: return []
    return sorted(set(int(p['port']) for p in j.get('protocols') or [] if p.get('linkType') in ('http', 'websocket') and str(p.get('port', '')).isdigit()))


_LOGIN = [(re.compile(r'("(?:user_?name|user|account|login_?name)"\s*:\s*")((?:[^"\\]|\\.)*)(")', re.I), r'\1<hidden>\3'),
          (re.compile(r'(\b(?:user_?name|user|account|login_?name)=)([^&\s]*)', re.I), r'\1<hidden>')]


def _is_login(first):
    """'POST /unico/v1/system/auth/login HTTP/1.1' -> True: its user name is masked too (a login is never recorded)."""
    return 'login' in (first.split(' ') + ['', ''])[1].lower()


def _masked(b, part, login=False):
    """Bytes for the relay's recording, whole (wirelog._body: UTF-8 text as text, else base64, over 4 MB a side file under
    <day>/bodies/), with only passwords / tokens / licence keys masked (scrub; on a login also the user name). Bytes that
    aren't UTF-8 are masked through their latin-1 view, so everything else stays byte for byte."""
    try: t, enc = b.decode('utf-8'), 'utf-8'
    except UnicodeDecodeError: t, enc = b.decode('latin1'), 'latin1'
    s = scrub(t)
    if login:
        for rx, rep in _LOGIN: s = rx.sub(rep, s)
    return wirelog._body(b if s == t else s.encode(enc), part)


def _bodytext(b, part='body', login=False):
    """An HTTP body for the record (_masked); a gzipped one is recorded unpacked, 'gzip' = its size on the wire."""
    if not b: return None
    z = None
    if b[:2] == b'\x1f\x8b':
        try: z, b = len(b), gzip.decompress(b)
        except (OSError, EOFError, zlib.error): z = None
    r = _masked(b, part, login)
    if z is not None: r['gzip'] = z
    return r


class Tape:
    """One relay session's recording: vendor/relay/<time>_<kind>_<target>.nwl (+ _2, _3 … every 12 MB), JSON lines in the
    recorder's format (tools/wirelog.py: tg / echo / junk / http / udp / conn / err / mark, plus ws). Everything whole, as
    wirelog records it: bodies over 4 MB in side files (<day>/bodies/), binary as base64; only passwords / tokens / logins
    masked. TAPE_MAX is a disk guard: past it a mark says so and the relay goes on unrecorded."""
    def __init__(self, kind, target):
        self.base = os.path.join(vendor_dir('relay'), time.strftime('%H%M%S_') + '%s_%s' % (kind, _safe(target, 30)))
        self.part, self.seq, self.bytes, self.total, self.full = 1, 0, 0, 0, False
        self.counts, self.files, self.lock = collections.Counter(), [], threading.Lock()
        self._open()

    def _open(self):
        p = self.base + ('' if self.part == 1 else '_%d' % self.part) + '.nwl'
        self.fh = open(p, 'a', encoding='utf-8', newline='\n'); self.files.append(p); self.bytes = 0

    def rec(self, kind, **f):
        with self.lock:
            self.seq += 1; self.counts[kind] += 1
            r = {'seq': self.seq, 't': round(time.time(), 6), 'kind': kind}; r.update(f)
            if self.full or self.fh is None: return r
            line = json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n'
            try:
                if self.bytes + len(line) > TAPE_ROTATE:
                    self.fh.close(); self.part += 1; self._open()
                self.fh.write(line); self.fh.flush(); self.bytes += len(line); self.total += len(line)
                if self.total > TAPE_MAX:
                    self.full = True
                    self.fh.write(json.dumps({'seq': self.seq + 1, 't': time.time(), 'kind': 'mark', 'source': 'vendor',
                                              'text': 'Recording full (%d MB): the relay goes on, unrecorded' % (TAPE_MAX >> 20)}) + '\n'); self.fh.flush()
            except OSError:
                self.counts['write_error'] += 1
            return r

    def close(self):
        with self.lock:
            if self.fh: self.fh.close(); self.fh = None


class TgSide:
    """One direction of a NovaLCT-protocol TCP stream -> tg / echo / junk records (the bytes themselves are already passed on)."""
    def __init__(self, conn, direction):
        self.c, self.dir, self.buf = conn, direction, b''

    def feed(self, data):
        self.buf += data; b = self.buf; c = self.c
        while True:
            i = min([x for x in (b.find(b'\x55\xAA'), b.find(b'\xAA\x55')) if x >= 0], default=-1)
            if i < 0:
                keep = 1 if b[-1:] in (b'\x55', b'\xAA') else 0
                if len(b) - keep > 0: self._junk(b[:len(b) - keep])
                b = b[len(b) - keep:]; break
            if i: self._junk(b[:i]); b = b[i:]
            if len(b) < 20: break
            n = wirelog.frame_data_len(b[:20])
            if n > 65000: self._junk(b[:1]); b = b[1:]; continue
            if len(b) < 20 + n: break
            fr = b[:20 + n]
            if struct.unpack_from('<H', fr, 18 + n)[0] != (0x5555 + sum(fr[2:18 + n])) & 0xFFFF:
                self._junk(b[:1]); b = b[1:]; continue
            b = b[20 + n:]
            self._frame(fr)
        self.buf = b

    def _junk(self, b, why=''):
        if b: self.c.tape.rec('junk', link=self.c.link, hex=b.hex(), n=len(b), note='from the %s%s' % ('vendor app' if self.dir == 'tx' else 'processor', why))

    def close(self):
        """The connection ended: bytes still waiting to make a frame are recorded too."""
        self._junk(self.buf, ', left when the connection closed'); self.buf = b''

    def _frame(self, fr):
        c, p = self.c, wirelog.decode(fr)
        if self.dir == 'rx' and fr[0] == 0x55:            # a request coming back from the processor (an echo)
            r = wirelog._echo_rec(c.link, fr, list(c.sent)); c.tape.rec('echo', **r); return
        r = {'link': c.link, 'dir': self.dir, 'hex': fr.hex()}
        if p: r['d'] = p[0]; r['sum'] = wirelog.summary(*p)
        with c.lock:
            if p and self.dir == 'tx': c.pend[p[0]['serial']] = time.time()
            elif p and p[0]['serial'] in c.pend: r['rtt'] = round((time.time() - c.pend.pop(p[0]['serial'])) * 1000, 2)
        x = c.tape.rec('tg', **r)
        if self.dir == 'tx': c.sent.append((x['seq'], fr))


class HttpSide:
    """One direction of an HTTP/1.1 stream -> http records (request paired with its response), then WebSocket frames -> ws."""
    def __init__(self, conn, direction):
        self.c, self.dir, self.buf, self.msg = conn, direction, b'', None

    def feed(self, data):
        self.buf += data
        while True:
            if self.c.ws: return self._ws()
            if self.msg is None:
                i = self.buf.find(b'\r\n\r\n')
                if i < 0:                                  # no header end within 64 KB: not HTTP (recorded whole as junk)
                    if len(self.buf) > 65536: self.c.tape.rec('junk', link=self.c.link, hex=self.buf.hex(), n=len(self.buf), note='not HTTP'); self.buf = b''
                    return
                lines = self.buf[:i].decode('latin1').split('\r\n'); self.buf = self.buf[i + 4:]
                hdr, pairs = {}, []
                for ln in lines[1:]:
                    k, _, v = ln.partition(':'); hdr[k.strip().lower()] = v.strip(); pairs.append((k.strip(), v.strip()))
                m = {'first': lines[0], 'hdr': hdr, 'pairs': pairs, 't': time.time(), 'body': [], 'n': 0, 'chunk': None}
                if self.dir == 'rx':
                    try: st = int(lines[0].split(' ')[1])
                    except (IndexError, ValueError): st = 0
                    m['status'] = st
                    with self.c.lock: head = self.c.queue[0]['first'].startswith('HEAD ') if self.c.queue else False
                    if st in (101, 204, 304) or 100 <= st < 200 or head: m['len'] = 0
                if 'len' not in m:
                    if 'chunked' in hdr.get('transfer-encoding', '').lower(): m['len'] = 'chunked'
                    elif hdr.get('content-length', '').isdigit(): m['len'] = int(hdr['content-length'])
                    else: m['len'] = None if self.dir == 'rx' else 0      # a response without a length runs to the close
                self.msg = m
            m = self.msg
            if m['len'] == 'chunked':
                while True:
                    if m['chunk'] is None:
                        j = self.buf.find(b'\r\n')
                        if j < 0: return
                        try: m['chunk'] = int(self.buf[:j].split(b';')[0].strip() or b'0', 16)
                        except ValueError: m['chunk'] = 0
                        self.buf = self.buf[j + 2:]
                    if m['chunk'] == 0:
                        if self.buf.startswith(b'\r\n'): self.buf = self.buf[2:]
                        else:
                            j = self.buf.find(b'\r\n\r\n')
                            if j < 0: return
                            self.buf = self.buf[j + 4:]
                        break
                    if len(self.buf) < m['chunk'] + 2: return
                    self._add(self.buf[:m['chunk']]); self.buf = self.buf[m['chunk'] + 2:]; m['chunk'] = None
            elif m['len'] is None:
                self._add(self.buf); self.buf = b''; return
            else:
                take = min(len(self.buf), m['len'] - m['n']); self._add(self.buf[:take]); self.buf = self.buf[take:]
                if m['n'] < m['len']: return
            self._done()

    def _add(self, b):
        m = self.msg; m['n'] += len(b)
        if b: m['body'].append(b)                          # the whole body (joined once, in _done)

    def close(self):
        """The connection ended: a body that runs to the close, an unfinished message and bytes that never made one (or a
        WebSocket frame cut off) are recorded too."""
        if self.msg is not None:
            if self.msg['len'] is not None: self.msg['incomplete'] = True
            self._done()
        if self.buf and self.c.ws: self._ws()           # frames that came before the 101 was seen on the other side
        if self.buf:
            self.c.tape.rec('junk', link=self.c.link, hex=self.buf.hex(), n=len(self.buf),
                            note='from the %s, left when the connection closed' % ('vendor app' if self.dir == 'tx' else 'processor'))
            self.buf = b''

    def _done(self):
        m, c = self.msg, self.c; self.msg = None
        if self.dir == 'tx': login = _is_login(m['first'])
        else:
            with c.lock: q = c.queue.popleft() if c.queue else None
            login = bool(q) and _is_login(q['first'])
        body = _bodytext(b''.join(m['body']), 'req' if self.dir == 'tx' else 'resp', login); m['body'] = None
        if m.get('incomplete'): body = dict(body or {'n': 0}, incomplete=True, expected=m['len'], got=m['n'])
        if self.dir == 'tx':
            with c.lock: c.queue.append(dict(m, bodyrec=body)); return
        _http_rec(c, q, m, body)
        if m.get('status') == 101: c.ws = True

    def _ws(self):
        b = self.buf
        while len(b) >= 2:
            op, n, o = b[0] & 0x0F, b[1] & 0x7F, 2
            if n == 126:
                if len(b) < 4: break
                n = struct.unpack_from('>H', b, 2)[0]; o = 4
            elif n == 127:
                if len(b) < 10: break
                n = struct.unpack_from('>Q', b, 2)[0]; o = 10
            mask = b''
            if b[1] & 0x80:
                if len(b) < o + 4: break
                mask = b[o:o + 4]; o += 4
            if len(b) < o + n: break
            pl = b[o:o + n]; b = b[o + n:]
            if mask: pl = bytes(x ^ mask[i % 4] for i, x in enumerate(pl))
            self._wsrec(op, pl)
        self.buf = b

    def _wsrec(self, op, pl):
        """Every frame, whole (pings / pongs too): text frames as 'text', others as 'data' (wirelog._body: base64 or a side
        file), close / ping / pong as 'hex'; a NOVA frame also decoded ('nova': [tag, text]). Secrets masked (_masked)."""
        c = self.c
        r = {'link': c.link, 'dir': self.dir, 'op': op, 'n': len(pl)}
        if op in (8, 9, 10):
            if pl: r['hex'] = pl.hex()
            return c.tape.rec('ws', **r)
        f = nova_decode(pl) if op == 2 else None
        if f: r['nova'] = [['0x%08X' % cmd, scrub(d.decode('utf-8', 'replace'))] for cmd, _, d in f['tlvs']]
        b = _masked(pl, 'ws') if pl else None
        if b and op == 1 and 'text' in b: r['text'] = b['text']          # inline, or the start of a side-filed one
        if b and (op != 1 or 'text' not in b or b.get('file')): r['data'] = b
        c.tape.rec('ws', **r)


def _http_rec(c, q, m=None, body=None, error=None):
    """One http record: the request q (its body already masked in 'bodyrec') with its answer m (None: none came), the
    headers both ways (wirelog.headers_of, plus anything scrub would hide)."""
    meth, _, rest = (q['first'] if q else '? ?').partition(' ')
    url = 'http://%s%s' % (c.link, rest.rsplit(' ', 1)[0] if rest else '')
    f = {'link': c.link, 'method': meth, 'url': scrub(url), 'req': q['bodyrec'] if q else None, 'status': m.get('status') if m else None,
         'resp': body, 'ms': round((m['t'] - q['t']) * 1000, 1) if q and m else 0, 'ctype': m['hdr'].get('content-type', '') if m else ''}
    for k, x in (('reqh', q), ('resph', m)):
        h = wirelog.headers_of(x['pairs']) if x and x.get('pairs') else None
        if h: f[k] = {n: v if v == '<hidden>' or scrub('%s: %s' % (n, v)) == '%s: %s' % (n, v) else '<hidden>' for n, v in h.items()}
    if error: f['error'] = error
    c.tape.rec('http', **f)


class Conn:
    def __init__(self, tape, link, proto):
        self.tape, self.link, self.lock = tape, link, threading.Lock()
        self.pend, self.sent, self.queue, self.ws = {}, collections.deque(maxlen=wirelog.SENT_KEEP), collections.deque(), False
        S = TgSide if proto == 'tg' else HttpSide
        self.sides = {'tx': S(self, 'tx'), 'rx': S(self, 'rx')}

    def close(self):
        """After both sides closed: requests that never got an answer are recorded too."""
        with self.lock: q = list(self.queue); self.queue.clear()
        for x in q: _http_rec(self, x, error='no answer before the connection closed')


class Relay:
    """Open Nova in the middle: the vendor app finds and connects to `relay_ip` (a loopback address on this computer, or an
    address of a second network adapter), every byte goes on to the processor unchanged and its answers come back unchanged.
    Both directions are recorded (Tape). NovaLCT: UDP 3800 discovery asks are passed to the processor and its answer is
    returned from relay_ip; the TCP ports it names (5200, or the H's 5201+) are listened on at relay_ip. Unico: the same on
    UDP 5600 / the HTTP + WebSocket port. COEX: XCenter is told about relay_ip:8001 (the controller's own announcement format)."""
    def __init__(self, kind, target, relay_ip=None, ports=None, discovery=True, disc_port=None, target_disc_port=None,
                 announce_to=None, coex_mac=None):
        if kind not in ('lct', 'unico', 'coex'): raise ValueError('kind is lct, unico or coex')
        self.kind, self.target, self.relay_ip = kind, str(target).strip(), str(relay_ip or RELAY_IP).strip()
        if not self.target or self.target in ('0.0.0.0', self.relay_ip): raise ValueError('the processor’s address is needed (not the relay’s own)')
        if self.relay_ip in ('0.0.0.0', '', '255.255.255.255'): raise ValueError('the relay needs one address of this computer')
        self.loop = self.relay_ip.startswith('127.')
        self.disc_port = int(disc_port or DISC_PORT.get(kind, 0)); self.tdisc = int(target_disc_port or self.disc_port)
        self.discovery, self.want_ports = bool(discovery) and kind != 'coex', [int(p) for p in ports or []]
        self.announce_to = announce_to; self.coex_mac = coex_mac
        self.tape = Tape(kind, self.target); self.socks, self.conns, self.stop_ev = [], [], threading.Event()
        self.st = {'clients': 0, 'opened': 0, 'up': 0, 'down': 0, 'probes': 0, 'answers': 0, 'announces': 0, 'errors': []}
        self.ports, self.started, self.notes, self.fwd = [], time.time(), [], set()   # fwd: our own pass-on sockets' ports

    # ---- start / stop
    def start(self):
        try: self._start()
        except Exception:
            self.stop(); raise
        return self

    def _start(self):
        self.tape.rec('mark', source='vendor', text='Relay %s: the vendor app -> %s -> %s (experimental)' % (FAMILY_NAMES[self.kind], self.relay_ip, self.target))
        ports = list(self.want_ports)
        if not ports and self.discovery:
            ports = self._learn_ports()
        if not ports: ports = list(DEF_PORTS[self.kind])
        for p in ports: self._listen(p)
        if not self.ports: raise OSError('the relay could not listen on %s (ports %s): %s' % (self.relay_ip, ports, '; '.join(self.st['errors'][-3:])))
        if self.discovery: self._disc_listen()
        if self.kind == 'coex': self._announce_start()
        wirelog.mark('Vendor relay %s started: %s:%s -> %s (recording %s)' % (self.kind, self.relay_ip, '+'.join(map(str, self.ports)), self.target, _rel(self.tape.files[0])), source='vendor')

    def stop(self):
        if self.stop_ev.is_set(): return
        self.stop_ev.set()
        for s in self.socks + [x for c in self.conns for x in c]:
            try: s.shutdown(socket.SHUT_RDWR)       # Linux: a listening socket closed while accept() waits keeps listening
            except OSError: pass
            try: s.close()
            except OSError: pass
        self.tape.rec('mark', source='vendor', text='Relay stopped')
        self.tape.close()
        wirelog.mark('Vendor relay %s stopped (%d connections, %d bytes up, %d down)' % (self.kind, self.st['opened'], self.st['up'], self.st['down']), source='vendor')

    def _err(self, text):
        self.st['errors'] = (self.st['errors'] + [text])[-10:]
        self.tape.rec('err', link=self.target, error=text)

    # ---- discovery
    def _learn_ports(self):
        """Ask the processor once (as the vendor app would): which TCP ports does it name? (also recorded by wirelog)"""
        probe = b'rqProMI:' if self.kind == 'lct' else nova_frame([(0x00010001, 0, NOVA_SEARCH)])
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.bind(('0.0.0.0', 0)); s.settimeout(0.3)
            s.sendto(probe, (self.target, self.tdisc)); wirelog.udp('tx', (self.target, self.tdisc), probe, self.kind if self.kind != 'lct' else 'nova')
            self.tape.rec('udp', dir='tx', peer='%s:%d' % (self.target, self.tdisc), hex=probe.hex(), n=len(probe), proto=self.kind, note='Open Nova’s own ask (to learn the ports)')
            end = time.time() + 2.0
            while time.time() < end:
                try: d, a = s.recvfrom(65536)
                except socket.timeout: continue
                except OSError: break
                if a[0] != self.target: continue
                wirelog.udp('rx', a, d, self.kind if self.kind != 'lct' else 'nova')
                self._udp_rec('rx', a, d)
                ps = ports_from_reply(self.kind, d)
                if ps: return ps
        except OSError as e:
            self._err('discovery ask failed: %s' % e)
        finally:
            s.close()
        self.notes.append('The processor didn’t answer discovery: listening on %s' % DEF_PORTS[self.kind])
        return []

    def _udp_rec(self, direction, peer, data, note='', **extra):
        """A discovery datagram, whole (as wirelog.udp: every byte as hex, also as text when it is text / a NOVA frame)."""
        f = {'dir': direction, 'peer': '%s:%s' % tuple(peer[:2]), 'hex': data.hex(), 'n': len(data), 'proto': self.kind}
        if data[:1] in (b'r', b'{'): f['text'] = data.decode('utf-8', 'replace')
        nf = nova_decode(data)
        if nf and nf['tlvs']: f['text'] = nf['tlvs'][0][2].decode('utf-8', 'replace')
        if note: f['note'] = note
        f.update(extra)
        self.tape.rec('udp', **f)

    def _disc_listen(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        try: s.bind(('0.0.0.0', self.disc_port))
        except OSError as e:
            self.notes.append('Discovery on UDP %d isn’t possible here (%s): the vendor app needs the relay address typed in' % (self.disc_port, e)); s.close(); return
        out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); out.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        out.bind((self.relay_ip, 0)); self.socks += [s, out]
        s.settimeout(0.5)

        def loop():
            while not self.stop_ev.is_set():
                try: d, a = s.recvfrom(65536)
                except socket.timeout: continue
                except ConnectionResetError: continue             # Windows: an ICMP "port unreachable" from an earlier send
                except OSError: return
                if not is_probe(self.kind, d) or a[0] == self.relay_ip or a[1] in self.fwd: continue   # never our own pass-on
                if self.loop != a[0].startswith('127.'): continue   # loopback relay: only this computer's vendor app
                self.st['probes'] += 1
                self._udp_rec('tx', a, d, note='the vendor app’s ask #%d, passed to %s' % (self.st['probes'], self.target))
                threading.Thread(target=self._forward_probe, args=(d, a, out), daemon=True).start()
        threading.Thread(target=loop, daemon=True).start()

    def _forward_probe(self, d, a, out):
        f = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); fp = None
        try:
            f.bind(('0.0.0.0', 0)); fp = f.getsockname()[1]; self.fwd.add(fp)
            f.settimeout(0.3); f.sendto(d, (self.target, self.tdisc))
            end = time.time() + 1.5
            while time.time() < end and not self.stop_ev.is_set():
                try: r, ra = f.recvfrom(65536)
                except socket.timeout: continue
                except ConnectionResetError: continue
                if ra[0] != self.target: continue
                out.sendto(r, a); self.st['answers'] += 1      # the processor's own answer, unchanged, from the relay address
                self._udp_rec('rx', ra, r, note='answer #%d, passed to %s:%d from %s' % (self.st['answers'], a[0], a[1], self.relay_ip))
                for p in ports_from_reply(self.kind, r):
                    if p not in self.ports: self._listen(p)     # an H that names another output card later
        except OSError as e:
            self._err('discovery pass-on failed: %s' % e)
        finally:
            f.close(); self.fwd.discard(fp)

    def _announce_start(self):
        """COEX: tell XCenter about relay_ip:<port> every 2 s, in the controllers' own format (VMP_PROTOCOL.md §1)."""
        mac = self.coex_mac
        if mac is None:
            try:
                import coexlink
                mac = (coexlink.Coex(self.target, self.ports[0], timeout=3).get('device/hw') or {}).get('mac') or ''
            except Exception as e:  # noqa: BLE001 - the relay still works, XCenter just has no MAC
                mac = ''; self._err('couldn’t read the controller’s MAC (device/hw): %s' % e)
        msg = json.dumps({'data': [{'apiPort': str(self.ports[0]), 'mac': mac, 'authType': 0, 'workMode': 0, 'https': ''}]}, separators=(',', ':')).encode()
        dests = self.announce_to or ([('127.0.0.1', 54622), ('127.0.0.1', 54623)] if self.loop else [('255.255.255.255', p) for p in (54622, 54623, 54624)])
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.bind((self.relay_ip, 0)); self.socks.append(s)
        self.tape.rec('udp', dir='tx', peer='%s:%d' % dests[0], hex=msg.hex(), n=len(msg), proto='coex', text=msg.decode(), note='the relay’s announcement (every 2 s) to %s' % ', '.join('%s:%d' % x for x in dests))

        def loop():
            while not self.stop_ev.is_set():
                for x in dests:
                    try: s.sendto(msg, x); self.st['announces'] += 1
                    except OSError: pass
                self.stop_ev.wait(2.0)
        threading.Thread(target=loop, daemon=True).start()

    # ---- TCP
    def _listen(self, port):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if IS_WIN and hasattr(socket, 'SO_EXCLUSIVEADDRUSE'): srv.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try: srv.bind((self.relay_ip, port)); srv.listen(8)
        except OSError as e:
            srv.close(); self.st['errors'].append('TCP %s:%d: %s' % (self.relay_ip, port, e)); return False
        self.socks.append(srv); self.ports.append(port)
        proto = 'tg' if self.kind == 'lct' or port == 15200 else 'http'
        srv.settimeout(0.5)

        def accept():
            while not self.stop_ev.is_set():
                try: c, peer = srv.accept()
                except socket.timeout: continue
                except OSError: return
                threading.Thread(target=self._client, args=(c, peer, port, proto), daemon=True).start()
        threading.Thread(target=accept, daemon=True).start()
        return True

    def _client(self, c, peer, port, proto):
        link = '%s:%d' % (self.target, port); via = 'relay %s:%d <- %s:%d' % (self.relay_ip, port, peer[0], peer[1])
        t0 = time.time()
        try: u = socket.create_connection((self.target, port), timeout=3)
        except OSError as e:
            self.tape.rec('conn', link=link, event='connect failed', error=str(e), via=via, ms=round((time.time() - t0) * 1000, 1))
            self._err('%s: can’t reach the processor: %s' % (link, e)); c.close(); return
        for s in (c, u):
            s.settimeout(None)
            try: s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError: pass
        pair = (c, u); self.conns.append(pair); self.st['clients'] += 1; self.st['opened'] += 1
        self.tape.rec('conn', link=link, event='open', via=via, ms=round((time.time() - t0) * 1000, 1))
        wirelog.mark('Vendor relay: %s connected through the relay (%s)' % (peer[0], link), source='vendor')
        cn = Conn(self.tape, link, proto)

        def pump(src, dst, side, key):
            while True:
                try: d = src.recv(65536)
                except OSError: d = None
                if not d:                                 # the end passes on as an end (half-close), an error closes both
                    try: dst.shutdown(socket.SHUT_WR) if d is not None else [x.close() for x in pair]
                    except OSError: pass
                    try: cn.sides[side].close()           # this side's leftover bytes, recorded now (not after the other end)
                    except Exception as e:  # noqa: BLE001
                        self.tape.rec('err', link=link, error='recorder: %s: %s' % (type(e).__name__, e))
                    return
                def record():                             # a recorder problem never touches the bytes
                    try: cn.sides[side].feed(d)
                    except Exception as e:  # noqa: BLE001
                        self.tape.rec('err', link=link, error='recorder: %s: %s' % (type(e).__name__, e))
                if side == 'tx': record()                 # a request is recorded before it leaves, so its echo / reply finds it
                try: dst.sendall(d)                       # passed on unchanged
                except OSError:
                    for x in pair: x.close()
                    return
                self.st[key] += len(d)
                if side != 'tx': record()                 # an answer: passed on first, then recorded
        t = threading.Thread(target=pump, args=(u, c, 'rx', 'down'), daemon=True); t.start()
        pump(c, u, 'tx', 'up'); t.join(10)                # the processor gets 10 s to finish after the vendor app's end
        for s in pair:
            try: s.close()
            except OSError: pass
        for sd in list(cn.sides.values()) + [cn]:      # what is still in the parsers, unanswered requests: recorded too
            try: sd.close()
            except Exception as e:  # noqa: BLE001
                self.tape.rec('err', link=link, error='recorder: %s: %s' % (type(e).__name__, e))
        self.st['clients'] -= 1
        if pair in self.conns: self.conns.remove(pair)
        self.tape.rec('conn', link=link, event='close', via=via)

    def status(self):
        return {'kind': self.kind, 'name': FAMILY_NAMES[self.kind], 'target': self.target, 'relayIp': self.relay_ip, 'ports': self.ports,
                'discovery': self.discovery, 'started': self.started, 'seconds': round(time.time() - self.started),
                'files': [_rel(p) for p in self.tape.files], 'counts': dict(self.tape.counts), 'notes': self.notes,
                'running': not self.stop_ev.is_set(), **{k: v for k, v in self.st.items()}}


# ------------------------------------------------------------------ the relay as a USB / COM bridge (NovaLCT only)
# A controller reached over USB only (NovaPro HD: no Ethernet port) or a USB COM port: NovaLCT connects to the relay over
# TCP, each TG request goes to the controller through Open Nova's own link (tools/novalink.py open_link: "usb:…" =
# NovaStar's USB device with LCT's USBC blocks, "serial:COMx" = a COM port) and the reply comes back on the TCP side. The
# frames are the same as over TCP (docs/USB_NOVA_DEVICE.md); the link gives each request its own serial number, so the
# reply goes back with NovaLCT's. Over USB there is no discovery answer to pass on: the relay makes NovaLCT's
# "rpProMI:" answer itself (recorded as made by the relay). Open Nova holds the device for as long as the relay runs, so
# NovaLCT reaches it through the relay only.
BRIDGE_WAIT = 2.0          # s a request waits for its reply over USB / COM (none: NovaLCT gets none either, as on the wire)
_MODELS = {}


def _links():
    """novalink, the helper's own copy: it runs as `python novalink.py` (__main__), and the relay must share its link pool
    (one connection per device, its lock), not open a second copy of the module with a pool of its own."""
    for m in (sys.modules.get('__main__'), sys.modules.get('novalink')):
        if m is not None and hasattr(m, 'open_link') and hasattr(m, 'usb_target'): return m
    import novalink
    return novalink


def bridge_target(t):
    """'USB' / 'usb:' / 'usb:0483:5720@1-3' -> 'usb:…'; 'COM3' / 'serial:COM3' / '/dev/cu.usbserial-1' -> 'serial:…'; else None (an IP)."""
    t = str(t or '').strip()
    if re.match(r'^usb(:|$)', t, re.I): return 'usb:' + t[4:] if len(t) > 3 else 'usb:'
    if re.match(r'^serial:', t, re.I): return 'serial:' + t[7:]
    if re.match(r'^COM\d+$', t, re.I): return 'serial:' + t.upper()
    if t.startswith('/dev/'): return 'serial:' + t
    return None


def model_name(mid):
    """ModelID -> NovaLCT's model name, from the app's own table (app/hwsend.js LCT_MODELS); '' when it isn't there."""
    if not _MODELS:
        try:
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'hwsend.js'), encoding='utf-8') as f: t = f.read()
            blk = t[t.find('LCT_MODELS'):]; blk = blk[:blk.find('};')]
            _MODELS.update((int(k, 16), v) for k, v in re.findall(r"0x([0-9A-Fa-f]{4}):\s*\['([^']+)'", blk))
        except (OSError, ValueError): pass
        _MODELS.setdefault(-1, '')
    return _MODELS.get(mid, '')


def lct_answer(name):
    """NovaLCT's discovery answer for a controller the relay stands in for: "rpProMI:" + text. LCT reads nothing after the
    marker but H_SUB_CARD ports (HW_PROTOCOL.md §4.1), so a name without them = one link on TCP 5200 (FakeProcessor answers
    "rpProMI:FakeProcessor" the same way). ASCII only; never "H_SUB_CARD"."""
    n = re.sub(r'[^\x20-\x7E]+', '', str(name or '')).replace('H_SUB_CARD', 'H-SUB-CARD').strip() or 'NovaStar controller'
    return b'rpProMI:' + n[:120].encode('ascii')


def lct_read(serial, dst, addr, length):
    """A NovaLCT read request (55 AA …, sum 0x5555 + bytes 2..): Open Nova's own ask for the ModelID."""
    h = bytes([0x55, 0xAA, 0, serial & 0xFF, 0xFE, dst, 0, 0]) + struct.pack('<HBBIH', 0, 0, 0, addr, length)
    return h + struct.pack('<H', (0x5555 + sum(h[2:])) & 0xFFFF)


class BridgeSide(TgSide):
    """NovaLCT's side of a bridged connection: TgSide's own splitting (frames cut anywhere across TCP reads, junk between
    them, checksums), each request recorded (before it leaves, as the TCP relay does) and passed over the link in NovaLCT's
    order. Bytes that aren't a request frame are recorded as junk and NOT sent: the link carries whole frames only (one
    USBC block per frame; the frame's own serial and sum are set by the link), so stray bytes have no safe way through."""
    def __init__(self, conn, relay, client):
        TgSide.__init__(self, conn, 'tx'); self.r, self.cl = relay, client

    def _frame(self, fr):
        if fr[0] != 0x55: return self._junk(fr, ': a reply-type frame (AA 55), not sent over %s' % self.r.via)
        TgSide._frame(self, fr)
        self.r._pass(fr, self.c, self.cl)

    def _junk(self, b, why=''):
        TgSide._junk(self, b, why or ': not a frame, not sent over %s (it carries whole frames only)' % self.r.via)


class BridgeRelay(Relay):
    """The NovaLCT relay with a USB / COM controller behind it (target "usb:" / "usb:0483:5720@<location>" / "serial:COMx").
    links: the link layer (novalink by default: open_link / close_links; tests pass a stand-in with the same interface)."""
    def __init__(self, target, relay_ip=None, ports=None, discovery=True, disc_port=None, reply_wait=None, links=None, name=None):
        t = bridge_target(target)
        if not t: raise ValueError('a USB / COM target is usb: or serial:COMx, not %r' % target)
        Relay.__init__(self, 'lct', t, relay_ip, ports, discovery, disc_port)
        self.via = 'USB' if t.startswith('usb:') else 'the COM port'
        self.links, self.wait, self.name = links, float(reply_wait or BRIDGE_WAIT), name
        self.key, self.keeper, self.model_id, self.model, self.answer = t, None, None, '', b''
        self.st.update(frames=0, timeouts=0, refused=0, held=False)
        self.sid = 0

    def _open(self, wait=None):
        return self.links.open_link(self.key, None, timeout=self.wait, wait=BUSY_FOR if wait is None else wait)

    def _start(self):
        if self.links is None: self.links = _links()
        t0 = time.time()
        try: self.keeper = self.links.open_link(self.target, None, timeout=self.wait, wait=5.0)   # held until stop: Open Nova owns the device
        except Exception as e:  # noqa: BLE001 - every reason the device can't be opened is said the same plain way
            what = 'the NovaStar USB device' if self.via == 'USB' else self.target[7:]
            self.tape.rec('conn', link=self.target, event='connect failed', error=str(e), ms=round((time.time() - t0) * 1000, 1))
            raise OSError('Couldn’t open %s (%s). If NovaLCT is running, close NovaLCT, start the relay, then open NovaLCT again.' % (what, e))
        self.key = getattr(self.keeper, 'tag', '') or self.target      # "usb:" -> the device found: usb:0483:5720@<location>
        if self.key.startswith('serial:'): self.key = self.target         # (a COM port keeps its speed: "serial:COM3@1048576")
        self.st['held'] = True
        self.tape.rec('conn', link=self.key, event='open', via='Open Nova holds it for the relay', ms=round((time.time() - t0) * 1000, 1))
        self._identify()
        Relay._start(self)

    def _identify(self):
        """Open Nova's own read of sender 0's ModelID (0x00000002, 2 B: LCT's first handshake read, as probe_usb), for the
        discovery answer's name. Recorded like the bridged frames, marked as Open Nova's own."""
        q = lct_read(0, 0, 0x00000002, 2); p = wirelog.decode(q)
        self.tape.rec('tg', link=self.key, dir='tx', hex=q.hex(), d=p[0], sum=wirelog.summary(*p), note='Open Nova’s own ask (the name for NovaLCT’s search)')
        t0 = time.time()
        try: r = self.keeper.raw(q, self.wait)
        except Exception as e:  # noqa: BLE001
            r = None; self._err('ModelID read: %s' % e)
        if r:
            p = wirelog.decode(r)
            self.tape.rec('tg', link=self.key, dir='rx', hex=bytes(r).hex(), d=p[0] if p else None, sum=wirelog.summary(*p) if p else '', rtt=round((time.time() - t0) * 1000, 2), note='Open Nova’s own ask')
            if len(r) >= 22 and r[2] == 0: self.model_id = r[18] | (r[19] << 8)
        if self.model_id in (None, 0, 0xFFFF):
            self.notes.append('The controller didn’t say its ModelID over %s: NovaLCT’s search gets a plain answer' % self.via)
            self.model_id = None
        self.model = model_name(self.model_id) if self.model_id is not None else ''
        nm = self.name or (self.model or ('ModelID 0x%04X' % self.model_id if self.model_id is not None else 'NovaStar controller'))
        self.answer = lct_answer('%s (%s via Open Nova relay)' % (nm, 'USB' if self.via == 'USB' else 'COM'))
        self.tape.rec('mark', source='vendor', text='Bridge: %s, ModelID %s%s; NovaLCT’s search will be answered with "%s" (made by the relay)'
                      % (self.key, '0x%04X' % self.model_id if self.model_id is not None else '?', ' (%s)' % self.model if self.model else '', self.answer.decode()))

    def _learn_ports(self):
        return list(DEF_PORTS['lct'])          # no network answer to read: one link, TCP 5200 (a non-H answer)

    def _forward_probe(self, d, a, out):
        """NovaLCT's search: answered by the relay itself (a USB / COM controller has no network answer to pass on)."""
        try: out.sendto(self.answer, a)
        except OSError as e: return self._err('discovery answer to %s:%d failed: %s' % (a[0], a[1], e))
        self.st['answers'] += 1
        self._udp_rec('rx', (self.relay_ip, self.disc_port), self.answer, note='answer #%d made by the relay (the controller is on %s: no network answer), sent to %s:%d from %s'
                      % (self.st['answers'], self.via, a[0], a[1], self.relay_ip), made='relay')

    def _pass(self, fr, cn, client):
        """One request over the link, in NovaLCT's order; its reply (with NovaLCT's serial again) to NovaLCT, recorded."""
        h, r, err = None, None, ''
        try:
            h = self._open()
            r = h.raw(fr, self.wait)
        except Exception as e:  # noqa: BLE001 - LinkBusy (an Open Nova Send / Save holds it), LinkLost (unplugged) …
            err = '%s: %s' % (type(e).__name__, e)
            if 'Busy' in type(e).__name__: self.st['refused'] += 1
        finally:
            try: h and h.close()
            except Exception: pass  # noqa: BLE001 - its refusal was raised by raw already
        p = wirelog.decode(fr); req = wirelog.summary(*p) if p else fr.hex()
        if err:
            with cn.lock: cn.pend.pop(fr[3], None)
            return self._err('%s: request not passed on / not answered (%s): %s' % (cn.link, req, err))
        if r is None:
            with cn.lock: cn.pend.pop(fr[3], None)
            self.st['timeouts'] += 1
            return self.tape.rec('err', link=cn.link, error='no reply over %s within %g s: NovaLCT gets none either (as on the wire)' % (self.via, self.wait), req=req)
        r = bytearray(r); r[3] = fr[3]; struct.pack_into('<H', r, len(r) - 2, (0x5555 + sum(r[2:-2])) & 0xFFFF)
        r = bytes(r)
        try: client.sendall(r)
        except OSError as e:
            return self._err('%s: the reply couldn’t go back to NovaLCT: %s' % (cn.link, e))
        self.st['frames'] += 1; self.st['down'] += len(r)
        try: cn.sides['rx'].feed(r)                    # recorded after it went back, with the round-trip time
        except Exception as e:  # noqa: BLE001
            self.tape.rec('err', link=cn.link, error='recorder: %s: %s' % (type(e).__name__, e))

    def _client(self, c, peer, port, proto):
        link = self.key; via = 'relay %s:%d <- %s:%d, over %s' % (self.relay_ip, port, peer[0], peer[1], self.via)
        c.settimeout(None)
        try: c.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError: pass
        pair = (c,); self.conns.append(pair); self.st['clients'] += 1; self.st['opened'] += 1
        self.tape.rec('conn', link=link, event='open', via=via)
        wirelog.mark('Vendor relay: %s connected through the relay (%s over %s)' % (peer[0], link, self.via), source='vendor')
        cn = Conn(self.tape, link, 'tg'); side = BridgeSide(cn, self, c)
        try:
            while not self.stop_ev.is_set():
                try: d = c.recv(65536)
                except OSError: break
                if not d: break
                self.st['up'] += len(d)
                try: side.feed(d)                        # each whole request goes over the link and is answered in order
                except Exception as e:  # noqa: BLE001
                    self.tape.rec('err', link=link, error='bridge: %s: %s' % (type(e).__name__, e))
        finally:
            for sd in (side, cn.sides['rx']):
                try: sd.close()
                except Exception as e:  # noqa: BLE001
                    self.tape.rec('err', link=link, error='recorder: %s: %s' % (type(e).__name__, e))
            try: c.close()
            except OSError: pass
            self.st['clients'] -= 1
            if pair in self.conns: self.conns.remove(pair)
            self.tape.rec('conn', link=link, event='close', via=via)

    def stop(self):
        if self.stop_ev.is_set(): return
        Relay.stop(self)
        k, self.keeper = self.keeper, None
        if k is not None:
            try: k.close()
            except Exception: pass  # noqa: BLE001
            try: getattr(self.links, 'close_links', lambda *a, **kw: [])(0, self.key, 'the vendor relay stopped')   # free for NovaLCT now (unless Open Nova uses it)
            except Exception: pass  # noqa: BLE001
        self.st['held'] = False

    def status(self):
        s = Relay.status(self)
        s.update(bridge=self.via, device=self.key, modelId=self.model_id, model=self.model, answer=self.answer.decode('ascii', 'replace'))
        return s


BUSY_FOR = 3.0             # s a bridged request waits while an Open Nova Send / Save holds the device, then it isn't passed on


def bridge_targets():
    """What the relay can bridge to here, listed only (nothing opened): NovaStar USB devices (libusb descriptors) and COM ports."""
    nl = _links()
    try: ports = nl.serial_ports()
    except Exception as e:  # noqa: BLE001
        ports = []; perr = str(e)
    else: perr = ''
    try: usb, uerr = nl.usb_devices()
    except Exception as e:  # noqa: BLE001
        usb, uerr = [], str(e)
    return {'ok': True, 'usb': [{'host': d['host'], 'label': d.get('label') or d['host']} for d in usb], 'usbError': uerr,
            'ports': [{'host': 'serial:%s' % p['name'], 'label': p.get('label') or p['name'], 'driver': p.get('driver', '')} for p in ports], 'error': perr}


RELAYS = {}


def relay_start(body):
    kind = str(body.get('kind') or '')
    with _lock:
        if kind in RELAYS and RELAYS[kind].stop_ev.is_set() is False: return {'ok': False, 'error': 'a %s relay is already running' % FAMILY_NAMES.get(kind, kind), 'relays': relay_status()['relays']}
    ports = [int(p) for p in re.findall(r'\d+', str(body.get('ports') or ''))] if body.get('ports') else None
    bt = bridge_target(body.get('target'))
    if bt and kind != 'lct': return {'ok': False, 'error': 'USB / COM controllers are bridged for NovaLCT only'}
    try:
        if bt: r = BridgeRelay(bt, body.get('relayIp') or None, ports, body.get('discovery', True), body.get('discPort'), body.get('replyWait')).start()
        else: r = Relay(kind, body.get('target'), body.get('relayIp') or None, ports, body.get('discovery', True), body.get('discPort'),
                        body.get('targetDiscPort'), announce_to=None, coex_mac=body.get('mac')).start()
    except (ValueError, OSError) as e:
        return {'ok': False, 'error': str(e)}
    with _lock: RELAYS[kind] = r
    return {'ok': True, 'relay': r.status(), 'relays': relay_status()['relays']}


def relay_stop(kind=None):
    with _lock: ks = [kind] if kind else list(RELAYS)
    out = []
    for k in ks:
        r = RELAYS.pop(k, None)
        if r: r.stop(); out.append(r.status())
    return {'ok': True, 'stopped': out, 'relays': relay_status()['relays']}


def relayed(ip):
    """True when ip is a running relay's own address: Open Nova's own searches must not take the relay for a processor
    (it answers searches from this computer the way the vendor app needs)."""
    with _lock: return any(r.relay_ip == ip for r in RELAYS.values())


def relay_status():
    with _lock: return {'ok': True, 'relays': [r.status() for r in RELAYS.values()], 'defaultIp': RELAY_IP}


# ------------------------------------------------------------------ the problem report (tools/alpha.py)
def report_md(det=None):
    """REPORT.md's section: the vendor apps here, capture tools, what was captured / relayed this session."""
    try: det = det or detect()
    except Exception as e:  # noqa: BLE001 - the report must still be made
        return ['## NovaStar apps on this computer', '', 'Not checked: %s' % e, '']
    L = ['## NovaStar apps on this computer', '']
    if det['apps']:
        L += ['| App | Version | Running | Talks to | Listens on |', '|---|---|---|---|---|']
        for a in det['apps']:
            L.append('| %s | %s | %s | %s | %s |' % (a['name'], a['version'] or '—', ('yes (PID %s)' % ', '.join(map(str, a['running']))) if a['running'] else
                                                    ('service, %s' % a['service']) if a['service'] else 'no', ', '.join(a['talksTo']) or '—', ', '.join(a['listens']) or '—'))
    else: L.append('None found.' + (' ' + det['note'] if det.get('note') else ''))
    c = det['capture']
    L += ['', 'Capture tools: ' + ', '.join('%s %s' % (k, 'yes' if c.get(k) else 'no') for k in ('wireshark', 'dumpcap', 'tcpdump')) +
          ('; Npcap %s' % ('installed' + (' (admin only)' if (c['npcap'] or {}).get('adminOnly') else '') if (c['npcap'] or {}).get('installed') else 'not installed') if c.get('npcap') is not None else ''), '']
    try:
        import netcap
        L += netcap.report_md()
    except Exception:  # noqa: BLE001 - the report must still be made
        pass
    try:
        import usbcap
        L += usbcap.report_md()
        if 'usbauto' in sys.modules:                       # the USB coordinator: where it is and how it got there
            a = sys.modules['usbauto'].get().status()
            L += ['USB coordinator: %s%s%s; recent: %s' % (a['state'], '/' + a['sub'] if a['sub'] else '', ' — ' + a['say'] if a['say'] else '',
                                                          ', '.join('%s%s' % (h['state'], '/' + h['sub'] if h['sub'] else '') for h in a['history']) or '—'), '']
    except Exception:  # noqa: BLE001 - the report must still be made
        pass
    vf = vendor_files(days=1)
    if vf:
        L += ['Captured / relayed (session/<day>/vendor/):', ''] + ['- `%s` (%d KB)' % (f['name'], f['size'] >> 10) for f in vf[:40]] + ['']
    for r in relay_status()['relays']:
        L.append('Relay %s running: %s -> %s, ports %s, %d connections.' % (r['name'], r['relayIp'], r['target'], r['ports'], r['opened']))
    return L


def report_files(include_logs=False, days=LOG_DAYS):
    """[(name, text)] for the report: vendor/apps.json always, the vendor apps' logs when the tester ticked them."""
    out = [('vendor/apps.json', json.dumps(detect(), indent=1, default=str))]
    try:
        import usbcap
        out.append(('vendor/usbcap.json', json.dumps(usbcap.detect(), indent=1, default=str)))
    except Exception as e:  # noqa: BLE001
        out.append(('vendor/usbcap.json', json.dumps({'error': str(e)})))
    if include_logs:
        try: out += report_logs(days)
        except Exception as e:  # noqa: BLE001
            out.append(('vendor/logs/ERROR.txt', 'The NovaStar apps’ logs couldn’t be collected: %s' % e))
    return out


# ------------------------------------------------------------------ the helper's routes (/api/hw/vendor/*)
def handle(path, body):
    p = str(path).split('?')[0][len('/api/hw/vendor/'):]
    if p.startswith('usb-auto'):                               # the USB coordinator: tools/usbauto.py
        import usbauto
        return usbauto.handle(p, body)
    if p.startswith('usb-'):                                   # USB capture (USBPcap): tools/usbcap.py
        import usbcap
        return usbcap.handle(p, body)
    if p.startswith('net-'):                                   # network recording, passive (pktmon / tcpdump): tools/netcap.py
        import netcap
        return netcap.handle(p, body)
    if p == 'detect': return detect(bool(body.get('refresh')))
    if p == 'logs': return {'ok': True, 'places': log_places(int(body.get('days') or LOG_DAYS)), 'days': int(body.get('days') or LOG_DAYS)}
    if p == 'interfaces': return interfaces()
    if p == 'capture-start': return capture_start(body.get('iface'), body.get('filter'), body.get('minutes') or 30)
    if p == 'capture-stop': return capture_stop()
    if p == 'capture-status': return {'ok': True, 'capture': capture_status()}
    if p == 'import':
        try:
            data = base64.b64decode(body.get('data') or '')
            import usbcap
            if usbcap.is_usbpcap(data): return usbcap.import_pcap(body.get('name') or 'usb capture', data, body.get('keepOriginal', True) is not False)
            return import_capture(body.get('name') or 'capture', data, body.get('keepOriginal', True) is not False)
        except ValueError as e: return {'ok': False, 'error': 'not a Wireshark / tcpdump capture (%s)' % e}
    if p == 'files': return {'ok': True, 'files': vendor_files(int(body.get('days') or 3))}
    if p in ('relay-start', 'relay-stop') and (body.get('kind') or 'lct') == 'lct' and 'usbauto' in sys.modules:
        sys.modules['usbauto'].get().hand()                    # the tester's own relay: the USB coordinator steps aside a while
    if p == 'relay-start': return relay_start(body)
    if p == 'relay-stop': return relay_stop(body.get('kind'))
    if p == 'relay-status': return relay_status()
    if p == 'relay-targets': return bridge_targets()
    if p == 'open-folder':
        d = vendor_dir()
        subprocess.Popen(['explorer', d] if IS_WIN else ['open' if IS_MAC else 'xdg-open', d])
        return {'ok': True, 'dir': d}
    return {'ok': False, 'error': 'not found'}
